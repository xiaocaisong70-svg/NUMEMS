import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForOfficialPage,OfficialPageError,safeOfficialDiagnostic} from '../scripts/seat-executor/official-readiness.mjs';

const url='https://admin.openai.com/workspace/00000000-0000-4000-8000-000000000001/members';
const run=async({bodyAt,readyAt,timeoutMs=45_000,challengeTimeoutMs=180_000,urlAt=()=>url})=>{
  let elapsed=0,pauses=0;
  await waitForOfficialPage({stage:'members_navigation',timeoutMs,challengeTimeoutMs,now:()=>elapsed,
    inspect:async()=>({url:urlAt(elapsed),expectedUrl:url+'?secret=should-not-be-retained',body:bodyAt(elapsed),ready:elapsed>=readyAt}),
    pause:async ms=>{pauses++;elapsed+=ms;}});
  return {elapsed,pauses};
};
test('same-page challenge may naturally finish after the old 45 second deadline',async()=>{
  const result=await run({bodyAt:ms=>ms<120_000?'正在进行安全验证':'My Workspace',readyAt:120_000});
  assert.equal(result.elapsed,120_000);assert.equal(result.pauses,120);
});
test('ordinary loading retains 45 second budget and a persistent challenge has a 180 second bound',async()=>{
  for(const [body,expected,state] of [['Loading',45_000,'loading'],['正在进行安全验证',180_000,'challenge']]) {
    let elapsed=0;
    await assert.rejects(waitForOfficialPage({stage:'capacity',timeoutMs:45_000,challengeTimeoutMs:180_000,now:()=>elapsed,
      inspect:async()=>({url,expectedUrl:url+'?token=hidden',body,ready:false}),pause:async ms=>{elapsed+=ms;}}),error=>{
      assert.equal(error.failureCode,'browser_unavailable');
      const d=safeOfficialDiagnostic(error);assert.equal(d.state,state);assert.equal(d.stage,'capacity');
      assert.equal(d.expectedUrl,url);assert.equal(d.observedAt,new Date(expected).toISOString());
      assert.deepEqual(Object.keys(d).sort(),['expectedUrl','observedAt','stage','state','version']);return true;
    });
    assert.equal(elapsed,expected);
  }
});
test('a naturally completed challenge gets one normal loading budget and a hard total limit',async()=>{
  const result=await run({bodyAt:ms=>ms<120_000?'正在进行安全验证':'Loading',readyAt:155_000});
  assert.equal(result.elapsed,155_000);
  let elapsed=0;
  await assert.rejects(waitForOfficialPage({stage:'page',timeoutMs:45_000,challengeTimeoutMs:180_000,now:()=>elapsed,
    inspect:async()=>({url,expectedUrl:url,body:elapsed<170_000?'安全验证':'Loading',ready:false}),pause:async ms=>{elapsed+=ms;}}));
  assert.equal(elapsed,215_000);
});
test('login and workspace redirects still stop immediately without retaining redirected URLs or body',async()=>{
  for(const [actual,state] of [['https://auth.openai.com/log-in?credential=private','login'],[url.replace('00000000','11111111'),'workspace_mismatch']]) {
    await assert.rejects(run({bodyAt:()=>'<html>private-user@example.com</html>',readyAt:Infinity,urlAt:()=>actual}),error=>{
      const d=safeOfficialDiagnostic(error);assert.equal(d.state,state);assert.equal(d.expectedUrl,url);
      assert.equal(JSON.stringify(d).includes('private'),false);return true;
    });
  }
  assert.equal(safeOfficialDiagnostic(Object.assign(new Error('fake'),{officialDiagnostic:{token:'secret'}})),undefined);
  assert.equal(safeOfficialDiagnostic(new OfficialPageError('fake','unknown',{version:1,state:'loading',stage:'evil',expectedUrl:url,observedAt:new Date(0).toISOString()})),undefined);
});
