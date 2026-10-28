import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {restartDecision} from '../scripts/agentless/watchdog-policy.mjs';
import {supervise,readEvidenceSnapshot} from '../scripts/agentless/watchdog.mjs';

const now=Date.parse('2026-10-27T12:05:00Z');
const host={mode:'admin',adminCommand:'review-verified-operation',state:'exited',exitCode:0,
  checkedAt:'2026-10-27T12:04:50Z',processId:1234,modelCalls:0,audits:3,
  desktop:'NUMEMS-Agentless-test123',inputDesktop:'Default',maxOwnedWindowsOnInputDesktop:0,
  windowAudit:{isolated:true,desktop:'NUMEMS-Agentless-test123',inputDesktop:'Default',ownedWindowsOnInputDesktop:0}};
const status={checkedAt:'2026-10-27T12:04:40Z',mode:'idle',modelCalls:0,liveActions:true,
  reviewEvidence:{failureId:'failure_123',targetId:'req_123',operationId:'op_123',
    previousStatusAt:'2026-10-27T12:00:00Z',firstObservedAt:'2026-10-27T12:04:10Z',
    secondObservedAt:'2026-10-27T12:04:20Z',workspaceReviewedAt:'2026-10-27T12:04:30Z'}};
const adminResult={command:'review-verified-operation',success:true,modelCalls:0,
  startedAt:'2026-10-27T12:04:00Z',finishedAt:'2026-10-27T12:04:45Z',
  result:{outcome:'reviewed',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0,source:'fresh_review'}};
const journal={phase:'settled',target:{targetId:'req_123',kind:'invite',email:'person@qa.invalid'}};
const reviewIntent={version:1,phase:'settled',failureId:'failure_123',targetId:'req_123',operationId:'op_123',
  journalDigest:createHash('sha256').update(JSON.stringify(journal)).digest('hex'),statusDigest:'b'.repeat(64),previousStatusAt:status.reviewEvidence.previousStatusAt,
  firstObservedAt:status.reviewEvidence.firstObservedAt,secondObservedAt:status.reviewEvidence.secondObservedAt,
  reviewedAt:status.reviewEvidence.workspaceReviewedAt};
const base={host,status,adminResult,journal,reviewIntent,intentDigest:'c'.repeat(64),now};
test('only fresh successfully audited exact review permits guarded startup',()=>{
  assert.deepEqual(restartDecision(base),{allowed:true,reason:'reviewed_verified_operation_start_candidate'});
  for(const patch of [
    {host:{...host,adminCommand:'reconcile'}},{host:{...host,state:'running'}},{host:{...host,exitCode:1}},
    {host:{...host,maxOwnedWindowsOnInputDesktop:1}},{host:{...host,windowAudit:null}},
    {host:{...host,checkedAt:'2026-10-27T12:04:42Z'}},{host:{...host,checkedAt:'2026-10-27T12:05:01Z'}},
    {adminResult:null},{adminResult:{...adminResult,command:'reconcile'}},
    {adminResult:{...adminResult,success:false}},{adminResult:{...adminResult,modelCalls:1}},
    {adminResult:{...adminResult,result:{...adminResult.result,officialSnapshots:1}}},
    {adminResult:{...adminResult,result:{...adminResult.result,memberActions:1}}},
    {status:{...status,state:'blocked'}},{status:{...status,liveActions:false}},
    {status:{...status,reviewEvidence:{...status.reviewEvidence,operationId:'bad'}}},
    {reviewIntent:null},{reviewIntent:{...reviewIntent,phase:'submitted'}},
    {reviewIntent:{...reviewIntent,targetId:'req_other'}},{intentDigest:'absent'},
    {reviewIntent:{...reviewIntent,journalDigest:'b'.repeat(64)}},
    {adminResult:{...adminResult,result:{...adminResult.result,source:'unknown'}}},
    {status:{...status,reviewEvidence:{...status.reviewEvidence,workspaceReviewedAt:'2026-10-27T12:04:19Z'}}},
    {journal:null},{journal:{phase:'attempting'}},{journal:{...journal,lease:{}}},
    {journal:{...journal,receipt:{}}},{now:now+16*60*1000},
    {stopRequest:{version:1,id:'12345678-1234-1234-1234-123456789012',requestedAt:'2026-10-27T12:04:51Z',target:{pid:1234,at:'2026-10-27T12:04:00Z'}}},
  ]) assert.equal(restartDecision({...base,...patch}).allowed,false,JSON.stringify(patch));
});
test('receipt recovery accepts earlier persisted snapshots only with exact settled intent',()=>{
  const recovered={...adminResult,startedAt:'2026-10-27T12:04:35Z',
    result:{...adminResult.result,source:'receipt_recovery'}};
  assert.equal(restartDecision({...base,adminResult:recovered}).allowed,true);
  assert.equal(restartDecision({...base,adminResult:{...recovered,result:{...recovered.result,source:'fresh_review'}}}).allowed,false);
  assert.equal(restartDecision({...base,adminResult:recovered,reviewIntent:{...reviewIntent,phase:'submitted'}}).allowed,false);
  assert.equal(restartDecision({...base,adminResult:recovered,journal:{...journal,target:{...journal.target,targetId:'req_other'}}}).allowed,false);
});
test('watchdog still checks isolated desktop and passes review decision to worker',async()=>{
  const calls=[];
  const result=await supervise({...base,config:{liveActions:true,browserMode:'isolated_desktop',headless:false,legacyCheckerDisabled:true},
    now:()=>new Date(now),save:async()=>{},run:async(kind,decision)=>{
      calls.push([kind,decision?.reason]);return kind==='desktop'?{windowStation:'WinSta0',inputDesktop:'Default'}:null;
    }});
  assert.equal(result.state,'worker_exited');
  assert.deepEqual(calls,[['desktop',undefined],['worker','reviewed_verified_operation_start_candidate']]);
});
test('evidence hashes are derived from exact bytes and absent files are not valid proofs',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-evidence-'));
  try {
    assert.equal((await readEvidenceSnapshot(dir,'status.json')).digest,'absent');
    await writeFile(path.join(dir,'status.json'),'{"mode":"idle"}');
    const first=await readEvidenceSnapshot(dir,'status.json');
    await writeFile(path.join(dir,'status.json'),'{ "mode":"idle" }');
    const second=await readEvidenceSnapshot(dir,'status.json');
    assert.deepEqual(first.value,second.value);assert.notEqual(first.digest,second.digest);
    await assert.rejects(readEvidenceSnapshot(dir,'../outside.json'));
  } finally {await rm(dir,{recursive:true,force:true});}
});
