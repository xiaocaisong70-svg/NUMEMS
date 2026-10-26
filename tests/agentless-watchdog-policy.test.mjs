import test from 'node:test';
import assert from 'node:assert/strict';
import {restartDecision} from '../scripts/agentless/watchdog-policy.mjs';

const now=Date.parse('2026-10-25T12:00:00.000Z');
const host={mode:'run',state:'blocked',checkedAt:'2026-10-23T08:44:04.000Z',processId:1234,
  modelCalls:0,error:'Exception calling "Audit" with "0" argument(s): "Input desktop cannot be audited"'};
const status={checkedAt:'2026-10-23T08:43:59.000Z',mode:'idle',modelCalls:0,liveActions:true};
const settled={phase:'settled',updatedAt:'2026-10-23T08:21:36.000Z'};
const decision=patch=>restartDecision({host,status,journal:settled,now,...patch});
const stop={version:1,id:'10d947b9-fbda-4cc6-aabe-48d3d2c45e56',
  requestedAt:'2026-10-23T08:43:00.000Z',target:{pid:1234,at:'2026-10-23T08:00:00.000Z'}};
const probe={...host,checkedAt:'2026-10-25T11:59:00.000Z',mode:'probe',state:'exited',exitCode:0,error:null,audits:30,
  maxOwnedWindowsOnInputDesktop:0,desktop:'NUMEMS-Agentless-reviewed-123',inputDesktop:'Default',
  windowAudit:{isolated:true,desktop:'NUMEMS-Agentless-reviewed-123',inputDesktop:'Default',ownedWindowsOnInputDesktop:0}};

