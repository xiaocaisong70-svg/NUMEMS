import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import * as e from '../lib/seat-engine.ts';
import * as b from '../lib/codex-bridge.ts';
import * as r from '../lib/recovery-control.ts';
import * as history from '../lib/history-store.ts';
import * as hp from '../lib/history-policy.ts';
import * as rollback from '../lib/history-rollback.ts';
import * as reminder from '../lib/reminder-policy.ts';
import * as access from '../lib/portal-access.ts';
import * as rate from '../lib/request-rate-policy.ts';
import * as idle from '../lib/official-idle-state.ts';
const epoch=Date.parse('2026-10-28T10:00:00.000Z'),at=n=>new Date(epoch+n*1000).toISOString();
const owner={userId:'owner',email:e.PROTECTED_OWNER_EMAIL,isAdmin:true};
const staff=n=>({userId:'person'+n,email:`person${n}@example.test`,isAdmin:false});
const pageUrl=`https://admin.openai.com/workspace/${b.TARGET_WORKSPACE_ID}/members`;
const snap=(n,members=[staff(0).email],invites=[])=>({workspaceId:b.TARGET_WORKSPACE_ID,accountEmail:owner.email,pageUrl,observedAt:at(n),complete:true,totalSeats:4,
  members:[{email:owner.email,role:'owner'},...members.map(email=>({email,role:'member'}))],invites:invites.map(email=>({email,role:'member'}))});
function fixture() {
  let s=b.observeWorkspace(e.createState(at(0)),snap(0,[]),at(0));
  s=e.transition(s,owner,{type:'configure',config:{automationEnabled:true,whitelist:[0,1,2,3,4].map(n=>staff(n).email)}},at(0));
  s.codex.enabled=true;s.codex.testOnly=false;s.codex.mailEnabled=false;
  s=e.transition(s,staff(0),{type:'apply',name:'Member',reason:'offline',hours:1},at(0));s=e.transition(s,owner,{type:'tick'},at(0));
  s=e.transition(s,owner,{type:'confirm_invited',id:s.requests[0].id,sentAt:at(0)},at(0));s=e.transition(s,owner,{type:'confirm_active',id:s.requests[0].id},at(0));
  s=e.transition(s,owner,{type:'tick'},at(3601));
  for(const n of [1,2,3]){s=e.transition(s,staff(n),{type:'apply',name:'Applicant',reason:'offline',hours:1},at(3601+n));s=e.transition(s,owner,{type:'tick'},at(3601+n));}
  s=b.observeWorkspace(s,snap(3605),at(3605));
  return b.deferOperation(s,{kind:'remove',targetId:s.requests[0].id,failureCode:'browser_unavailable'},at(3606));
}
const failure=s=>r.latestRecoveryFailureId(s);
const credential=n=>({id:`rescue_independent_execution_id_${n}`,token:`private-execution-secret-${n}`});
const begin=(s,n=3607,id=1)=>r.beginFaultRescue(s,{expectedFailureId:failure(s),scope:'approved_member_ops',clientId:'client_'+id},credential(id),at(n));
const auth=s=>({rescueId:s.codex.faultRescue.id,token:s.codex.faultRescue.token,expectedFailureId:s.codex.faultRescue.failureId});
const target=(s,kind)=>s.codex.faultRescue.targets.find(t=>t.kind===kind);
function claim(s,kind='remove',n=3608) {const t=target(s,kind);return b.claimRescueOperation(s,{...auth(s),kind,targetId:t.targetId},'operation_'+n,at(n));}
function authorize(s,n=3610,members=[staff(0).email],invites=[]) {
  s=b.observeWorkspace(s,snap(n-1,members,invites),at(n-1));
  return b.authorizeRescueAction(s,{...auth(s),operationId:s.codex.lease.id,operationToken:s.codex.lease.token},at(n));
}
const finish=(s,outcome='handled',n=3613)=>r.finishFaultRescue(s,{...auth(s),outcome,agentStopped:true},at(n));

