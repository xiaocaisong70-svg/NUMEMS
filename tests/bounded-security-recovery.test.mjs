import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {waitForOfficialPage,OfficialPageError,safeOfficialDiagnostic,officialDiagnostic} from '../scripts/seat-executor/official-readiness.mjs';
import {BrowserAdapter} from '../scripts/seat-executor/browser.mjs';
import {recoverBrowser} from '../scripts/agentless/recovery.mjs';
import {PortalReadUnavailable} from '../scripts/seat-executor/portal-client.mjs';

const url='https://admin.openai.com/workspace/workspace/members';
const diag=(state,at=0)=>officialDiagnostic({state,expectedUrl:url,at});

async function readiness({controlAt=()=>false,bodyAt=()=> 'Checking your browser',readyAt=Infinity,deadlineAt=90000}={}) {
  let elapsed=0;const progress=[];
  const promise=waitForOfficialPage({stage:'members_navigation',now:()=>elapsed,deadlineAt,challengeTimeoutMs:20000,
    inspect:async()=>({url,expectedUrl:url,body:bodyAt(elapsed),interactionRequired:controlAt(elapsed),ready:elapsed>=readyAt}),
    pause:async ms=>{elapsed+=ms;},onProgress:async value=>progress.push(value)});
  return {promise,progress,elapsed:()=>elapsed};
}

test('generic security page naturally passes without implying human interaction',async()=>{
  for(const text of ['Checking your browser','Verify you are human','正在进行安全验证']) {
    const f=await readiness({bodyAt:ms=>ms<6000?text:'My Workspace',readyAt:6000});
    await f.promise;assert.equal(f.elapsed(),6000);
    assert.ok(f.progress.every(p=>p.state==='challenge'));
  }
});

test('a persistent generic challenge exhausts neutrally, never as interaction_required',async()=>{
  const f=await readiness();
  await assert.rejects(f.promise,error=>{
    assert.equal(error.failureCode,'browser_unavailable');assert.equal(safeOfficialDiagnostic(error).state,'challenge');return true;
  });
  assert.equal(f.elapsed(),20000);assert.ok(f.progress.every(p=>p.state==='challenge'));
});

test('only a visible control stable through passive grace proves interaction is required',async()=>{
  const f=await readiness({controlAt:()=>true});
  await assert.rejects(f.promise,error=>{
    assert.equal(error.failureCode,'browser_unavailable');assert.equal(safeOfficialDiagnostic(error).state,'interaction_required');return true;
  });
  assert.equal(f.elapsed(),15000);assert.equal(f.progress.at(-1).state,'interaction_required');
  const transient=await readiness({controlAt:ms=>ms<7000,bodyAt:ms=>ms<12000?'Checking your browser':'My Workspace',readyAt:12000});
  await transient.promise;assert.equal(transient.elapsed(),12000);
  assert.ok(transient.progress.every(p=>p.state==='challenge'));
});

test('an absolute observation deadline clips challenge/loading budgets across successive stages',async()=>{
  let elapsed=0;const pause=async ms=>{elapsed+=ms;};
  await waitForOfficialPage({now:()=>elapsed,deadlineAt:12000,challengeTimeoutMs:20000,pause,
    inspect:async()=>({url,expectedUrl:url,body:elapsed<7000?'Checking your browser':'My Workspace',ready:elapsed>=7000})});
  assert.equal(elapsed,7000);
  await assert.rejects(waitForOfficialPage({now:()=>elapsed,deadlineAt:12000,challengeTimeoutMs:20000,pause,
    inspect:async()=>({url,expectedUrl:url,body:'Checking your browser',ready:false})}),OfficialPageError);
  assert.equal(elapsed,12000);
  await assert.rejects(waitForOfficialPage({now:()=>elapsed,deadlineAt:11999,pause,
    inspect:async()=>({url,expectedUrl:url,body:'My Workspace',ready:true})}),OfficialPageError);
});

test('verification control detection reads only known visible unchecked controls and never clicks',async()=>{
  const browser=new BrowserAdapter({workspaceId:'workspace'});let clicks=0;
  const control={getAttribute:async()=>null,isChecked:async()=>false,click:async()=>{clicks++;}};
  const locator={filter(options){assert.deepEqual(options,{visible:true});return this;},count:async()=>1,first:()=>control};
  const page={url:()=>url,getByRole(role,{name}){assert.equal(role,'checkbox');assert.ok(name.test('Verify you are human'));return locator;}};
  browser.page=page;
  assert.equal(await browser.challengeInteraction('Checking your browser'),true);
  assert.equal(clicks,0);
  control.isChecked=async()=>true;assert.equal(await browser.challengeInteraction('Checking your browser'),false);
  control.isChecked=async()=>{throw new Error('element detached');};assert.equal(await browser.challengeInteraction('Checking your browser'),false);
  control.getAttribute=async()=> 'false';assert.equal(await browser.challengeInteraction('Checking your browser'),true);
  control.isChecked=async()=>false;assert.equal(await browser.challengeInteraction('My Workspace'),false);
  page.frames=()=>[{url:()=> 'https://unexpected.example/verification',getByRole(){throw new Error('must not inspect untrusted frame');}}];
  assert.equal(await browser.challengeInteraction('Checking your browser'),false);assert.equal(clicks,0);
});

