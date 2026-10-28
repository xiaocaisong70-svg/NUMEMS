// Offline production rules and SQLite-backed CAS. No browser/account/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as engine from '../lib/seat-engine.ts';
import * as bridge from '../lib/codex-bridge.ts';
import * as recovery from '../lib/recovery-control.ts';
import * as history from '../lib/history-store.ts';
import * as historyPolicy from '../lib/history-policy.ts';
import * as historyRollback from '../lib/history-rollback.ts';
import * as reminder from '../lib/reminder-policy.ts';
import * as access from '../lib/portal-access.ts';
import * as rate from '../lib/request-rate-policy.ts';
import * as officialIdle from '../lib/official-idle-state.ts';

const base='2026-10-28T10:00:00.000Z',stamp=n=>new Date(Date.parse(base)+n*1000).toISOString();
const owner={userId:'owner',email:engine.PROTECTED_OWNER_EMAIL,isAdmin:true};
const person={userId:'person',email:'person@example.com',isAdmin:false};
const pageUrl=`https://admin.openai.com/workspace/${bridge.TARGET_WORKSPACE_ID}/members`;
const credential={id:'rescue_independent_public_identifier',token:'private_secret_not_in_public_id'};
function snapshot(n=0,extra={}) {return {workspaceId:bridge.TARGET_WORKSPACE_ID,accountEmail:owner.email,
  complete:true,totalSeats:4,observedAt:stamp(n),pageUrl,members:[{email:owner.email,role:'owner'}],invites:[],...extra};}
function diagnostic(state='challenge',n=1,extra={}) {return {version:1,stage:'page',state,expectedUrl:pageUrl,observedAt:stamp(n),...extra};}
function fixture(code='browser_unavailable') {
  let s=bridge.observeWorkspace(engine.createState(base),snapshot(),base);
  s=engine.transition(s,owner,{type:'configure',config:{automationEnabled:true,whitelist:[person.email]}},base);
  s.codex.enabled=true;s.codex.testOnly=false;s.codex.mailEnabled=false;
  s=engine.transition(s,person,{type:'apply',name:'Person',reason:'offline test',hours:1},base);
  s=engine.transition(s,owner,{type:'tick'},base);
  s=bridge.deferOperation(s,{kind:'invite',targetId:s.requests[0].id,failureCode:code},stamp(1));
  return s;
}
const failure=s=>recovery.latestRecoveryFailureId(s);
const begin=(s,n=2)=>recovery.beginFaultRescue(s,{expectedFailureId:failure(s)},credential,stamp(n));
const finishArgs=(s,outcome='recovered',more={})=>({rescueId:s.codex.faultRescue.id,token:s.codex.faultRescue.token,
  expectedFailureId:s.codex.faultRescue.failureId,outcome,agentStopped:true,...more});
const recover=(s,n=3)=>bridge.reviewFailure(s,{decision:'recover_browser',observation:snapshot(n)},stamp(n));

