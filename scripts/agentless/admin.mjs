// Explicit administrator CLI for setup/reconciliation. The routine worker never imports this file.
import path from 'node:path';
import {loadConfig,runtimeDir} from './config.mjs';
import {assertExclusive} from './guard.mjs';
import {AgentlessBrowser} from './browser.mjs';
import {PortalClient} from '../seat-executor/portal-client.mjs';
import {bridgeObservation,presence,assertOrdinary} from '../seat-executor/inventory.mjs';
import {Journal,readJson,acquireLock,atomicJson} from './journal.mjs';
import {resumeTestInvite} from './resume-test-invite.mjs';
import {reviewTestWorkspace} from './review-test-workspace.mjs';
import {reviewLiveWorkspace} from './review-live-workspace.mjs';
import {reviewVerifiedOperation} from './review-verified-operation.mjs';
import {safeOfficialDiagnostic} from '../seat-executor/official-readiness.mjs';
const TEST_EMAIL='hit_wangning@outlook.com';

export function assertObservationSetup(plan,config,{prepareTest=false,journalState=null}={}) {
  if(!plan || plan.administrator!==config.adminEmail ||
    (plan.workspaceId && plan.workspaceId!==config.workspaceId))
    throw new Error('门户身份或工作空间不匹配，不能初始化。');
  if(plan.busy || plan.lease || plan.lastError || plan.globalFailureCode || plan.blockedOperations?.length)
    throw new Error('存在未完成租约或故障；请先核对原办理记录，不能用初始化清除故障。');
  if(journalState && journalState.phase!=='settled')
    throw new Error('本机有未结案办理日志；请先核对原租约，不能重新初始化。');
  if(prepareTest && plan.testOnly!==true)
    throw new Error('正式执行器不能通过 prepare-test 切回测试模式。');
}

// Only official reads and the existing evidence endpoint. No claim, member action or test receipt.
export async function refreshOfficialObservation({portal,browser,config,prepareTest=false,journalState=null}) {
  const planOf=value=>value.plan??value;
  const check=plan=>assertObservationSetup(plan,config,{prepareTest,journalState});
  check(planOf(await portal.call('seat_portal_status')));
  const observation=bridgeObservation(await browser.observe());
  // A remote lease may have changed while the two full official snapshots loaded.
  check(planOf(await portal.call('seat_portal_status')));
  const observed=await portal.call('observe_workspace',{observation});
  check(planOf(observed));
  if(!prepareTest)return observed;
  const prepared=await portal.call('prepare_test_request');
  const plan=planOf(prepared);
  check(plan);
  if(plan.enabled!==true || plan.testOnly!==true)
    throw new Error('测试申请未成功启用；保留当前状态，不自行清除或重建申请。');
  return prepared;
}

export function summarizeTestView(payload,config) {
  if(payload?.access!=='allowed' || payload.user?.email?.toLowerCase()!==config.adminEmail ||
      payload.user?.isAdmin!==true || !Array.isArray(payload.view?.requests) || !Array.isArray(payload.view?.notices))
    throw new Error('门户管理员身份或测试状态格式不符。');
  const requests=payload.view.requests.filter(r=>r.isTest===true && r.email?.toLowerCase()===TEST_EMAIL).slice(-10);
  const ids=new Set(requests.map(r=>r.id));
  return {
    testRequests:requests.map(r=>r.id),
    testDetails:requests.map(r=>({id:r.id,status:r.status,expiresAt:r.expiresAt??null,
      invitedAt:r.invitedAt??null,joinDeadlineAt:r.joinDeadlineAt??null})),
    testNotices:payload.view.notices.filter(n=>ids.has(n.requestId) && n.email?.toLowerCase()===TEST_EMAIL)
      .slice(-20).map(n=>({requestId:n.requestId,type:n.type,status:n.status,createdAt:n.createdAt})),
  };
}

async function readTestSummary(portal,config) {
  const page=await portal.open();
  const result=await page.evaluate(async()=>{
    const response=await fetch('/api/portal',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20_000)});
    return {status:response.status,body:await response.json()};
  });
  if(result.status!==200)throw new Error('未能读取已登录管理员的测试状态。');
  return summarizeTestView(result.body,config);
}

