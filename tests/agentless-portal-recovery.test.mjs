import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverPortal,recoverablePortalError,validPortalFailure} from '../scripts/agentless/portal-recovery.mjs';
import {PortalReadUnavailable,PortalQueueUnavailable} from '../scripts/seat-executor/portal-client.mjs';
import {restartDecision} from '../scripts/agentless/watchdog-policy.mjs';
import {runBatch} from '../scripts/agentless/core.mjs';
import {validateConfig} from '../scripts/agentless/config.mjs';
import {mkdtemp,unlink,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Journal,readJson} from '../scripts/agentless/journal.mjs';
const config=validateConfig({liveActions:true,legacyCheckerDisabled:true});
const error=()=>new PortalReadUnavailable({stage:'status',requestedOperation:'seat_portal_status',requestNotSent:false,readOnly:true,reason:'timeout'});
const queueError=()=>new PortalQueueUnavailable({stage:'queue_refresh',requestedOperation:'refresh_seat_queue',idempotent:true,noExternalActions:true,reason:'network'});
function fixture(){
  let time=Date.parse('2026-10-26T10:00:00Z'),journal={phase:'settled'};
  const reports=[],calls=[],sleeps=[];
  const plan={workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,busy:false,lease:null,lastError:null,globalFailureCode:null};
  const snapshot=()=>({complete:true,workspaceId:config.workspaceId,workspaceName:config.workspaceName,
    accountEmail:config.adminEmail,totalSeats:4,seatLabel:config.seatLabel,observedAt:new Date(time).toISOString(),
    pageUrl:`https://admin.openai.com/workspace/${config.workspaceId}/members`,
    members:[{email:config.adminEmail,role:'owner',seatLabel:config.seatLabel}],invites:[]});
  const args={error:error(),config,clock:()=>new Date(time),delays:[2000,3000],readJournal:async()=>journal,
    shouldStop:async()=>false,saveStatus:async r=>reports.push(r),
    pause:async ms=>{sleeps.push(ms);time+=ms;},
    portal:{call:async name=>{calls.push(name);return {plan};}},browser:{observe:async()=>snapshot()}};
  return {args,calls,reports,sleeps,plan,snapshot,setJournal:value=>{journal=value;}};
}
test('read recovery persists beyond three failures, checks official evidence and uses no write endpoint',async()=>{
  const f=fixture();let failures=4,observations=0;
  f.args.portal.call=async name=>{f.calls.push(name);if(failures-->0)throw error();return {plan:f.plan};};
  f.args.browser.observe=async()=>{observations++;return f.snapshot();};
  const result=await recoverPortal(f.args);
  assert.equal(result.portalRecovered,true);assert.equal(observations,1);
  assert.equal(f.reports.length,5);assert.ok(f.calls.every(n=>n==='seat_portal_status'));
  assert.ok(f.sleeps.every(ms=>ms<=1000));assert.ok(f.reports.every(r=>r.modelCalls===0));
  assert.equal(f.reports[4].nextCheckAt,'2026-10-26T10:00:14.000Z');
});
test('only the separately proven pure queue refresh timeout is recoverable',async()=>{
  const f=fixture();f.args.error=queueError();
  assert.equal((await recoverPortal(f.args)).portalRecovered,true);
  assert.equal(validPortalFailure('portal_queue_unavailable',{...queueError().metadata,requestedOperation:'process_seat_queue'}),false);
  assert.equal(recoverablePortalError(Object.assign(new Error('timeout'),{failureCode:'portal_read_unavailable',metadata:error().metadata})),false);
});
test('any unfinished phase, retained token/evidence or unknown error prevents recovery',async()=>{
  for(const journal of [{phase:'claiming'},{phase:'claimed'},{phase:'attempting'},{phase:'completing'},
    {phase:'settled',lease:{id:'op'}},{phase:'settled',receipt:{outcome:'unknown'}}]){
    const f=fixture();f.setJournal(journal);
    await assert.rejects(recoverPortal(f.args));assert.deepEqual(f.calls,[]);
  }
  const f=fixture();f.args.error=new Error('page.evaluate: TimeoutError: signal timed out');
  await assert.rejects(recoverPortal(f.args));assert.equal(f.reports.length,0);
});
test('cloud lease/global faults and malformed official inventory stop without clearing anything',async()=>{
  for(const patch of [{busy:true},{lease:{id:'op'}},{lastError:'unknown'},{globalFailureCode:'login_expired'},
    {workspaceId:'wrong'},{administrator:'wrong@example.com'}]){
    const f=fixture();Object.assign(f.plan,patch);
    await assert.rejects(recoverPortal(f.args));assert.deepEqual(f.calls,['seat_portal_status']);
  }
  const f=fixture();f.args.browser.observe=async()=>({...f.snapshot(),totalSeats:5});
  await assert.rejects(recoverPortal(f.args));assert.deepEqual(f.calls,['seat_portal_status']);
});
test('new lease during official recheck is preserved and cannot resume actions',async()=>{
  const f=fixture();f.args.browser.observe=async()=>{f.plan.busy=true;return f.snapshot();};
  await assert.rejects(recoverPortal(f.args));assert.equal(f.plan.busy,true);
  assert.deepEqual(f.calls,['seat_portal_status','seat_portal_status']);
});
test('stop during backoff and a journal changed during wait both prevent the next request',async()=>{
  const f=fixture();let stop=false;f.args.shouldStop=async()=>stop;f.args.pause=async()=>{stop=true;};
  assert.equal((await recoverPortal(f.args)).stopped,true);assert.deepEqual(f.calls,[]);
  const g=fixture();g.args.pause=async()=>g.setJournal({phase:'claiming'});
  await assert.rejects(recoverPortal(g.args));assert.deepEqual(g.calls,[]);
});
test('authentication or protocol errors during the health check remain fatal',async()=>{
  const f=fixture();f.args.portal.call=async()=>{throw new Error('Unauthorized identity');};
  await assert.rejects(recoverPortal(f.args),/Unauthorized/);assert.equal(f.reports.length,1);
});
test('watchdog admits only structured safe portal failure with a settled journal and full isolation proof',()=>{
  const desktop='NUMEMS-Agentless-portaltest';
  const host={mode:'run',state:'blocked',exitCode:1,checkedAt:'2026-10-26T10:00:00Z',processId:123,
    modelCalls:0,audits:1,maxOwnedWindowsOnInputDesktop:0,desktop,inputDesktop:'Default',
    windowAudit:{isolated:true,desktop,inputDesktop:'Default',ownedWindowsOnInputDesktop:0}};
  for(const e of [error(),queueError()]){
    const status={state:'blocked',checkedAt:host.checkedAt,modelCalls:0,failureCode:e.failureCode,readFailure:e.metadata};
    const args={host,status,journal:{phase:'settled'},now:Date.parse(host.checkedAt)};
    assert.equal(restartDecision(args).allowed,true);
    assert.equal(restartDecision({...args,journal:{phase:'attempting'}}).allowed,false);
    assert.equal(restartDecision({...args,status:{...status,failureCode:'unknown'}}).allowed,false);
    assert.equal(restartDecision({...args,status:{...status,readFailure:{}}}).allowed,false);
    assert.equal(restartDecision({...args,host:{...host,error:'Unrelated unknown failure'}}).allowed,false);
  }
});
test('production queue uses pure refresh and identity failure before observation is not deferred as an unknown write',async()=>{
  const calls=[];
  const plan={workspaceId:config.workspaceId,administrator:config.adminEmail,enabled:true,busy:false,lease:null,
    lastError:null,globalFailureCode:null,blockedOperations:[],removals:[{id:'req1',email:'staff@example.com'}],invites:[],awaitingAcceptance:[]};
  const e=new PortalReadUnavailable({stage:'identity',requestedOperation:'observe_workspace',requestNotSent:true,readOnly:true,reason:'timeout'});
  const portal={refreshQueue:async()=>{calls.push('refresh');return {mailMode:'in_app'};},call:async name=>{
    calls.push(name);if(name==='observe_workspace')throw e;return {plan};}};
  await assert.rejects(runBatch({portal,browser:{observe:async()=>fixture().snapshot()},config,
    journal:{reconcile:async()=>{}}}),x=>x===e);
  assert.ok(calls.includes('refresh'));assert.equal(calls.includes('process_seat_queue'),false);
  assert.equal(calls.includes('defer_seat_operation'),false);assert.equal(calls.includes('claim_seat_operation'),false);
});
test('only a matching claim proven not sent may settle preparation; sent or claimed records stay intact',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'numems-unsent-claim-test-'));
  const file=path.join(directory,'operation.json'),journal=new Journal(file);
  const target={kind:'invite',targetId:'req1',email:'staff@example.com'};
  const proof={stage:'identity',requestedOperation:'claim_seat_operation',requestNotSent:true,readOnly:true,reason:'timeout'};
  try {
    await journal.prepare(target);
    await journal.settleUnsentClaim(target,proof);
    let current=await readJson(file);assert.equal(current.phase,'settled');assert.deepEqual(current.claimNotSent.proof,proof);
    await journal.prepare(target);
    await assert.rejects(journal.settleUnsentClaim({...target,targetId:'req2'},proof));
    await assert.rejects(journal.settleUnsentClaim(target,{...proof,requestNotSent:false}));
    assert.equal((await readJson(file)).phase,'claiming');
    await journal.claimed({id:'op1',token:'fixture-only'});
    await assert.rejects(journal.settleUnsentClaim(target,proof));
    current=await readJson(file);assert.equal(current.phase,'claimed');assert.equal(current.lease.id,'op1');
  }finally{await unlink(file);await rmdir(directory);}
});