test('generic safety checking does not assert human interaction or alter fault and leases',()=>{
  const s=fixture(),before=structuredClone(s.codex);
  const changed=recovery.recordRecoveryProgress(s,{expectedFailureId:failure(s),phase:'security_check',diagnostic:diagnostic()},stamp(2));
  assert.equal(changed.codex.recoveryProgress.phase,'security_check');
  assert.equal(changed.codex.globalFailureCode,before.globalFailureCode);assert.equal(changed.codex.lastError,before.lastError);
  assert.deepEqual(changed.codex.lease,before.lease);assert.deepEqual(changed.codex.receipts,before.receipts);
  assert.throws(()=>recovery.recordRecoveryProgress(s,{expectedFailureId:failure(s),phase:'interaction_required',diagnostic:diagnostic()},stamp(2)),/明确交互/);
  const explicit=recovery.recordRecoveryProgress(s,{expectedFailureId:failure(s),phase:'interaction_required',diagnostic:diagnostic('interaction_required')},stamp(2));
  assert.equal(explicit.codex.recoveryProgress.phase,'interaction_required');
  assert.deepEqual(recovery.recordRecoveryProgress(explicit,{expectedFailureId:failure(s),phase:'interaction_required',diagnostic:diagnostic('interaction_required')},stamp(2)),explicit);
});
test('unsafe, stale, foreign and unstructured diagnostics are refused',()=>{
  for(const d of [diagnostic('challenge',-100),diagnostic('challenge',10),diagnostic('challenge',1,{expectedUrl:'https://example.com'}),
    diagnostic('challenge',1,{expectedUrl:pageUrl+'?private=token'}),diagnostic('challenge',1,{html:'private'}),diagnostic('healthy')])
    assert.throws(()=>recovery.safeRecoveryDiagnostic(d,stamp(2)));
  const s=fixture();assert.throws(()=>recovery.recordRecoveryProgress(s,{expectedFailureId:'old',phase:'security_check'},stamp(2)),/故障已变化/);
  assert.throws(()=>recovery.recordRecoveryProgress(s,{expectedFailureId:failure(s),phase:'healthy'},stamp(2)),/恢复阶段/);
  assert.throws(()=>recovery.recordRecoveryProgress(s,{expectedFailureId:failure(s),phase:'auto_recovery',clear:true},stamp(2)),/参数/);
});
test('unknown, capacity, role and login failures cannot be downgraded to ordinary safety checks',()=>{
  for(const code of ['unknown','capacity_mismatch','role_mismatch','login_expired']) {
    const s=fixture(code);assert.throws(()=>recovery.recordRecoveryProgress(s,{expectedFailureId:failure(s),phase:'auto_recovery'},stamp(2)),/降级/);
    assert.throws(()=>recovery.recordRecoveryProgress(s,{expectedFailureId:failure(s),phase:'interaction_required',diagnostic:diagnostic('interaction_required')},stamp(2)),/明确交互/);
    if(code!=='unknown'&&code!=='login_expired')assert.throws(()=>begin(s),/不能自动交接/);
  }
  const login=fixture('login_expired');
  assert.throws(()=>recovery.recordRecoveryProgress(login,{expectedFailureId:failure(login),phase:'login_required',diagnostic:diagnostic()},stamp(2)),/登录失效/);
  assert.equal(recovery.recordRecoveryProgress(login,{expectedFailureId:failure(login),phase:'login_required',diagnostic:diagnostic('login')},stamp(2)).codex.recoveryProgress.phase,'login_required');
});
test('login recovery is limited to the exact login incident and fresh complete safe official evidence',()=>{
  const s=begin(fixture('login_expired')),args={decision:'recover_login',expectedFailureId:failure(s),observation:snapshot(3)};
  const valid=bridge.reviewFailure(s,args,stamp(3));
  assert.equal(valid.codex.globalFailureCode,undefined);assert.equal(valid.codex.lastError,undefined);
  assert.equal(valid.codex.faultRescue.phase,'pending');assert.equal(recovery.rescueBlocksClaims(valid),true);
  assert.ok(valid.audit.some(a=>a.action==='codex_login_recovered'));
  for(const changed of [{...args,expectedFailureId:undefined},{...args,expectedFailureId:'stale'},
    {...args,observation:snapshot(0)},{...args,observation:snapshot(3,{complete:false})},
    {...args,observation:snapshot(3,{totalSeats:5})},
    {...args,observation:snapshot(3,{members:[{email:owner.email,role:'owner'},{email:person.email,role:'admin'}]})},
    {...args,observation:snapshot(3,{invites:[{email:person.email,role:'member'},{email:person.email.toUpperCase(),role:'member'}]})}])
    assert.throws(()=>bridge.reviewFailure(s,changed,stamp(3)));
  for(const code of ['browser_unavailable','unknown','capacity_mismatch','role_mismatch','workspace_mismatch']) {
    const wrong=fixture(code);assert.throws(()=>bridge.reviewFailure(wrong,{...args,expectedFailureId:failure(wrong)},stamp(3)),/登录故障已变化/);
  }
  for(const patch of [{holds:[{code:'approval_required'}]},{operationFailureOrigin:{failureId:failure(s)}},{mailChannelError:'mail error'},{lease:{id:'inflight'}}]) {
    const unsettled=structuredClone(s);Object.assign(unsettled.codex,patch);assert.throws(()=>bridge.reviewFailure(unsettled,args,stamp(3)));
  }
  assert.throws(()=>bridge.reviewFailure(s,args,stamp(65)),/证据已过期/);
});
test('fresh login prompt discovered during browser recovery is reported without changing original fault scope',()=>{
  const s=begin(fixture()),id=failure(s),proof=diagnostic('login',3);
  const progress=recovery.recordRecoveryProgress(s,{expectedFailureId:id,phase:'login_required',diagnostic:proof},stamp(3));
  assert.equal(progress.codex.recoveryProgress.phase,'login_required');assert.equal(progress.codex.globalFailureCode,'browser_unavailable');
  const done=recovery.finishFaultRescue(progress,finishArgs(progress,'needs_human',{diagnostic:proof}),stamp(3));
  assert.equal(done.codex.faultRescue.outcome,'needs_human');assert.equal(done.codex.globalFailureCode,'browser_unavailable');
  assert.equal(done.codex.recoveryProgress.phase,'login_required');assert.equal(failure(done),id);
  assert.throws(()=>bridge.reviewFailure(done,{decision:'recover_login',expectedFailureId:id,observation:snapshot(4)},stamp(4)),/登录故障已变化/);
  assert.equal(recover(done,4).codex.globalFailureCode,undefined);
  for(const patch of [{globalFailureCode:'unknown'},{lease:{id:'claimed',status:'claimed'}},{operationFailureOrigin:{operationId:'original'}}]) {
    const unsafe=structuredClone(s);Object.assign(unsafe.codex,patch);
    assert.throws(()=>recovery.recordRecoveryProgress(unsafe,{expectedFailureId:id,phase:'login_required',diagnostic:proof},stamp(3)),/登录失效/);
    assert.throws(()=>recovery.finishFaultRescue(unsafe,finishArgs(unsafe,'needs_human',{diagnostic:proof}),stamp(3)),/不足以证明/);
  }
});
test('same incident reuses one exclusive ticket and no public plan or status contains its secret',()=>{
  const s=begin(fixture()),ticket=s.codex.faultRescue;
  const repeated=recovery.beginFaultRescue(s,{expectedFailureId:failure(s)},{id:'rescue_another_public_identifier',token:'different_private_secret'},stamp(3));
  assert.deepEqual(repeated,s);assert.equal(ticket.scope,'read_only_reconcile');assert.ok(!ticket.id.includes(ticket.token));
  for(const value of [recovery.publicFaultRescue(s),bridge.workPlan(s,stamp(2))])assert.equal(JSON.stringify(value).includes(ticket.token),false);
  assert.throws(()=>recovery.beginFaultRescue(fixture(),{expectedFailureId:failure(fixture())},{id:'rescue_'+credential.token,token:credential.token},stamp(2)),/凭证/);
  const ended=recovery.finishFaultRescue(s,finishArgs(s,'unresolved'),stamp(3));
  assert.deepEqual(begin(ended,4),ended);assert.equal(ended.codex.faultRescue.outcome,'unresolved');
});
test('a claimed operation cannot be stolen; an uncertain original lease is preserved exactly',()=>{
  let s=fixture();s=recover(s,2);s=bridge.claimOperation(s,'invite',s.requests[0].id,'original-operation-token',stamp(2));
  const lease=structuredClone(s.codex.lease);
  // A global browser status cannot replace the existing lease ownership.
  const fake=structuredClone(s);fake.codex.globalFailureCode='browser_unavailable';fake.codex.lastError='temporarily unavailable';
  assert.throws(()=>begin(fake,3),/原操作仍在办理/);
  s=bridge.completeOperation(s,{operationId:lease.id,token:lease.token,outcome:'uncertain',failureCode:'unknown',
    detail:'程序办理未完成；保留原租约和证据，不自动重做外部动作。'},stamp(3));
  const before=structuredClone(s.codex.lease),origin=structuredClone(s.codex.operationFailureOrigin),next=begin(s,4);
  assert.deepEqual(next.codex.lease,before);assert.deepEqual(next.codex.operationFailureOrigin,origin);
  assert.equal(next.codex.faultRescue.operationId,lease.id);
  const missing=structuredClone(s);delete missing.codex.operationFailureOrigin;assert.throws(()=>begin(missing,4),/缺少不明结果来源/);
});
test('fence still prevents ALL new claims even after original cloud fault was safely recovered',()=>{
  const s=recover(begin(fixture()),3);assert.equal(s.codex.globalFailureCode,undefined);
  assert.equal(recovery.rescueBlocksClaims(s),true);assert.equal(recovery.publicRecoveryProgress(s),null);
  for(const kind of ['invite','remove','mail'])assert.throws(()=>bridge.claimOperation(s,kind,s.requests[0].id,'new-operation-token',stamp(3)),/故障诊断/);
  const done=recovery.finishFaultRescue(s,finishArgs(s),stamp(3));
  assert.equal(recovery.rescueBlocksClaims(done),false);
  assert.equal(bridge.claimOperation(done,'invite',s.requests[0].id,'new-operation-token',stamp(3)).codex.lease.kind,'invite');
});
test('finish requires actual cloud recovery, current fresh snapshot and ended owner; it never clears anything itself',()=>{
  const original=begin(fixture());assert.throws(()=>recovery.finishFaultRescue(original,finishArgs(original),stamp(3)),/尚未结案/);
  const s=recover(original,3),args=finishArgs(s);
  assert.throws(()=>recovery.finishFaultRescue(s,{...args,agentStopped:false},stamp(3)),/会话已经结束/);
  assert.throws(()=>recovery.finishFaultRescue(s,{...args,agentStopped:'true'},stamp(3)),/结束证明/);
  assert.throws(()=>recovery.finishFaultRescue(s,{...args,token:'wrong'},stamp(3)),/凭证/);
  assert.throws(()=>recovery.finishFaultRescue(s,args,stamp(65)),/证据已过期/);
  const invalid=[{observation:snapshot(1)},{observation:snapshot(3,{totalSeats:5})},
    {observation:snapshot(3,{members:[{email:owner.email,role:'owner'},{email:'duplicate@example.com',role:'member'}],invites:[{email:'duplicate@example.com',role:'member'}]})},
    {observation:snapshot(3,{members:[{email:owner.email,role:'owner'},{email:'duplicate@example.com',role:'member'}],invites:[{email:'DUPLICATE@EXAMPLE.COM',role:'member'}]})},
    {observation:snapshot(3,{members:[{email:owner.email,role:'owner'},{email:person.email,role:'admin'}]})},
    {holds:[{operation:{id:'held'},code:'member_action'}]},{operationFailureOrigin:{failureId:failure(s)}},{mailChannelError:'mail error'}];
  for(const codex of invalid) {const bad=structuredClone(s);Object.assign(bad.codex,codex);assert.throws(()=>recovery.finishFaultRescue(bad,args,stamp(3)));}
  const done=recovery.finishFaultRescue(s,args,stamp(3));assert.equal(done.codex.faultRescue.phase,'finished');
  assert.equal(done.codex.faultRescue.outcome,'recovered');assert.equal(done.codex.lastError,undefined);
  assert.deepEqual(recovery.finishFaultRescue(done,args,stamp(4)),done);
  assert.throws(()=>recovery.finishFaultRescue(done,{...args,outcome:'unresolved'},stamp(4)),/不能改写/);
});
test('unconfirmed result keeps fence; human outcome needs explicit fresh interaction or login proof',()=>{
  const s=begin(fixture()),args=finishArgs(s,'needs_human');
  assert.throws(()=>recovery.finishFaultRescue(s,{...args,diagnostic:diagnostic()},stamp(3)),/不足以证明/);
  const unsure=recovery.finishFaultRescue(s,finishArgs(s,'uncertain',{agentStopped:false}),stamp(3));
  assert.equal(recovery.rescueBlocksClaims(unsure),true);assert.equal(unsure.codex.faultRescue.phase,'uncertain');
  const human=recovery.finishFaultRescue(unsure,{...args,diagnostic:diagnostic('interaction_required',4)},stamp(4));
  assert.equal(human.codex.recoveryProgress.phase,'interaction_required');assert.equal(human.codex.globalFailureCode,'browser_unavailable');
  const login=begin(fixture('login_expired'));
  assert.equal(recovery.finishFaultRescue(login,finishArgs(login,'needs_human',{diagnostic:diagnostic('login',3)}),stamp(3)).codex.recoveryProgress.phase,'login_required');
});
test('a newer fault cannot be overwritten by old rescue; ended unresolved ownership can be released safely',()=>{
  let s=begin(fixture());const oldArgs=finishArgs(s,'recovered');
  s=bridge.deferOperation(s,{kind:'invite',targetId:s.requests[0].id,failureCode:'unknown',detail:'new unknown failure'},stamp(3));
  assert.notEqual(failure(s),oldArgs.expectedFailureId);
  assert.throws(()=>recovery.finishFaultRescue(s,oldArgs,stamp(4)),/更新的故障/);
  assert.throws(()=>begin(s,4),/已有故障处置/);
  const done=recovery.finishFaultRescue(s,{...oldArgs,outcome:'unresolved'},stamp(4));
  assert.equal(done.codex.globalFailureCode,'unknown');assert.equal(done.codex.lastError,'new unknown failure');
  assert.equal(done.codex.faultRescue.phase,'finished');assert.equal(recovery.publicRecoveryProgress(done),null);
});