test('full double snapshots share one budget and never accept a late or unstable result',async()=>{
  const config={workspaceId:'workspace',workspaceName:'My Workspace',adminEmail:'owner@example.com',totalSeats:4,seatLabel:'高级'};
  for(const mode of ['stable','late','changed']) {
    let elapsed=0,reads=0;const browser=new BrowserAdapter(config),deadlines=[];
    browser.snapshot=async()=>{
      reads++;deadlines.push(browser.readOnlyWaitControls.deadlineAt);elapsed+=mode==='late'?35000:10000;
      return {complete:true,...config,accountEmail:config.adminEmail,pageUrl:url,observedAt:new Date().toISOString(),
        members:[{email:config.adminEmail,role:'owner',seatLabel:config.seatLabel}],
        invites:mode==='changed'&&reads===2?[{email:'staff@example.com',role:'member',seatLabel:config.seatLabel}]:[]};
    };
    const promise=browser.observe({budgetMs:60000,now:()=>elapsed});
    if(mode==='stable')assert.equal((await promise).complete,true);
    else await assert.rejects(promise,error=>error.failureCode==='browser_unavailable');
    assert.equal(reads,2);assert.deepEqual(deadlines,[60000,60000]);
    assert.equal(browser.readOnlyWaitControls,undefined);
  }
});

async function recoveryFixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'numems-bounded-recovery-')),journalFile=path.join(dir,'journal.json');
  t.after(async()=>{await unlink(journalFile).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(dir);});
  let instant=0;const calls=[],incidents=[],reports=[],observations=[];
  const plan={globalFailureCode:'browser_unavailable',globalFailureId:'failure-1',browserRecovery:{eligible:true},busy:false,lease:null,
    workspaceId:'workspace',administrator:'owner@example.com'};
  const snapshot=()=>({workspaceId:'workspace',accountEmail:'owner@example.com',totalSeats:4,
    members:[{email:'owner@example.com',role:'owner'}],invites:[],observedAt:new Date(instant).toISOString(),pageUrl:url});
  const args={journalFile,config:{workspaceId:'workspace',adminEmail:'owner@example.com'},clock:()=>new Date(instant),
    pause:async ms=>{instant+=ms;},saveStatus:async value=>reports.push(value),onIncident:async value=>incidents.push(value),
    portal:{call:async(name,body)=>{calls.push({name,body});return {plan:name==='review_seat_failure'?{}:structuredClone(plan)};}},
    browser:{observe:async options=>{observations.push(options);return snapshot();}}};
  return {args,plan,calls,incidents,reports,observations,snapshot,advance:ms=>{instant+=ms;},instant:()=>instant,
    journal:async value=>writeFile(journalFile,JSON.stringify(value))};
}
const unavailable=state=>new OfficialPageError('official page unavailable','browser_unavailable',diag(state));

test('one standard context restart is bracketed by fresh guards and does not repeat member actions',async t=>{
  const f=await recoveryFixture(t);let restarts=0,reads=0;
  f.args.restartBrowser=async options=>{restarts++;assert.equal(options.failureId,'failure-1');assert.ok(options.budgetMs<=90000);
    assert.equal(f.calls.at(-1).name,'seat_portal_status');};
  f.args.browser.observe=async options=>{f.observations.push(options);if(++reads<3)throw unavailable('challenge');return f.snapshot();};
  assert.equal(await recoverBrowser(f.args),true);assert.equal(restarts,1);assert.equal(reads,3);
  assert.equal(f.calls.filter(c=>c.name==='review_seat_failure').length,1);
  assert.ok(f.calls.every(c=>['seat_portal_status','review_seat_failure'].includes(c.name)));
  assert.ok(f.observations.every(o=>o.deadlineAt===90000));
  assert.equal(f.incidents.some(i=>i.classification==='interaction_required'),false);
});

test('new claim, unresolved journal, changed failure or changed identity blocks any restart/review',async t=>{
  for(const change of ['claim','journal','failure','identity']) {
    const f=await recoveryFixture(t);let restarts=0;
    f.args.restartBrowser=async()=>{restarts++;};
    f.args.browser.observe=async()=>{
      if(change==='claim')f.plan.lease={id:'new-lease'};
      if(change==='journal')await f.journal({phase:'attempting',receipt:{outcome:'unknown'}});
      if(change==='failure')f.plan.globalFailureId='new-failure';
      if(change==='identity')f.plan.administrator='someone@example.com';
      throw unavailable('challenge');
    };
    assert.equal(await recoverBrowser(f.args),false);assert.equal(restarts,0);
    assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
  }
});

