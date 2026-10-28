import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForOfficialPage,officialPageState,OfficialReadCancelled} from '../scripts/seat-executor/official-readiness.mjs';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
const url='https://admin.openai.com/workspace/00000000-0000-4000-8000-000000000001/members';

test('pre-claim natural challenge waiting stops without failure classification or provider clicks',async()=>{
  let elapsed=0,reads=0;const progress=[];
  await assert.rejects(waitForOfficialPage({stage:'members_navigation',challengeTimeoutMs:180000,
    now:()=>elapsed,shouldStop:async()=>elapsed>=2000,
    inspect:async()=>{reads++;return {url,expectedUrl:url+'?credential=private',body:'完成验证 secret-user@example.com',ready:false};},
    pause:async ms=>{elapsed+=ms;},onProgress:async value=>progress.push(value)}),error=>{
      assert.ok(error instanceof OfficialReadCancelled);assert.equal(error.code,'OFFICIAL_READ_CANCELLED');
      assert.equal(error.failureCode,undefined);return true;
    });
  assert.equal(elapsed,2000);assert.equal(reads,2);
  assert.equal(progress.length,2);
  for(const p of progress){assert.equal(p.state,'challenge');assert.equal(p.expectedUrl,url);assert.equal(JSON.stringify(p).includes('private'),false);assert.equal(JSON.stringify(p).includes('secret-user'),false);}
});

test('stop arriving during inspection prevents accepting a ready result',async()=>{
  let stop=false;
  await assert.rejects(waitForOfficialPage({shouldStop:async()=>stop,
    inspect:async()=>{stop=true;return {url,expectedUrl:url,body:'My Workspace',ready:true};},pause:async()=>{throw new Error('must not pause');}}),OfficialReadCancelled);
});

test('recognized Chinese verification prompts are challenges even beside stale ready markup',()=>{
  for(const body of ['完成验证','验证您是真人','验证您不是自动程序'])
    assert.equal(officialPageState({url,expectedUrl:url,body,ready:true}),'browser_unavailable');
});

test('observation-only controls are restored after success and failure',async()=>{
  for(const fail of [false,true]){
    const browser=new BrowserAdapter({});const previous={onProgress:async()=>{}};
    browser.readOnlyWaitControls=previous;
    const shouldStop=async()=>false;
    browser.observeStable=async()=>{
      assert.equal(browser.readOnlyWaitControls.shouldStop,shouldStop);
      if(fail)throw new Error('read failed');return 'verified';
    };
    if(fail)await assert.rejects(browser.observe({shouldStop}),/read failed/);
    else assert.equal(await browser.observe({shouldStop}),'verified');
    assert.equal(browser.readOnlyWaitControls,previous);
  }
});