function database(initial) {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_bored_stick.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../drizzle/0001_chilly_squirrel_girl.sql',import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
  sqlite.prepare('INSERT INTO portal_state VALUES(?,?,?)').run('main',0,JSON.stringify(initial));
  const api={prepare(sql){let params=[];return{bind(...v){params=v;return this;},async first(){return sqlite.prepare(sql).get(...params)??null;},
    async all(){return{results:sqlite.prepare(sql).all(...params)};},async run(){const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes)}};}};},
    async batch(operations){sqlite.exec('BEGIN');try{const out=[];for(const op of operations)out.push(await op.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return {api,sqlite,read(){return sqlite.prepare('SELECT revision,document FROM portal_state WHERE id=?').get('main');},close(){sqlite.close();}};
}
test('SQLite CAS race cannot overwrite a new fault with an old ticket, and successful fence rejects stale claim retry',async()=>{
  const s=fixture(),db=database(s);
  try {
    const staleTicket=begin(s),newFault=bridge.deferOperation(s,{kind:'invite',targetId:s.requests[0].id,failureCode:'unknown'},stamp(3));
    assert.equal((await history.persistHistoryCas(db.api,s,newFault,0)).committed,true);
    assert.equal((await history.persistHistoryCas(db.api,s,staleTicket,0)).committed,false);
    const current=JSON.parse(db.read().document);assert.equal(current.codex.globalFailureCode,'unknown');assert.equal(current.codex.faultRescue,undefined);
    assert.throws(()=>recovery.beginFaultRescue(current,{expectedFailureId:failure(s)},credential,stamp(4)),/故障已变化/);
    const acquired=begin(current,4);assert.equal((await history.persistHistoryCas(db.api,current,acquired,1)).committed,true);
    const healthy=bridge.reviewFailure(acquired,{decision:'resume_workspace',observation:snapshot(5)},stamp(5));
    assert.throws(()=>bridge.claimOperation(healthy,'invite',s.requests[0].id,'new-operation-token',stamp(5)),/故障诊断/);
    assert.equal(JSON.stringify(JSON.parse(db.read().document).codex.faultRescue),JSON.stringify(acquired.codex.faultRescue));
  } finally {db.close();}
});
test('compaction pins the active rescue failure provenance and version rollback refuses an active owner',async()=>{
  const s=begin(fixture()),failureId=failure(s),target=s.requests[0];target.status='completed';
  delete s.codex.lastError;delete s.codex.globalFailureCode;
  s.requests.push(...Array.from({length:170},(_,i)=>({...target,id:'closed_'+i,createdAt:stamp(10+i),updatedAt:stamp(10+i)})));
  s.audit.push(...Array.from({length:650},(_,i)=>({id:'noise_'+i,at:stamp(10+i),actor:owner.email,action:'noise'})));
  const compacted=historyPolicy.compactHistory(s,s).state;
  assert.ok(compacted.audit.some(a=>a.id===failureId));assert.ok(compacted.requests.some(r=>r.id===target.id));
  assert.throws(()=>historyPolicy.rehydrateHistory(compacted,[]),/执行权/);
  compacted.codex.enabled=false;compacted.config.automationEnabled=false;const db=database(compacted);
  try{await assert.rejects(()=>historyRollback.restoreV11History(db.api,0),/执行权/);assert.equal(db.read().revision,0);}finally{db.close();}
});

function compile(relative,options={}) {return ts.transpileModule(readFileSync(new URL(relative,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,...options}}).outputText;}
async function server(initial) {
  let ms=Date.parse(stamp(2)),actor=owner;const db=database(initial);
  class Clock extends Date{constructor(...args){super(...(args.length?args:[ms]));}static now(){return ms;}}
  const ctx=vm.createContext({Request,Response,TextEncoder,URL,crypto:webcrypto,console,Date:Clock,structuredClone,Error});
  const dependencies={'cloudflare:workers':{env:{DB:db.api,REMINDER_DELIVERY_MODE:'in_app'}},'@/app/chatgpt-auth':{getChatGPTUser:async()=>actor},
    './seat-engine':engine,'./portal-access':access,'./reminder-policy':reminder,'./history-store':history,'./request-rate-policy':rate,'./recovery-control':recovery,
    '@/lib/seat-engine':engine,'@/lib/codex-bridge':bridge,'@/lib/reminder-policy':reminder,'@/lib/recovery-control':recovery,
    '@/lib/history-rollback':historyRollback,'@/lib/official-idle-state':officialIdle,'@/lib/jobs':{runJobs:async()=>({}),refreshSeatQueue:async()=>({})}};
  const synthetic=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});
  const service=new vm.SourceTextModule(compile('../lib/portal-service.ts'),{context:ctx});await service.link(s=>synthetic(dependencies[s]));await service.evaluate();
  const route=new vm.SourceTextModule(compile('../app/mcp/route.ts'),{context:ctx});await route.link(s=>s==='@/lib/portal-service'?service:synthetic(dependencies[s]));await route.evaluate();
  return {db,service:service.namespace,actor(v){actor=v;},advance(n){ms+=n*1000;},async call(name,args={},headers={}){
    const response=await route.namespace.POST(new Request('https://portal.example.test/api/codex',{method:'POST',headers:{origin:'https://portal.example.test','content-type':'application/json',...headers},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
    if(response.status!==200)return {status:response.status};const rpc=await response.json();return rpc.result?.isError?{error:rpc.result.content[0].text}:JSON.parse(rpc.result.content[0].text);
  }};
}
test('real RPC and D1 path enforce admin/same-origin, lost-response idempotency and public credential redaction',async()=>{
  const initial=fixture(),f=await server(initial);
  try {
    f.actor(null);assert.match((await f.call('begin_fault_rescue',{expectedFailureId:failure(initial)})).error,/管理员/);
    f.actor(person);assert.match((await f.call('fault_rescue_status')).error,/管理员/);
    f.actor(owner);assert.equal((await f.call('begin_fault_rescue',{expectedFailureId:failure(initial)},{origin:'https://evil.example'})).status,403);
    assert.match((await f.call('begin_fault_rescue',{expectedFailureId:failure(initial),clear:true})).error,/参数/);
    const result=await f.call('begin_fault_rescue',{expectedFailureId:failure(initial)});assert.ok(result.ticket.token);assert.ok(!result.ticket.id.includes(result.ticket.token));
    const repeated=await f.call('begin_fault_rescue',{expectedFailureId:failure(initial)});assert.deepEqual(repeated.ticket,result.ticket);
    assert.equal(f.db.read().revision,1); // Same transform is a no-op in CAS.
    const status=await f.call('fault_rescue_status');assert.equal(JSON.stringify(status).includes(result.ticket.token),false);
    assert.match((await f.call('fault_rescue_status',{token:result.ticket.token})).error,/不接受参数/);
    const page=await f.service.portalData();assert.equal(JSON.stringify(page).includes(result.ticket.token),false);
    assert.equal(page.connection.memberPaused,true);assert.equal(page.connection.faultRescue.id,result.ticket.id);
    const wrong=await f.call('finish_fault_rescue',{rescueId:result.ticket.id,token:result.ticket.token,expectedFailureId:failure(initial),outcome:'recovered',agentStopped:true});
    assert.match(wrong.error,/尚未结案/);assert.equal(JSON.parse(f.db.read().document).codex.faultRescue.phase,'pending');
  }finally{f.db.close();}
});
test('UI distinguishes generic challenge from proven interaction and never creates a popup',async()=>{
  const require=createRequire(import.meta.url),module={exports:{}};
  vm.runInNewContext(compile('../app/recovery-notice.tsx',{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}),
    {module,exports:module.exports,require},{filename:'recovery-notice.js'});
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),Notice=module.exports.default;
  const render=connection=>renderToStaticMarkup(React.createElement(Notice,{connection,admin:true}));
  const generic=render({memberPaused:true,browserRecovering:true,recoveryProgress:{phase:'security_check'}});
  assert.match(generic,/目前没有证据表明必须手动真人认证/);assert.doesNotMatch(generic,/请在执行器/);
  assert.match(render({memberPaused:true,recoveryProgress:{phase:'interaction_required'}}),/需要交互的验证控件/);
  assert.match(render({memberPaused:true,faultRescue:{phase:'uncertain'}}),/故障诊断结果尚未确认/);
  assert.equal(render({memberPaused:false}), '');
});