test('a claim arriving during a normal context restart prevents subsequent observation/review',async t=>{
  const f=await recoveryFixture(t);let reads=0,restarts=0;
  f.args.restartBrowser=async()=>{restarts++;f.plan.lease={id:'other-worker'};};
  f.args.browser.observe=async()=>{reads++;throw unavailable('challenge');};
  assert.equal(await recoverBrowser(f.args),false);assert.equal(restarts,1);assert.equal(reads,1);
  assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
});

test('stop arriving while reconnect status is saved prevents the context restart',async t=>{
  const f=await recoveryFixture(t);let stopped=false,restarts=0,reads=0;
  f.args.shouldStop=async()=>stopped;
  f.args.saveStatus=async report=>{if(report.phase==='reconnecting')stopped=true;};
  f.args.restartBrowser=async()=>{restarts++;};
  f.args.browser.observe=async()=>{reads++;throw unavailable('challenge');};
  assert.deepEqual(await recoverBrowser(f.args),{stopped:true});
  assert.equal(restarts,0);assert.equal(reads,1);assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
});

test('persistent challenge uses one total 90-second budget, remains neutral and never writes a late recovery',async t=>{
  const f=await recoveryFixture(t);let reads=0;
  f.args.browser.observe=async options=>{reads++;assert.ok(options.budgetMs<=30000);
    f.advance(options.budgetMs);throw unavailable('challenge');};
  assert.equal(await recoverBrowser(f.args),false);assert.equal(f.instant(),90000);assert.equal(reads,3);
  assert.equal(f.incidents.at(-1).phase,'exhausted');assert.equal(f.incidents.at(-1).classification,'security_check');
  assert.equal(f.reports.at(-1).phase,'exhausted');assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
  const late=await recoveryFixture(t);
  late.args.browser.observe=async()=>{late.advance(91000);return late.snapshot();};
  assert.equal(await recoverBrowser(late.args),false);assert.ok(late.calls.every(c=>c.name==='seat_portal_status'));
});

test('every cloud recovery guard shares the read deadline and no late guard can clear a fault',async t=>{
  const f=await recoveryFixture(t),calls=[];let reads=0;
  f.args.portal.call=async(name,args,controls)=>{
    calls.push(name);assert.equal(name,'seat_portal_status');assert.deepEqual(args,{});
    assert.equal(controls.deadlineAt,90000);assert.equal(controls.budgetMs,90000-f.instant());
    assert.equal(controls.now(),f.instant());
    if(++reads===3){f.advance(90000-f.instant());f.plan.globalFailureCode='unknown';f.plan.globalFailureId='new-fault';}
    return {plan:structuredClone(f.plan)};
  };
  assert.equal(await recoverBrowser(f.args),false);assert.equal(reads,3);
  assert.deepEqual(calls,['seat_portal_status','seat_portal_status','seat_portal_status']);
  assert.equal(f.plan.globalFailureCode,'unknown');assert.equal(f.plan.globalFailureId,'new-fault');
});

test('a typed guard read timeout propagates unchanged without retries or recovery writes',async t=>{
  const f=await recoveryFixture(t);let reads=0,observations=0;
  const error=new PortalReadUnavailable({stage:'status',requestedOperation:'seat_portal_status',requestNotSent:false,readOnly:true,reason:'timeout'});
  f.args.portal.call=async(name,_args,controls)=>{reads++;assert.equal(name,'seat_portal_status');
    assert.equal(controls.deadlineAt,90000);throw error;};
  f.args.browser.observe=async()=>{observations++;return f.snapshot();};
  await assert.rejects(recoverBrowser(f.args),actual=>actual===error);
  assert.equal(reads,1);assert.equal(observations,0);
});

test('explicit verified interaction stops automatic restart and does not claim a generic human failure',async t=>{
  const f=await recoveryFixture(t);let restarts=0;
  f.args.restartBrowser=async()=>{restarts++;};f.args.browser.observe=async()=>{throw unavailable('interaction_required');};
  assert.equal(await recoverBrowser(f.args),false);assert.equal(restarts,0);
  assert.equal(f.incidents.at(-1).classification,'interaction_required');
  assert.equal(f.reports.at(-1).phase,'interaction_required');assert.ok(f.calls.every(c=>c.name==='seat_portal_status'));
});

test('a historical interaction diagnostic cannot replace current evidence or stop passive recovery',async t=>{
  const f=await recoveryFixture(t);let reads=0;
  f.args.initialDiagnostic=diag('interaction_required');
  f.args.browser.observe=async()=>{if(++reads===1)throw new OfficialPageError('loading','browser_unavailable');return f.snapshot();};
  assert.equal(await recoverBrowser(f.args),true);assert.equal(reads,2);
  assert.equal(f.incidents.some(i=>i.phase==='interaction_required'),false);
  assert.equal(f.incidents.some(i=>i.classification==='interaction_required'),false);
});

test('login remains a distinct fatal classification and retains the original error',async t=>{
  const f=await recoveryFixture(t),error=new OfficialPageError('login expired','login_expired',diag('login'));
  f.args.browser.observe=async()=>{throw error;};
  await assert.rejects(recoverBrowser(f.args),actual=>actual===error);
  assert.equal(f.incidents.at(-1).classification,'login_required');
});