test('first start without any fault records is eligible, with no side effects',()=>{
  assert.deepEqual(restartDecision({now}),{allowed:true,reason:'initial_start_without_failure'});
  assert.equal(restartDecision({now:new Date(now)}).allowed,true);
});
test('the actual wrapped input desktop audit failure is eligible despite stale idle status',()=>{
  assert.deepEqual(decision(),{allowed:true,reason:'input_desktop_audit_recovery_candidate'});
  assert.equal(decision({journal:null}).allowed,true);
  assert.equal(decision({host:{...host,error:'Input desktop cannot be audited'}}).allowed,true);
});
test('claiming, claimed, attempting and completing journals prohibit restart',()=>{
  for(const phase of ['claiming','claimed','attempting','completing','unknown',''])
    assert.equal(decision({journal:{phase}}).allowed,false,phase);
});
test('lease or receipt is retained even if phase is incorrectly marked settled',()=>{
  for(const evidence of [{lease:{id:'original'}},{receipt:{operationId:'original'}},{lease:{}},{receipt:{}}])
    assert.deepEqual(decision({journal:{...settled,...evidence}}),
      {allowed:false,reason:'retained_operation_evidence'});
});
test('an unknown host failure cannot be hidden by idle or browser-unavailable status',()=>{
  for(const error of ['Unknown worker termination','Desktop isolation audit failed','Input desktop unavailable']) {
    assert.equal(decision({host:{...host,error}}).allowed,false);
    assert.equal(decision({host:{...host,error},status:{checkedAt:status.checkedAt,state:'blocked',
      failureCode:'browser_unavailable'}}).allowed,false);
  }
});
test('browser unavailable is eligible only as a read-only recovery candidate with a clear journal',()=>{
  const unavailable={checkedAt:status.checkedAt,state:'blocked',failureCode:'browser_unavailable',
    error:'Official page temporarily unavailable',modelCalls:0};
  assert.deepEqual(decision({host:null,status:unavailable}),
    {allowed:true,reason:'browser_unavailable_read_only_recovery_candidate'});
  assert.equal(decision({host:{...host,error:null,exitCode:1},status:unavailable}).allowed,true);
  assert.equal(decision({host:null,status:unavailable,journal:{phase:'attempting'}}).allowed,false);
  assert.equal(decision({host:null,status:{...unavailable,state:null,mode:'idle'}}).allowed,false);
});
test('auth, role, capacity, workspace and unknown failures prohibit restart',()=>{
  for(const failureCode of ['login_expired','role_mismatch','capacity_mismatch','workspace_mismatch',
    'approval_required','member_action','mail_delivery','unknown'])
    assert.equal(decision({status:{checkedAt:status.checkedAt,state:'blocked',failureCode}}).allowed,false,failureCode);
  assert.equal(decision({status:{checkedAt:status.checkedAt,state:'blocked',error:'unknown'}}).allowed,false);
  assert.equal(decision({status:{...status,error:'unclassified error'}}).allowed,false);
});
test('normal exit, stop, disabled state and non-run hosts never restart automatically',()=>{
  assert.equal(decision({host:{...host,state:'exited',error:null,exitCode:0}}).allowed,false);
  assert.equal(decision({host:{...host,state:'running'}}).allowed,false);
  assert.equal(decision({host:{...host,state:'starting'}}).allowed,false);
  for(const mode of ['probe','once','admin'])assert.equal(decision({host:{...host,mode}}).allowed,false);
  assert.equal(decision({status:{...status,state:'stopped'}}).allowed,false);
  for(const mode of ['disabled','dry_run'])assert.equal(decision({status:{...status,mode}}).allowed,false);
});
test('a recent successful audited administrator probe or once allows initial supervised startup after repair',()=>{
  assert.deepEqual(decision({host:probe}),{allowed:true,reason:'administrator_reviewed_start_candidate'});
  assert.equal(decision({host:probe,status:{...status,mode:'processed'}}).allowed,true);
  assert.equal(decision({host:{...probe,mode:'once'}}).allowed,true);
  assert.equal(decision({host:{...probe,mode:'run'}}).allowed,false);
  assert.equal(decision({host:{...probe,checkedAt:new Date(now-15*60*1000).toISOString()}}).allowed,true);
  assert.equal(decision({host:{...probe,checkedAt:new Date(now-15*60*1000-1).toISOString()}}).allowed,false);
});
test('probe evidence cannot override old unknown failures, incomplete operations or stop requests',()=>{
  for(const patch of [{journal:null},{journal:{phase:'attempting'}},{journal:{...settled,lease:{}}},
    {stopRequest:stop},{status:{...status,state:'stopped'}},
    {status:{checkedAt:status.checkedAt,state:'blocked',failureCode:'unknown'}},
    {status:{checkedAt:status.checkedAt,state:'blocked',failureCode:'browser_unavailable'}},
    {status:{...status,error:'unclassified'}},
    {status:{...status,checkedAt:'2026-10-25T11:59:30.000Z'}}])
    assert.equal(decision({host:probe,...patch}).allowed,false,JSON.stringify(patch));
});
test('probe startup requires exact successful desktop isolation evidence',()=>{
  for(const patch of [{exitCode:1},{state:'blocked'},{error:'some failure'},{modelCalls:1},
    {audits:0},{audits:1.5},{maxOwnedWindowsOnInputDesktop:1},{maxOwnedWindowsOnInputDesktop:'0'},
    {desktop:'Default'},{inputDesktop:probe.desktop},{windowAudit:null},
    {windowAudit:{...probe.windowAudit,isolated:false}},
    {windowAudit:{...probe.windowAudit,desktop:'different'}},
    {windowAudit:{...probe.windowAudit,inputDesktop:probe.desktop}},
    {windowAudit:{...probe.windowAudit,ownedWindowsOnInputDesktop:1}}])
    assert.equal(decision({host:{...probe,...patch}}).allowed,false,JSON.stringify(patch));
});
test('an orphaned idle running report is only a candidate after mandatory external dead-PID checks',()=>{
  const orphan={...probe,mode:'run',state:'running',exitCode:undefined,checkedAt:host.checkedAt};
  assert.deepEqual(decision({host:orphan}),{allowed:true,reason:'orphaned_idle_worker_recovery_candidate'});
  assert.equal(decision({host:orphan,status:{...status,mode:'processed'}}).allowed,true);
  // The host writes every five audits; a later clean worker status may survive shutdown.
  assert.equal(decision({host:orphan,status:{...status,checkedAt:'2026-10-23T08:44:06.000Z'}}).allowed,true);
});
test('stale running reports cannot bypass unsettled journals, missing status or unknown faults',()=>{
  const orphan={...probe,mode:'run',state:'running',exitCode:undefined,checkedAt:host.checkedAt};
  for(const patch of [{journal:null},{journal:{phase:'claimed'}},{journal:{phase:'claiming'}},
    {journal:{phase:'attempting'}},{journal:{phase:'completing'}},{journal:{...settled,lease:{id:'original'}}},
    {journal:{...settled,receipt:{operationId:'original'}}},{status:null},
    {status:{...status,state:'stopped'}},{status:{...status,mode:'disabled'}},
    {status:{checkedAt:status.checkedAt,state:'blocked',failureCode:'unknown'}},
    {status:{checkedAt:status.checkedAt,state:'blocked',failureCode:'browser_unavailable'}},
    {status:{...status,error:'unknown'}},{status:{...status,failureCode:'login_expired'}},
    {stopRequest:stop}])assert.equal(decision({host:orphan,...patch}).allowed,false,JSON.stringify(patch));
  for(const patch of [{error:'unknown host fault'},{failureCode:'unknown'},{exitCode:0},
    {processId:null},{processId:0},{modelCalls:1},{audits:0},{maxOwnedWindowsOnInputDesktop:1},
    {windowAudit:null},{windowAudit:{...probe.windowAudit,isolated:false}},
    {windowAudit:{...probe.windowAudit,desktop:'another'}},
    {windowAudit:{...probe.windowAudit,ownedWindowsOnInputDesktop:1}}])
    assert.equal(decision({host:{...orphan,...patch}}).allowed,false,JSON.stringify(patch));
});
test('matching or ambiguous stop requests prevent restarting an intentionally stopped instance',()=>{
  assert.deepEqual(decision({stopRequest:stop}),{allowed:false,reason:'stop_requested_or_ambiguous'});
  assert.equal(decision({host:null,stopRequest:stop}).allowed,false);
  assert.equal(decision({stopRequest:{...stop,target:{...stop.target,pid:6789},
    requestedAt:'2026-10-24T08:00:00.000Z'}}).allowed,false);
});
test('an old valid request for a different PID does not stop a later failed session',()=>{
  assert.equal(decision({stopRequest:{...stop,target:{...stop.target,pid:6789}}}).allowed,true);
});
test('malformed records, timestamps and nonzero model records default to denied',()=>{
  for(const value of [null,[],42,'bad',true])
    assert.deepEqual(restartDecision(value),{allowed:false,reason:'invalid_input'});
  for(const value of [[],0,'bad',true])for(const field of ['host','status','journal','stopRequest'])
    assert.equal(decision({[field]:value}).allowed,false,field);
  for(const patch of [{now:NaN},{now:'2026-10-25T12:00:00Z'},
    {host:{}},{host:{...host,checkedAt:'bad'}},{host:{...host,checkedAt:'2099-01-01T00:00:00Z'}},
    {host:{...host,processId:0}},{host:{...host,modelCalls:1}},{host:{...host,error:42}},
    {status:{}},{status:{...status,checkedAt:'2026-10-23'}},{status:{...status,mode:'unknown'}},
    {journal:{}},{stopRequest:{...stop,id:'bad'}},{stopRequest:{...stop,version:2}},
    {stopRequest:{...stop,target:{pid:0,at:stop.target.at}}},
    {stopRequest:{...stop,requestedAt:'2026-10-22T08:00:00Z'}}])
    assert.equal(decision(patch).allowed,false,JSON.stringify(patch));
});
test('idle alone and a blocked host without a known error do not justify restarting',()=>{
  assert.equal(decision({host:null}).allowed,false);
  assert.equal(decision({host:{...host,error:null}}).allowed,false);
  assert.equal(restartDecision({now,journal:settled}).allowed,false);
});
test('policy does not modify input records',()=>{
  const input={host:structuredClone(host),status:structuredClone(status),journal:structuredClone(settled),now};
  const before=structuredClone(input);restartDecision(input);assert.deepEqual(input,before);
});