test('execution ticket freezes three server-selected targets, prioritizes removal, and preserves the global browser pause',()=>{
  const s=begin(fixture()),t=s.codex.faultRescue;
  assert.equal(t.scope,'approved_member_ops');assert.equal(t.targets.length,3);assert.equal(t.targets[0].kind,'remove');
  assert.equal(Date.parse(t.expiresAt)-Date.parse(t.createdAt),300000);assert.equal(s.codex.globalFailureCode,'browser_unavailable');
  assert.throws(()=>b.claimOperation(s,'remove',t.targets[0].targetId,'ordinary',at(3608)),/故障诊断/);
  assert.equal(r.executionRescueAvailability(s,at(3608)).canBegin,false);
  assert.deepEqual(begin(s,3608),s);
  assert.throws(()=>r.beginFaultRescue(s,{expectedFailureId:failure(s),scope:'approved_member_ops',clientId:'other'},credential(9),at(3608)),/已有/);
});
test('claim and authorization enforce exact credential, immutable targets, fresh postclaim inventory and one external write grant',()=>{
  const initial=begin(fixture());
  assert.throws(()=>b.claimRescueOperation(initial,{...auth(initial),kind:'remove',targetId:'other'},'new',at(3608)),/冻结/);
  assert.throws(()=>b.claimRescueOperation(initial,{...auth(initial),kind:'mail',targetId:target(initial,'remove').targetId},'new',at(3608)),/成员目标/);
  assert.throws(()=>b.claimRescueOperation(initial,{...auth(initial),kind:'remove',targetId:target(initial,'remove').targetId,clear:true},'new',at(3608)),/参数/);
  const claimed=claim(initial),args={...auth(claimed),operationId:claimed.codex.lease.id,operationToken:claimed.codex.lease.token};
  assert.throws(()=>b.authorizeRescueAction(claimed,args,at(3610)),/领取后/);
  const allowed=authorize(claimed);assert.ok(allowed.codex.lease.actionAuthorizedAt);
  assert.throws(()=>b.authorizeRescueAction(allowed,args,at(3611)),/重复授权/);
  assert.throws(()=>b.authorizeRescueAction(allowed,{...args,token:'wrong'},at(3611)),/凭证/);
  assert.equal(allowed.codex.rescueExecutionIncident.claimedTargets.length,1);
});
test('verified removal closes only the original lease and handled does not pretend the dedicated browser recovered',()=>{
  let s=authorize(claim(begin(fixture()))),op=structuredClone(s.codex.lease);
  s=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',observation:snap(3611,[])},at(3611));
  assert.equal(s.codex.lease,undefined);assert.equal(s.codex.globalFailureCode,'browser_unavailable');
  assert.equal(r.rescueSettlement(s,s.codex.faultRescue).canHandle,true);
  const done=finish(s);assert.equal(done.codex.faultRescue.outcome,'handled');assert.equal(done.codex.globalFailureCode,'browser_unavailable');
  assert.throws(()=>finish(begin(fixture())),/终态/);
});
test('verified invitation needs exact actual submission time; accepted invitations remain protected on completion',()=>{
  let s=begin(fixture());s=claim(s,'invite');const email=s.codex.lease.email;
  s=authorize(s);const op=s.codex.lease;
  assert.throws(()=>b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',observation:snap(3612,[staff(0).email],[email])},at(3612)),/实际提交时间/);
  const done=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',invitationSentAt:at(3610),observation:snap(3612,[staff(0).email],[email])},at(3612));
  assert.equal(done.requests.find(r=>r.email===email).invitedAt,at(3610));assert.equal(done.codex.globalFailureCode,'browser_unavailable');
  assert.throws(()=>b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',invitationSentAt:at(3600),observation:snap(3612,[staff(0).email],[email])},at(3612)),/发出时间/);
  assert.throws(()=>b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',invitationSentAt:at(3609),observation:snap(3612,[staff(0).email],[email])},at(3612)),/早于本次写入授权/);
  const late=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',invitationSentAt:at(3610),observation:snap(4000,[staff(0).email],[email])},at(4000));
  assert.equal(late.codex.lease,undefined);assert.equal(late.requests.find(r=>r.email===email).invitedAt,at(3610));
  assert.ok(late.codex.receipts.some(receipt=>receipt.id===op.id&&receipt.kind==='invite'));
});
test('ordinary invitation completion keeps its existing timing contract without a rescue write authorization',()=>{
  let s=fixture();delete s.codex.lastError;delete s.codex.globalFailureCode;
  const request=s.requests.find(request=>request.status==='pending_invite');
  s=b.claimOperation(s,'invite',request.id,'ordinary_invitation',at(3608));const op=s.codex.lease;
  assert.equal(op.rescueId,undefined);assert.equal(op.actionAuthorizedAt,undefined);
  const done=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',invitationSentAt:at(3609),observation:snap(3612,[staff(0).email],[op.email])},at(3612));
  assert.equal(done.codex.lease,undefined);assert.equal(done.requests.find(request=>request.id===op.requestId).invitedAt,at(3609));
});
test('deadline prevents new claim and write authorization but never discards or expires a claimed result',()=>{
  const initial=begin(fixture());assert.throws(()=>claim(initial,'remove',3907),/超时/);
  const refreshed=b.observeWorkspace(initial,snap(3899),at(3899)),claimed=claim(refreshed,'remove',3900);assert.throws(()=>authorize(claimed,3908),/超时/);
  assert.ok(claimed.codex.lease);assert.throws(()=>finish(claimed,'handled',3910),/原租约/);
  let allowed=authorize(claim(initial),3610),op=allowed.codex.lease;
  allowed=b.completeOperation(allowed,{operationId:op.id,token:op.token,outcome:'verified',observation:snap(4000,[])},at(4000));
  assert.equal(allowed.codex.lease,undefined);assert.equal(allowed.codex.globalFailureCode,'browser_unavailable');
  assert.equal(r.publicRecoveryProgress(initial,at(3907)).phase,'fallback_timeout');
});
test('changed portal authorization cannot be used for a stale action; not_started safely settles only an unauthorised rescue lease',()=>{
  let s=claim(begin(fixture()),'invite'),op=s.codex.lease;
  s=e.transition(s,owner,{type:'configure',config:{whitelist:[staff(0).email]}},at(3609));
  s=b.observeWorkspace(s,snap(3610),at(3610));
  assert.throws(()=>b.authorizeRescueAction(s,{...auth(s),operationId:op.id,operationToken:op.token},at(3611)),/申请、续期或授权/);
  const done=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'not_started',observation:snap(3611)},at(3611));
  assert.equal(done.codex.lease,undefined);assert.equal(done.codex.globalFailureCode,'browser_unavailable');
  assert.deepEqual(b.completeOperation(done,{operationId:op.id,token:op.token,outcome:'not_started',observation:snap(3612)},at(3612)),done);
  const written=authorize(claim(begin(fixture())));
  assert.throws(()=>b.completeOperation(written,{operationId:written.codex.lease.id,token:written.codex.lease.token,outcome:'not_started',observation:snap(3612)},at(3612)),/从未获得/);
});
test('unknown action retains the lease and fence, while a confirmed member/approval failure isolates only that target',()=>{
  const granted=authorize(claim(begin(fixture()))),op=granted.codex.lease;
  const unknown=b.completeOperation(granted,{operationId:op.id,token:op.token,outcome:'uncertain',failureCode:'unknown'},at(3611));
  assert.equal(unknown.codex.lease.id,op.id);assert.equal(unknown.codex.lease.status,'uncertain');assert.equal(unknown.codex.faultRescue.phase,'uncertain');
  assert.equal(unknown.codex.globalFailureCode,'browser_unavailable');assert.throws(()=>claim(unknown,'invite',3612),/执行权/);
  const resolved=b.completeOperation(unknown,{operationId:op.id,token:op.token,outcome:'verified',observation:snap(3612,[])},at(3612));
  assert.equal(finish(resolved).codex.faultRescue.outcome,'handled');
  for(const code of ['member_action','approval_required']) {
    const isolated=b.completeOperation(granted,{operationId:op.id,token:op.token,outcome:'blocked',failureCode:code},at(3611));
    assert.equal(isolated.codex.lease,undefined);assert.equal(isolated.codex.holds[0].operation.rescueId,isolated.codex.faultRescue.id);
    assert.equal(claim(isolated,'invite',3612).codex.lease.kind,'invite');
  }
});
test('a prior handled ticket can pass only its verified known target holds to the next bounded ticket',()=>{
  let s=authorize(claim(begin(fixture()))),op=s.codex.lease;
  s=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'blocked',failureCode:'member_action'},at(3611));
  s=finish(s);assert.equal(r.executionRescueAvailability(s,at(3614)).canBegin,true);
  const second=begin(s,3614,2);assert.deepEqual(second.codex.faultRescue.inheritedHoldIds,[op.id]);
  assert.ok(second.codex.faultRescue.targets.every(t=>t.email!==op.email));
  assert.equal(claim(second,'invite',3615).codex.lease.kind,'invite');
  for(const mutate of [x=>{x.codex.holds[0].code='unknown';},x=>{x.codex.holds[0].operation.rescueId='forged';},
    x=>{x.codex.holds[0].operation.id='forged';},x=>{x.codex.browserUnavailableAt=at(3614);},x=>{x.codex.faultRescue.scope='read_only_reconcile';}]) {
    const forged=structuredClone(s);mutate(forged);assert.equal(r.executionRescueAvailability(forged,at(3614)).canBegin,false);
    assert.throws(()=>begin(forged,3614,2));
  }
});
test('incident quota and claimed target ledger survive ticket renewal, request retries and 24-hour pruning',()=>{
  let s=claim(begin(fixture())),op=s.codex.lease;
  s=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'not_started',observation:snap(3610)},at(3610));
  s=finish(s,'unresolved');const first=s.codex.faultRescue;
  s=begin(s,3614,2);assert.ok(s.codex.faultRescue.targets.every(t=>t.targetId!==op.targetId));
  s=finish(s,'unresolved',3615);assert.equal(r.executionRescueAvailability(s,at(3616)).reason,'incident_quota');
  assert.throws(()=>begin(s,3616,3),/incident_quota/);
  assert.throws(()=>r.beginFaultRescue(s,{expectedFailureId:failure(s),scope:'approved_member_ops',clientId:first.clientId},credential(4),at(3616)),/幂等/);
  assert.equal(r.publicRecoveryProgress(s,at(3616)).phase,'fallback_exhausted');
  const day=fixture();day.codex.rescueExecutionHistory=Array.from({length:6},(_,i)=>({id:'old'+i,clientId:'old-client'+i,createdAt:at(3000+i)}));
  assert.equal(r.executionRescueAvailability(day,at(3607)).reason,'daily_quota');
  assert.equal(r.publicRecoveryProgress(day,at(3607)).phase,'fallback_exhausted');
  assert.throws(()=>begin(day),/daily_quota/);
});
test('authorization rejects renewed/status-changed/foreign-role evidence, and old grants cannot authorize a different lease',()=>{
  const base=claim(begin(fixture())),args={...auth(base),operationId:base.codex.lease.id,operationToken:base.codex.lease.token};
  for(const mutate of [s=>{s.requests.find(r=>r.id===s.codex.lease.requestId).updatedAt=at(3609);},
    s=>{s.requests.find(r=>r.id===s.codex.lease.requestId).status='active';},
    s=>{s.codex.faultRescue.targets[0].operationId='other';},
    s=>{s.codex.observation.members[1].role='admin';},s=>{s.codex.observation.totalSeats=5;}]) {
    const s=structuredClone(base);s.codex.observation=snap(3609);mutate(s);
    assert.throws(()=>b.authorizeRescueAction(s,args,at(3610)));assert.equal(s.codex.lease.actionAuthorizedAt,undefined);
  }
});
test('a natural join after claim is synchronized by not_started without manufacturing write permission',()=>{
  let s=claim(begin(fixture()),'invite'),op=s.codex.lease;
  s=b.observeWorkspace(s,snap(3610,[staff(0).email,op.email]),at(3610));
  assert.throws(()=>b.authorizeRescueAction(s,{...auth(s),operationId:op.id,operationToken:op.token},at(3611)),/已存在/);
  s=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'not_started',observation:snap(3612,[staff(0).email,op.email])},at(3612));
  assert.equal(s.requests.find(r=>r.id===op.requestId).status,'active');assert.equal(s.codex.lease,undefined);
  assert.equal(r.rescueSettlement(s,s.codex.faultRescue).verifiedCount,0);assert.throws(()=>finish(s),/终态/);
});
test('wrong-kind or ambiguous settlement records cannot turn a model declaration into handled',()=>{
  const s=claim(begin(fixture())),op=s.codex.lease;delete s.codex.lease;
  s.codex.receipts.push({id:op.id,kind:'invite',email:op.email,at:at(3610),evidence:pageUrl});
  assert.equal(r.rescueSettlement(s,s.codex.faultRescue).canHandle,false);assert.throws(()=>finish(s),/终态/);
  s.codex.receipts[0]={...s.codex.receipts[0],id:'unrelated'};
  assert.equal(r.rescueSettlement(s,s.codex.faultRescue).canHandle,false);
});
test('read-only ticket upgrade preserves old protocol, rejects unsafe scope, and never leaks target emails or credentials to employee payloads',()=>{
  let s=fixture();s=r.beginFaultRescue(s,{expectedFailureId:failure(s)},credential('read'),at(3607));
  s=finish(s,'unresolved',3608);s=begin(s,3609);
  const publicTicket=r.publicFaultRescue(s);assert.equal(publicTicket.targets,undefined);
  assert.equal(JSON.stringify(publicTicket).includes(staff(0).email),false);assert.equal(JSON.stringify(publicTicket).includes(s.codex.faultRescue.token),false);
  assert.equal(b.workPlan(s,at(3610)).faultRescue.targets.length,3);
  for(const code of ['unknown','capacity_mismatch','role_mismatch','login_expired']){const bad=fixture();bad.codex.globalFailureCode=code;assert.throws(()=>begin(bad));}
  assert.throws(()=>r.recordRecoveryProgress(fixture(),{expectedFailureId:failure(fixture()),phase:'fallback_exhausted'},at(3607)),/未耗尽/);
});
test('active execution target and its action provenance are pinned during compaction',()=>{
  const s=begin(fixture()),id=s.codex.faultRescue.targets[0].targetId;
  s.requests.find(x=>x.id===id).status='completed';const base=s.requests.find(x=>x.id===id);
  s.requests.push(...Array.from({length:170},(_,i)=>({...base,id:'closed_'+i,updatedAt:at(4000+i)})));
  s.audit.push(...Array.from({length:650},(_,i)=>({id:'noise_'+i,at:at(4000+i),actor:owner.email,action:'noise'})));
  const compacted=hp.compactHistory(s,s).state;assert.ok(compacted.requests.some(x=>x.id===id));assert.ok(compacted.audit.some(x=>x.id===s.codex.faultRescue.failureId));
});

