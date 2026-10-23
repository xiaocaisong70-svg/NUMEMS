import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createState,transition} from '../lib/seat-engine.ts';
import {observeWorkspace,claimOperation,completeOperation,deferOperation,workPlan} from '../lib/codex-bridge.ts';
import {deliverReminders} from '../lib/reminder-relay.ts';
import {runBatch} from '../scripts/agentless/core.mjs';
import {validateConfig,ADMIN,WORKSPACE} from '../scripts/agentless/config.mjs';
import {Journal,acquireLock,readJson} from '../scripts/agentless/journal.mjs';
import {assertExclusive} from '../scripts/agentless/guard.mjs';
import {notifyFailure} from '../scripts/agentless/alert.mjs';
import {recoverBrowser} from '../scripts/agentless/recovery.mjs';

const owner={userId:'owner',email:ADMIN,isAdmin:true};
const staff=i=>({userId:`u${i}`,email:`staff${i}@example.com`,isAdmin:false});
function fixture(mode = 'relay') {
  let now=new Date('2026-10-22T12:00:00Z');
  const at=()=>now.toISOString();
  let s=transition(createState(at()),owner,{type:'configure',config:{workspaceId:WORKSPACE,
    whitelist:[0,1,2,3,4].map(i=>staff(i).email),automationEnabled:true}},at());
  s=transition(s,owner,{type:'sync_inventory',members:[{email:ADMIN,role:'owner'}]},at());
  s.codex={enabled:true,testOnly:false,mailEnabled:mode==='relay',receipts:[]};
  const members=[],invites=[],calls=[],clicks=[];
  const snapshot=()=>({workspaceId:WORKSPACE,accountEmail:ADMIN,complete:true,totalSeats:4,
    observedAt:at(),pageUrl:`https://admin.openai.com/workspace/${WORKSPACE}/members`,
    members:[{email:ADMIN,role:'owner'},...members.map(email=>({email,role:'member'}))],
    invites:invites.map(email=>({email,role:'member'}))});
  const portal={async call(name,args={}) {
    calls.push({name,args});
    if(name==='process_seat_queue'){s=transition(s,owner,{type:'tick'},at());return {mailMode:mode};}
    if(name==='observe_workspace') s=observeWorkspace(s,args.observation,at());
    if(name==='claim_seat_operation') s=claimOperation(s,args.kind,args.targetId,randomUUID(),at());
    if(name==='complete_seat_operation') s=completeOperation(s,args,at());
    if(name==='defer_seat_operation') s=deferOperation(s,args,at());
    return {plan:workPlan(s,at())};
  }};
  const browser={observe:async()=>snapshot(),async invite(email){await this.onExternalAction();clicks.push(['invite',email]);invites.push(email);return at();},
    async remove(email){await this.onExternalAction();clicks.push(['remove',email]);
      for(const list of [members,invites]){const i=list.indexOf(email);if(i>=0)list.splice(i,1);}}};
  const config=validateConfig({liveActions:true,legacyCheckerDisabled:true,mailMode:mode});
  return {portal,browser,config,members,invites,calls,clicks,snapshot,
    get state(){return s;}, set state(v){s=v;},now:at,
    advance(seconds){now=new Date(now.getTime()+seconds*1000);},
    command(actor,command){s=transition(s,actor,command,at());},
    apply(i,hours=1){s=transition(s,staff(i),{type:'apply',name:`Staff ${i}`,reason:'automated test',hours},at());},
    run(extra={}){return runBatch({portal,browser,config,clock:()=>now,...extra});}};
}
test('FIFO three slots, no duplicate invites, acceptance, expiry and next FIFO in same batch',async()=>{
  const f=fixture();for(let i=0;i<4;i++)f.apply(i);
  await f.run();assert.deepEqual(f.clicks.map(x=>x[1]),[0,1,2].map(i=>staff(i).email));
  assert.equal(f.state.requests[3].status,'queued');await f.run();assert.equal(f.clicks.length,3);
  f.members.push(...f.invites.splice(0));f.advance(121);await f.run();
  assert.equal(f.state.requests[0].status,'active');
  f.advance(3601);await f.run();
  assert.deepEqual(f.state.requests.map(r=>r.status),['completed','completed','completed','invited']);
  assert.deepEqual(f.clicks.slice(3).map(x=>x[0]),['remove','remove','remove','invite']);
});
test('5 minute timeout revokes pending only, then allocates the next employee',async()=>{
  const f=fixture();for(let i=0;i<4;i++)f.apply(i);await f.run();f.advance(300);await f.run();
  assert.equal(f.state.requests[0].status,'completed');assert.equal(f.state.requests[3].status,'invited');
  assert.equal(f.invites.includes(staff(3).email),true);
});
test('joined employee at deadline is protected even when acceptance was not checked earlier',async()=>{
  const f=fixture();f.apply(0);await f.run();f.members.push(...f.invites.splice(0));f.advance(301);await f.run();
  assert.equal(f.state.requests[0].status,'active');assert.equal(f.clicks.filter(x=>x[0]==='remove').length,0);
});
test('join race AFTER claim protects membership and completes with joined evidence',async()=>{
  const f=fixture();f.apply(0);await f.run();f.advance(301);
  const original=f.browser.observe;let observations=0;
  f.browser.observe=async()=>{if(++observations===2)f.members.push(...f.invites.splice(0));return original();};
  await f.run();assert.equal(f.state.requests[0].status,'active');
  assert.ok(f.state.codex.receipts.some(r=>r.kind==='joined_during_revocation'));
  assert.equal(f.clicks.filter(x=>x[0]==='remove').length,0);
});
test('early release and renewal keep original rules',async()=>{
  const f=fixture();f.apply(0);await f.run();f.members.push(...f.invites.splice(0));f.advance(121);await f.run();
  const id=f.state.requests[0].id;
  f.command(staff(0),{type:'renew',id,hours:3});assert.equal(Date.parse(f.state.requests[0].expiresAt)-Date.parse(f.now()),10800000);
  f.command(staff(0),{type:'release',id});await f.run();assert.equal(f.state.requests[0].status,'completed');
});
test('web-only reminders retain official invitations and reclamation without mail or Agent calls',async()=>{
  const f=fixture('in_app');f.apply(0);await f.run();
  assert.equal(f.clicks[0][0],'invite');
  f.members.push(...f.invites.splice(0));f.advance(121);await f.run();
  f.advance(1801);await f.run();
  assert.ok(f.state.notices.some(n=>n.type==='expiry_30m' && n.status==='pending'));
  assert.equal(workPlan(f.state,f.now()).reminders.length,0);
  assert.equal(f.calls.some(c=>c.name==='claim_seat_operation' && c.args.kind==='mail'),false);
  f.advance(1801);await f.run();assert.equal(f.state.requests[0].status,'completed');
  assert.deepEqual(f.clicks.map(c=>c[0]),['invite','remove']);
});
test('single classified member failure does not block another reclaim and is not retried',async()=>{
  const f=fixture();f.apply(0);f.apply(1);await f.run();f.members.push(...f.invites.splice(0));f.advance(121);await f.run();
  f.advance(3601);const remove=f.browser.remove;
  f.browser.remove=async function(email){if(email===staff(0).email)throw Object.assign(new Error('specific denied action'),{failureCode:'approval_required'});await remove.call(this,email);};
  await f.run();assert.equal(f.state.requests[0].status,'pending_removal');assert.equal(f.state.requests[1].status,'completed');
  assert.equal(f.state.codex.holds.length,1);assert.equal((await f.run()).actions.length,0);
});
test('unknown result retains global lease and stops; actual absence after timeout completes once',async()=>{
  const f=fixture();f.apply(0);await f.run();f.advance(301);
  f.browser.remove=async function(){await this.onExternalAction();throw new Error('connection lost');};
  await assert.rejects(f.run(),/connection lost/);assert.equal(f.state.codex.globalFailureCode,'unknown');assert.ok(f.state.codex.lease);
  const g=fixture();g.apply(0);await g.run();g.advance(301);const remove=g.browser.remove;
  g.browser.remove=async function(email){await remove.call(this,email);throw new Error('dialog timeout');};
  await g.run();assert.equal(g.state.requests[0].status,'completed');assert.equal(g.clicks.filter(x=>x[0]==='remove').length,1);
});
test('dry run and disabled plans perform no writes',async()=>{
  const f=fixture();f.apply(0);await f.run({config:{...f.config,liveActions:false}});
  assert.deepEqual(f.calls.map(x=>x.name),['seat_portal_status']);
  f.state.codex.enabled=false;f.calls.length=0;assert.equal((await f.run()).mode,'disabled');assert.equal(f.calls.length,1);
});
test('relay mail is sent once with receipt, cancels old renewal deadline; ambiguity never resends',async()=>{
  const f=fixture();f.apply(0);await f.run();f.members.push(...f.invites.splice(0));f.advance(121);await f.run();f.advance(1801);
  f.command(owner,{type:'tick'});
  const store={read:async()=>f.state,mutate:async change=>(f.state=change(f.state))};
  const config={url:'https://mail.example.com/send',token:'fixture-secret',portalUrl:f.config.siteUrl};let sends=0;
  const fetcher=async(_url,options)=>{sends++;const body=JSON.parse(options.body);assert.match(body.subject,/\[NUMEMS:/);assert.match(body.text,/numems-seat-portal-agentless/);return Response.json({accepted:true,id:'provider123',notificationId:body.notificationId});};
  await deliverReminders(store,config,{clock:f.now,fetcher});await deliverReminders(store,config,{clock:f.now,fetcher});assert.equal(sends,1);
  f.command(staff(0),{type:'renew',id:f.state.requests[0].id,hours:1});f.advance(1801);f.command(owner,{type:'tick'});
  const lost=async()=>{sends++;throw new Error('lost response');};
  await deliverReminders(store,config,{clock:f.now,fetcher:lost});await deliverReminders(store,config,{clock:f.now,fetcher:lost});assert.equal(sends,2);assert.equal(f.state.codex.holds[0].code,'mail_delivery');
});
test('journal and lock prevent crash replay; cloud receipt safely reconciles',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-agentless-'));
  try {
    const j=new Journal(path.join(dir,'op.json'));await j.prepare({targetId:'request'});
    await assert.rejects(j.reconcile({receipts:[]}),/未完成/);await j.claimed({id:'operation',token:'secret'});
    await j.reconcile({receipts:[{id:'operation'}]});assert.equal((await readJson(j.file)).phase,'settled');
    const release=await acquireLock(path.join(dir,'lock'));await assert.rejects(acquireLock(path.join(dir,'lock')),/遗留锁/);await release();
  } finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});
