import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewRetryDecision} from '../scripts/agentless/watchdog-policy.mjs';
import {supervise} from '../scripts/agentless/watchdog.mjs';

const now=Date.parse('2026-10-27T12:06:00Z');
const host={mode:'admin',adminCommand:'review-verified-operation',state:'blocked',exitCode:1,
  checkedAt:'2026-10-27T12:04:50Z',processId:1234,modelCalls:0,audits:3,
  desktop:'NUMEMS-Agentless-test123',inputDesktop:'Default',maxOwnedWindowsOnInputDesktop:0,
  windowAudit:{isolated:true,desktop:'NUMEMS-Agentless-test123',inputDesktop:'Default',ownedWindowsOnInputDesktop:0}};
const status={checkedAt:'2026-10-27T12:00:00Z',state:'blocked',failureCode:'browser_unavailable',modelCalls:0};
const adminResult={command:'review-verified-operation',success:false,modelCalls:0,
  startedAt:'2026-10-27T12:04:00Z',finishedAt:'2026-10-27T12:04:45Z',
  reviewRetry:{phase:'pre_submit',failureId:'failure_123',targetId:'req_123',operationId:'op_123',reason:'browser_unavailable',retryable:true,
    statusCheckedAt:'2026-10-27T12:00:00Z',statusFailureCode:'browser_unavailable'}};
const journal={phase:'settled',target:{targetId:'req_123',kind:'invite',email:'person@qa.invalid'}};
const base={host,status,adminResult,journal,now,intentDigest:'absent'};
test('only proven pre-submit read-only failure becomes a bounded review candidate',()=>{
  assert.deepEqual(reviewRetryDecision(base),{allowed:true,reason:'review_pre_submit_retry_candidate',
    failureId:'failure_123',targetId:'req_123',operationId:'op_123',attempts:1});
  assert.equal(reviewRetryDecision({...base,now:now-11_000}).reason,'review_retry_backoff');
  for(const patch of [
    {host:{...host,mode:'probe'}},{host:{...host,state:'running'}},{host:{...host,exitCode:0}},
    {host:{...host,error:'unclassified failure'}},{host:{...host,windowAudit:null}},
    {status:{...status,failureCode:'unknown'}},{status:{...status,state:'recovering'}},
    {journal:{phase:'attempting'}},{journal:{...journal,lease:{}}},{journal:{...journal,receipt:{}}},
    {journal:{...journal,target:{...journal.target,targetId:'req_other'}}},
    {lock:{pid:333,at:'2026-10-27T12:04:00Z'}},{adminResult:{...adminResult,success:true}},
    {adminResult:{...adminResult,reviewRetry:null}},
    {adminResult:{...adminResult,reviewRetry:{...adminResult.reviewRetry,phase:'post_submitted'}}},
    {adminResult:{...adminResult,reviewRetry:{...adminResult.reviewRetry,reason:'unknown'}}},
    {adminResult:{...adminResult,reviewRetry:{...adminResult.reviewRetry,operationId:'bad'}}},
    {adminResult:{...adminResult,reviewRetry:{...adminResult.reviewRetry,statusCheckedAt:'different'}}},
    {intentDigest:'some-submitted-intent-hash'},
    {stopRequest:{version:1,id:'12345678-1234-1234-1234-123456789012',requestedAt:'2026-10-27T12:04:51Z',target:{pid:1234,at:'2026-10-27T12:04:00Z'}}},
  ]) assert.equal(reviewRetryDecision({...base,...patch}).allowed,false,JSON.stringify(patch));
});
test('unknown outcome after retry never repeats, and bounded backoff stops after five attempts',()=>{
  const previous={version:1,failureId:'failure_123',targetId:'req_123',operationId:'op_123',attempts:1,issuedAt:'2026-10-27T12:04:30Z'};
  assert.equal(reviewRetryDecision({...base,retryRecord:previous}).reason,'review_retry_unresolved');
  const failedAgain={...base,adminResult:{...adminResult,startedAt:'2026-10-27T12:04:40Z'},now:Date.parse('2026-10-27T12:07:00Z')};
  assert.equal(reviewRetryDecision({...failedAgain,retryRecord:previous}).attempts,2);
  assert.equal(reviewRetryDecision({...failedAgain,retryRecord:{...previous,attempts:5}}).reason,'review_retry_limit_reached');
  assert.equal(reviewRetryDecision({...base,retryRecord:{...previous,attempts:6}}).reason,'review_retry_record_invalid');
});
test('supervisor invokes only guarded review and desktop checks, not member worker',async()=>{
  const calls=[];
  const result=await supervise({...base,config:{liveActions:true,browserMode:'isolated_desktop',headless:false,legacyCheckerDisabled:true},
    now:()=>new Date(now),save:async()=>{},run:async(kind,decision)=>{
      calls.push([kind,decision?.reason]);return kind==='desktop'?{windowStation:'WinSta0',inputDesktop:'Default'}:null;
    }});
  assert.equal(result.state,'review_exited');
  assert.deepEqual(calls,[['desktop',undefined],['review','review_pre_submit_retry_candidate']]);
});