function database(initial) {const db=new DatabaseSync(':memory:');
  for(const file of ['0000_bored_stick.sql','0001_chilly_squirrel_girl.sql'])db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
  db.prepare('INSERT INTO portal_state VALUES(?,?,?)').run('main',0,JSON.stringify(initial));
  const api={prepare(sql){let params=[];return{bind(...v){params=v;return this;},async first(){return db.prepare(sql).get(...params)??null;},async all(){return{results:db.prepare(sql).all(...params)};},async run(){const value=db.prepare(sql).run(...params);return{meta:{changes:Number(value.changes)}};}};},async batch(ops){db.exec('BEGIN');try{const out=[];for(const op of ops)out.push(await op.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
  return{db,api,read:()=>db.prepare('SELECT * FROM portal_state WHERE id=?').get('main')};}
test('real SQLite CAS permits only one fallback claim and never spends a second quota on stale state',async()=>{
  const initial=begin(fixture()),db=database(initial);
  try{const left=claim(initial),right=claim(initial,'remove',3609);
    assert.equal((await history.persistHistoryCas(db.api,initial,left,0)).committed,true);
    assert.equal((await history.persistHistoryCas(db.api,initial,right,0)).committed,false);
    const latest=JSON.parse(db.read().document);assert.throws(()=>claim(latest),/额度|未结束/);assert.equal(latest.codex.rescueExecutionIncident.claimedTargets.length,1);
  }finally{db.db.close();}
});

async function server(initial) {
  let ms=Date.parse(at(3607)),actor=owner;const db=database(initial);
  class Clock extends Date{constructor(...args){super(...(args.length?args:[ms]));}static now(){return ms;}}
  const context=vm.createContext({Request,Response,TextEncoder,URL,crypto:webcrypto,console,Date:Clock,structuredClone,Error});
  const deps={'cloudflare:workers':{env:{DB:db.api,REMINDER_DELIVERY_MODE:'in_app'}},'@/app/chatgpt-auth':{getChatGPTUser:async()=>actor},
    './seat-engine':e,'./portal-access':access,'./reminder-policy':reminder,'./history-store':history,'./request-rate-policy':rate,'./recovery-control':r,
    '@/lib/seat-engine':e,'@/lib/codex-bridge':b,'@/lib/reminder-policy':reminder,'@/lib/recovery-control':r,'@/lib/history-rollback':rollback,
    '@/lib/official-idle-state':idle,'@/lib/jobs':{runJobs:async()=>({}),refreshSeatQueue:async()=>({})}};
  const synthetic=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});
  const compile=p=>ts.transpileModule(readFileSync(new URL(p,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const service=new vm.SourceTextModule(compile('../lib/portal-service.ts'),{context});await service.link(s=>synthetic(deps[s]));await service.evaluate();
  const route=new vm.SourceTextModule(compile('../app/mcp/route.ts'),{context});await route.link(s=>s==='@/lib/portal-service'?service:synthetic(deps[s]));await route.evaluate();
  return{db,service:service.namespace,actor(v){actor=v;},async call(name,args={},origin='https://portal.example.test'){
    const response=await route.namespace.POST(new Request('https://portal.example.test/api/codex',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
    if(response.status!==200)return{status:response.status};const payload=await response.json();return payload.result?.isError?{error:payload.result.content[0].text}:JSON.parse(payload.result.content[0].text);}};
}
test('actual administrator RPC routes enforce origin, authority, injections, idempotency and safe public views',async()=>{
  const initial=fixture(),f=await server(initial),args={expectedFailureId:failure(initial),scope:'approved_member_ops',clientId:'route-test'};
  try{f.actor(staff(1));assert.match((await f.call('begin_fault_rescue',args)).error,/管理员/);f.actor(owner);
    assert.equal((await f.call('begin_fault_rescue',args,'https://evil.test')).status,403);
    const first=await f.call('begin_fault_rescue',args),again=await f.call('begin_fault_rescue',args);assert.deepEqual(first.ticket,again.ticket);
    assert.equal(f.db.read().revision,1);assert.equal(first.ticket.targets.length,3);
    const page=await f.service.portalData();assert.equal(page.connection.faultRescue.targets,undefined);assert.equal(JSON.stringify(page).includes(first.ticket.token),false);
    const target=first.ticket.targets[0],creds={rescueId:first.ticket.id,token:first.ticket.token,expectedFailureId:first.ticket.failureId};
    assert.match((await f.call('claim_rescue_operation',{...creds,kind:target.kind,targetId:target.targetId,clear:true})).error,/参数/);
    const claimed=await f.call('claim_rescue_operation',{...creds,kind:target.kind,targetId:target.targetId});assert.ok(claimed.plan.lease.rescueId);
  }finally{f.db.db.close();}
});
test('V13 rollback normalization is stopped-only and revision-CAS protected, retaining execution budgets',async()=>{
  let s=authorize(claim(begin(fixture()))),op=s.codex.lease;
  s=b.completeOperation(s,{operationId:op.id,token:op.token,outcome:'verified',observation:snap(3612,[])},at(3612));s=finish(s);
  assert.throws(()=>r.prepareV13RollbackState(s,at(3614)),/关闭/);
  s.codex.enabled=false;s.config.automationEnabled=false;const ledger=structuredClone(s.codex.rescueExecutionIncident),f=await server(s);
  try{assert.match((await f.call('prepare_v13_rollback',{expectedRevision:99})).error,/修订/);
    const result=await f.call('prepare_v13_rollback',{expectedRevision:0});assert.equal(result.prepared,true);assert.equal(result.ticket.outcome,'unresolved');
    assert.deepEqual(JSON.parse(f.db.read().document).codex.rescueExecutionIncident,ledger);
    assert.match((await f.call('prepare_v13_rollback',{expectedRevision:0})).error,/修订/);
  }finally{f.db.db.close();}
});