test('configuration disallows source-site writes, shared profiles and model mail modes',async()=>{
  assert.throws(()=>validateConfig({siteUrl:'https://numems-seat-portal.workspace-026021.chatgpt.site/'}));
  assert.throws(()=>validateConfig({mailMode:'codex'}));assert.throws(()=>validateConfig({profile:'../../business-seat-portal/browser'}));
  await assert.rejects(assertExclusive({liveActions:true,legacyCheckerDisabled:true},async()=>({tasks:['NUMEMS-Seat-Queue'],workers:0})),/双执行器/);
  await assertExclusive({liveActions:true,legacyCheckerDisabled:true},async()=>({tasks:[],workers:0}));
});
test('alerts never start a model and uncertain delivery is not resent',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-alert-'));
  try {let sends=0;const options={env:{NUMEMS_ALERT_URL:'https://example.com/alert',NUMEMS_ALERT_TOKEN:'fixture'},fetcher:async()=>{sends++;throw new Error('timeout');}};
    const file=path.join(dir,'alert.json');await notifyFailure(file,{code:'unknown'},options);await notifyFailure(file,{code:'unknown'},options);assert.equal(sends,1);
  } finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});
test('browser recovery is bounded and only uses fresh read-only evidence',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-recovery-'));
  try {
    const p={globalFailureCode:'browser_unavailable',browserRecovery:{eligible:true}};
    let reads=0,reviews=0;const delays=[];
    const portal={async call(name,args){if(name==='seat_portal_status')return {plan:p};
      assert.equal(name,'review_seat_failure');assert.equal(args.decision,'recover_browser');reviews++;return {plan:{}};}};
    const f=fixture();const browser={async observe(){if(++reads<3)throw new Error('still loading');return f.snapshot();}};
    assert.equal(await recoverBrowser({portal,browser,journalFile:path.join(dir,'op.json'),pause:async ms=>delays.push(ms)}),true);
    assert.deepEqual(delays,[15000,30000,60000]);assert.equal(reviews,1);
  } finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});
test('browser recovery cannot downgrade a claimed or unknown operation',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-recovery-'));
  try {
    let observes=0;const browser={async observe(){observes++;}};
    for(const plan of [{globalFailureCode:'unknown'},{globalFailureCode:'browser_unavailable',browserRecovery:{eligible:true},busy:true}]) {
      assert.equal(await recoverBrowser({portal:{async call(){return {plan};}},browser,journalFile:path.join(dir,'op.json'),pause:async()=>{}}),false);
    }
    assert.equal(observes,0);
  } finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});

 test('transitive routine runtime imports contain no Agent or app-server integration', async()=>{
 const fs=await import('node:fs/promises');const visited=new Set();
 async function visit(file){if(visited.has(file))return;visited.add(file);const source=await fs.readFile(file,'utf8');assert.doesNotMatch(source,/turn\/start|thread\/queue\/add|send_message_to_thread|AppServerClient/);
 for(const m of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)){await visit(path.resolve(path.dirname(file),m[1]));}}
 await visit(path.resolve('scripts/agentless/main.mjs'));assert.ok(visited.size>8);
 });