// Local diagnostic only: rendered official UI, never credentials, cookies or storage.
export async function saveResumeTestUi(browser,config,file) {
  if(!browser.page)return false;
  const url=new URL(browser.page.url());
  if(url.origin!=='https://admin.openai.com' || url.pathname!==`/workspace/${config.workspaceId}/members`)
    return false;
  const ui=await browser.page.evaluate(()=>{
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
    // Do not capture a credential form even if a future UI embeds one on this origin.
    if([...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')].some(visible))
      return null;
    const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const dialogs=[...document.querySelectorAll('dialog,[role="dialog"]')].filter(visible);
    return {bodyText:(document.body?.innerText??'').slice(0,30_000),
      visibleButtonCount:buttons.length,visibleDialogCount:dialogs.length,
      choices:[...document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]')]
        .filter(visible).slice(0,30).map(e=>({role:e.getAttribute('role'),text:(e.innerText??'').slice(0,500)})),
      inputs:[...document.querySelectorAll('input:not([type="hidden"])')].filter(visible).slice(0,20)
        .map(e=>({type:e.getAttribute('type'),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder')})),
      buttons:buttons.slice(0,100).map(e=>({text:(e.innerText??'').slice(0,500),
        label:(e.getAttribute('aria-label')??'').slice(0,500)})),
      dialogs:dialogs.slice(0,10).map(e=>({text:(e.innerText??'').slice(0,10_000),
        label:(e.getAttribute('aria-label')??'').slice(0,500)}))};
  });
  if(!ui)return false;
  await atomicJson(file,{capturedAt:new Date().toISOString(),page:url.origin+url.pathname,...ui});
  return true;
}

export async function main(args=process.argv.slice(2)) {
const [command,id,...extra]=args;
const commands={status:['seat_portal_status',{}], 'prepare-test':['prepare_test_request',{}],
  'release-test':['release_test_request',{requestId:id}], 'test-reminder':['set_test_deadline',{requestId:id,stage:'reminder'}],
  'test-expire':['set_test_deadline',{requestId:id,stage:'expire'}],
  'enable-live':['set_codex_live',{enabled:true}], 'disable':['set_codex_live',{enabled:false}]};
const withId=['release-test','test-reminder','test-expire'];
if((!commands[command] && !['observe','reconcile','recover-browser','resolve-alert','resume-test-invite','review-test-workspace','review-live-workspace','review-verified-operation'].includes(command)) || extra.length ||
    (!withId.includes(command) && id!==undefined))
  throw new Error('用法：admin.mjs status|observe|prepare-test|release-test ID|test-reminder ID|test-expire ID|enable-live|disable|reconcile|recover-browser|resolve-alert|resume-test-invite|review-test-workspace');
if(withId.includes(command) && !/^req_[a-zA-Z0-9_]+$/.test(id??''))
  throw new Error('必须提供已登记测试申请的 ID。');
const config=await loadConfig();
if(command!=='status') await assertExclusive({...config,liveActions:true});
const release=await acquireLock(path.join(runtimeDir,'worker.lock'));
const browserConfig={...config,liveActions:command==='resume-test-invite'};
const browser=new AgentlessBrowser(browserConfig);
const report={command,requestId:id,startedAt:new Date().toISOString(),modelCalls:0,success:false};
try {
  await browser.open();
  const portal=new PortalClient(browser.context,config,['prepare_test_request','release_test_request',
    'set_test_deadline','set_codex_live','review_seat_failure','verified_review_receipt']);
  if(command==='review-verified-operation') {
    const rawRetry=process.env.NUMEMS_REVIEW_RETRY_EXPECTED;
    const expectedStopDigest=process.env.NUMEMS_REVIEW_STOP_DIGEST;
    if((rawRetry===undefined)!==(expectedStopDigest===undefined))throw new Error('重试和停机票据必须同时提供。');
    let expectedRetry;
    if(rawRetry!==undefined) {
      try {expectedRetry=JSON.parse(rawRetry);} catch {throw new Error('重试票据无效。');}
      if(!expectedRetry || typeof expectedRetry!=='object' || Array.isArray(expectedRetry))throw new Error('重试票据无效。');
    }
    report.result=await reviewVerifiedOperation({portal,browser,config,
      journalFile:path.join(runtimeDir,'operation.json'),statusFile:path.join(runtimeDir,'status.json'),
      expectedRetry,expectedStopDigest});
    console.log(JSON.stringify(report.result,null,2));
  } else if(command==='review-live-workspace') {
    report.result=await reviewLiveWorkspace({portal,browser,config,
      journalFile:path.join(runtimeDir,'operation.json'),statusFile:path.join(runtimeDir,'status.json')});
    console.log(JSON.stringify(report.result,null,2));
  } else if(command==='review-test-workspace') {
    report.result=await reviewTestWorkspace({portal,browser,config:browserConfig,
      journalFile:path.join(runtimeDir,'operation.json')});
    Object.assign(report.result,await readTestSummary(portal,config));
    console.log(JSON.stringify(report.result,null,2));
  } else if(command==='resume-test-invite') {
    report.result=await resumeTestInvite({portal,browser,config:browserConfig,
      journal:new Journal(path.join(runtimeDir,'operation.json'))});
    console.log(JSON.stringify(report.result,null,2));
  } else if(commands[command] || command==='observe') {
    let response;
    if(command==='prepare-test' || command==='observe') {
      response=await refreshOfficialObservation({portal,browser,config,prepareTest:command==='prepare-test',
        journalState:await readJson(path.join(runtimeDir,'operation.json'))});
    } else {
      const [name,arguments_]=commands[command];response=await portal.call(name,arguments_);
    }
    const p=response.plan??response;
    report.result={enabled:p.enabled,testOnly:p.testOnly,busy:p.busy,
      pendingInvites:p.invites?.length,pendingRemovals:p.removals?.length,held:p.blockedOperations?.length,
      testRequests:[...(p.invites??[]),...(p.awaitingAcceptance??[]),...(p.removals??[])].filter(r=>r.isTest).map(r=>r.id)};
    if(['status','observe'].includes(command))Object.assign(report.result,await readTestSummary(portal,config));
    console.log(JSON.stringify(report.result,null,2));
  } else if(command==='recover-browser') {
    const p=(await portal.call('seat_portal_status')).plan;
    if(p.globalFailureCode!=='browser_unavailable' || p.busy || p.lease) throw new Error('此故障不能自动恢复。');
    const observation=bridgeObservation(await browser.observe());
    await portal.call('review_seat_failure',{decision:'recover_browser',observation});
    console.log('已通过最新官方证据恢复；未执行任何成员动作。');
  } else if(command==='resolve-alert') {
    const p=(await portal.call('seat_portal_status')).plan;
    if(p.busy || p.lastError || p.globalFailureCode || p.blockedOperations?.length || p.mailChannelError)
      throw new Error('仍有未完成故障，不能清除告警。');
    const file=path.join(runtimeDir,'alert.json'),a=await readJson(file);
    if(a) await atomicJson(file,{...a,resolvedAt:new Date().toISOString()});
  } else {
    const file=path.join(runtimeDir,'operation.json'),j=await readJson(file);
    const p=(await portal.call('seat_portal_status')).plan;
    if(p.receipts?.some(r=>r.id===j?.lease?.id)) await new Journal(file).settled();
    else {
      const lease=p.lease??p.blockedOperations?.find(h=>h.operation.id===j?.lease?.id)?.operation;
      if(!j?.lease || lease?.id!==j.lease.id || lease.token!==j.lease.token)
        throw new Error('无法匹配原始租约；保留记录，人工核实服务端状态。');
      const snap=await browser.observe();assertOrdinary(snap,lease.email,{config:{protectedEmails:[config.adminEmail]}});
      const state=presence(snap,lease.email);
      const joined=lease.kind==='remove' && lease.originalPresence==='invite' && state==='member';
      if(!(lease.kind==='invite' && state!=='absent') && !(lease.kind==='remove' && state==='absent') && !joined)
        throw new Error('当前官方状态不能证明动作成功；未重做邀请或移除。');
      // Server additionally validates invitation_expired before accepting joined.
      await portal.call('complete_seat_operation',{operationId:lease.id,token:lease.token,
        outcome:joined?'joined':'verified',observation:bridgeObservation(snap),
        ...(j.receipt?.invitationSentAt?{invitationSentAt:j.receipt.invitationSentAt}:{})});
      await new Journal(file).settled();
    }
    console.log('已按原租约和真实证据结案；没有重复执行外部动作。');
  }
  report.success=true;
} catch(error) {
  report.error=error.message;
  const diagnostic=safeOfficialDiagnostic(error);
  if(diagnostic)report.officialFailure=diagnostic;
  if(command==='review-verified-operation' && error.reviewRetry?.phase==='pre_submit' &&
      error.reviewRetry?.reason==='browser_unavailable' && error.reviewRetry?.retryable===true)
    report.reviewRetry=error.reviewRetry;
  if(command==='resume-test-invite') {
    try {report.uiDiagnosticSaved=await saveResumeTestUi(browser,config,
      path.join(runtimeDir,'resume-test-ui.json'));}
    catch {report.uiDiagnosticSaved=false;}
  }
  throw error;
}
finally {
  report.finishedAt=new Date().toISOString();
  try {await atomicJson(path.join(runtimeDir,'admin-result.json'),report);}
  finally {try {await browser.close();}finally {await release();}}
}
return report;
}

if(process.argv[1] && path.resolve(process.argv[1])===import.meta.filename)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
