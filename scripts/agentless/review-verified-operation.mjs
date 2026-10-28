// Explicit, one-incident review. This path performs only official reads and a
// guarded failure review; it never claims or performs a membership action.
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile,copyFile,unlink,mkdir} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {readJson,atomicJson} from './journal.mjs';
import {validateConfig} from './config.mjs';
import {validateObservation,bridgeObservation} from '../seat-executor/inventory.mjs';
import {OfficialPageError} from '../seat-executor/official-readiness.mjs';

const DIAGNOSTIC='程序办理未完成；保留原租约和证据，不自动重做外部动作。';
const planOf=value=>value.plan??value;
function stablePlan(plan){const copy=structuredClone(plan);delete copy.checkedAt;return copy;}
function assertPlan(plan,local,config,recovered=false) {
  validateConfig(config);
  if(config.liveActions!==true || config.legacyCheckerDisabled!==true ||
     plan?.administrator!==config.adminEmail || plan.workspaceId!==config.workspaceId ||
     plan.enabled!==true || plan.testOnly!==false || plan.busy!==false || plan.lease!=null ||
     !Array.isArray(plan.blockedOperations) || plan.blockedOperations.length || plan.mailChannelError ||
     (recovered ? Boolean(plan.globalFailureCode || plan.lastError) :
       plan.globalFailureCode!=='unknown' || plan.lastError!==DIAGNOSTIC ||
       typeof plan.globalFailureId!=='string' || !plan.globalFailureId))
    throw new Error('工作空间故障、身份或其他未结案事项不符合限定恢复条件。');
  if(!local || local.phase!=='settled' || local.lease || local.receipt ||
     !local.target || !['invite','remove'].includes(local.target.kind) ||
     typeof local.target.targetId!=='string' || typeof local.target.email!=='string' ||
     !Number.isFinite(Date.parse(local.createdAt)))
    throw new Error('本机原操作记录缺失、不完整或未结案，不能恢复。');
}
function matchingReceipt(plan,local) {
  const target=local.target;
  const matches=(plan.receipts??[]).filter(r=>
    (r.kind===target.kind || target.kind==='remove' && r.kind==='joined_during_revocation') &&
    r.email===target.email && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at)>=Date.parse(local.createdAt));
  if(matches.length!==1 || typeof matches[0].id!=='string' || !matches[0].id)
    throw new Error('不能唯一关联本机原操作与云端已核实回执，保持暂停。');
  return matches[0];
}
function strictSnapshot(s,config,now){
  validateObservation(s,config,now);
  if(s.members.some(p=>p.email!==config.adminEmail && p.role!=='member') || s.invites.some(p=>p.role!=='member'))
    throw new Error('官方名单存在额外管理角色，不能恢复。');
  return s;
}
function inventory(s){
  const order=(a,b)=>a.email.localeCompare(b.email);
  return {workspaceId:s.workspaceId,workspaceName:s.workspaceName,accountEmail:s.accountEmail,
    totalSeats:s.totalSeats,seatLabel:s.seatLabel,members:structuredClone(s.members).sort(order),
    invites:structuredClone(s.invites).sort(order)};
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intentPath = file => path.join(path.dirname(file),'verified-review-intent.json');
async function stopDigest(journalFile) {
  try { return createHash('sha256').update(await readFile(path.join(path.dirname(journalFile),'stop-request.json'))).digest('hex'); }
  catch(error) { if(error?.code==='ENOENT')return 'absent'; throw error; }
}
async function assertStopUnchanged(journalFile,expected) {
  if(await stopDigest(journalFile)!==expected) throw new Error('复核期间停机请求发生变化，保持暂停。');
}
async function readIntent(file) {
  try {
    const value=JSON.parse(await readFile(file,'utf8'));
    if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('复核意图文件无效，保持暂停。');
    return value;
  } catch(error) { if(error?.code==='ENOENT')return null; throw error; }
}
async function archiveSettledForNewFailure({portal,config,journalFile,statusFile,intentFile,intent}) {
  const {failureId,targetId,operationId}=intent;
  if(intent.version!==1 || intent.phase!=='settled' ||
     !/^codex_[a-zA-Z0-9_]{1,140}$/.test(failureId??'') ||
     !/^req_[a-zA-Z0-9_]{1,140}$/.test(targetId??'') ||
     !/^op_[a-zA-Z0-9_-]{1,140}$/.test(operationId??''))throw new Error('历史复核意图无效。');
  const previous=(await portal.call('verified_review_receipt',{failureId,targetId,operationId}))?.receipt;
  if(!previous || previous.failureId!==failureId || previous.targetId!==targetId || previous.operationId!==operationId ||
     previous.workspaceId!==config.workspaceId || previous.reviewedAt!==intent.reviewedAt ||
     previous.observedAt!==intent.secondObservedAt)throw new Error('历史复核回执不能确认，保持暂停。');
  const plan=planOf(await portal.call('seat_portal_status'));
  const local=await readJson(journalFile),status=await readJson(statusFile);
  assertPlan(plan,local,config);
  if(plan.globalFailureId===failureId || status?.state!=='blocked' || status.modelCalls!==0)
    throw new Error('仅可为不同的新故障归档已结案复核。');
  matchingReceipt(plan,local);
  const dir=path.join(path.dirname(intentFile),'verified-review-history');
  const dest=path.join(dir,`${failureId}-${operationId}.json`);
  await mkdir(dir,{recursive:true});
  try {await copyFile(intentFile,dest,fsConstants.COPYFILE_EXCL);}
  catch(error) {if(error?.code!=='EEXIST')throw error;}
  if(!isDeepStrictEqual(await readIntent(dest),intent))throw new Error('历史复核存档冲突，保持暂停。');
  const finalPlan=planOf(await portal.call('seat_portal_status'));
  assertPlan(finalPlan,await readJson(journalFile),config);
  if(!isDeepStrictEqual(stablePlan(finalPlan),stablePlan(plan)) ||
     !isDeepStrictEqual(await readJson(journalFile),local) ||
     !isDeepStrictEqual(await readJson(statusFile),status) || !isDeepStrictEqual(await readIntent(intentFile),intent))
    throw new Error('归档时故障或本机证据变化，保持暂停。');
  await unlink(intentFile);
}

// A submitted intent is never retransmitted. A missing receipt is ambiguous,
// including when the server could still be processing the original request.
export async function recoverVerifiedReviewIntent({portal,config,journalFile,statusFile,clock=Date.now,writeStatus=atomicJson,expectedStopDigest}) {
  const stop=expectedStopDigest??await stopDigest(journalFile);
  await assertStopUnchanged(journalFile,stop);
  const file=intentPath(journalFile),intent=await readIntent(file);
  if(!intent || intent.version!==1 || intent.phase!=='submitted')
    throw new Error('复核意图不存在或状态不明，保持暂停。');
  const {failureId,targetId,operationId}=intent;
  if(!/^codex_[a-zA-Z0-9_]{1,140}$/.test(failureId??'') ||
     !/^req_[a-zA-Z0-9_]{1,140}$/.test(targetId??'') ||
     !/^op_[a-zA-Z0-9_-]{1,140}$/.test(operationId??'')) throw new Error('复核意图无效。');
  const local=await readJson(journalFile),status=await readJson(statusFile);
  if(!local || local.phase!=='settled' || local.lease || local.receipt ||
     local.target?.targetId!==targetId || digest(local)!==intent.journalDigest)
    throw new Error('原办理日志已变化，保持暂停。');
  const answer=await portal.call('verified_review_receipt',{failureId,targetId,operationId});
  const receipt=answer?.receipt;
  if(!receipt || receipt.failureId!==failureId || receipt.targetId!==targetId ||
     receipt.operationId!==operationId || receipt.workspaceId!==config.workspaceId ||
     receipt.observedAt!==intent.secondObservedAt ||
     !Number.isFinite(Date.parse(receipt.reviewedAt)) ||
     Date.parse(receipt.reviewedAt)<Date.parse(intent.secondObservedAt))
    throw new Error('无法确认精确复核回执；不得重新提交或执行成员操作。');
  const plan=planOf(await portal.call('seat_portal_status'));
  assertPlan(plan,local,config,true);
  if(plan.workspaceReviewedAt!==receipt.reviewedAt ||
     !isDeepStrictEqual(await readJson(journalFile),local))
    throw new Error('复核后云端或本机状态已变化，保持暂停。');
  const expectedEvidence={failureId,targetId,operationId,workspaceReviewedAt:receipt.reviewedAt,
    firstObservedAt:intent.firstObservedAt,secondObservedAt:intent.secondObservedAt,
    previousStatusAt:intent.previousStatusAt};
  if(digest(status)===intent.statusDigest) {
    await assertStopUnchanged(journalFile,stop);
    await writeStatus(statusFile,{checkedAt:new Date(clock()).toISOString(),mode:'idle',modelCalls:0,
      liveActions:true,reviewEvidence:expectedEvidence});
  } else if(status?.mode!=='idle' || status?.state || status?.failureCode || status?.error ||
            !isDeepStrictEqual(status?.reviewEvidence,expectedEvidence))
    throw new Error('本机状态与原复核意图不一致，保持暂停。');
  await assertStopUnchanged(journalFile,stop);
  await atomicJson(file,{...intent,phase:'settled',reviewedAt:receipt.reviewedAt});
  return {outcome:'reviewed',source:'receipt_recovery',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0};
}
export async function reviewVerifiedOperation({portal,browser,config,journalFile,statusFile,clock=Date.now,writeStatus=atomicJson,
  writeIntent=atomicJson,expectedRetry,expectedStopDigest}) {
  const stop=expectedStopDigest??await stopDigest(journalFile);
  if(!/^(?:absent|[0-9a-f]{64})$/.test(stop))throw new Error('停机票据无效。');
  await assertStopUnchanged(journalFile,stop);
  if(expectedRetry && (typeof expectedRetry!=='object' || Array.isArray(expectedRetry) ||
     Object.keys(expectedRetry).sort().join(',')!=='failureId,operationId,targetId' ||
     !/^codex_[a-zA-Z0-9_]{1,140}$/.test(expectedRetry.failureId??'') ||
     !/^req_[a-zA-Z0-9_]{1,140}$/.test(expectedRetry.targetId??'') ||
     !/^op_[a-zA-Z0-9_-]{1,140}$/.test(expectedRetry.operationId??'')))throw new Error('重试票据无效。');
  const intentFile=intentPath(journalFile),priorIntent=await readIntent(intentFile);
  if(priorIntent) {
    if(expectedRetry)throw new Error('重试期间存在复核意图，保持暂停。');
    if(priorIntent.phase==='submitted')return recoverVerifiedReviewIntent({portal,config,journalFile,statusFile,clock,writeStatus,expectedStopDigest:stop});
    if(priorIntent.phase==='settled')await archiveSettledForNewFailure({portal,config,journalFile,statusFile,intentFile,intent:priorIntent});
    else throw new Error('存在原复核意图，不得自动重做。');
  }
  const initial=planOf(await portal.call('seat_portal_status'));
  const local=await readJson(journalFile),status=await readJson(statusFile);
  assertPlan(initial,local,config);
  if(!status || status.state!=='blocked' || status.modelCalls!==0 || !Number.isFinite(Date.parse(status.checkedAt)))
    throw new Error('本机执行状态不符合限定恢复条件。');
  const receipt=matchingReceipt(initial,local),base=stablePlan(initial),baseLocal=structuredClone(local);
  if(expectedRetry && (expectedRetry.failureId!==initial.globalFailureId || expectedRetry.targetId!==local.target.targetId ||
     expectedRetry.operationId!==receipt.id))throw new Error('复核故障或原回执与重试票据不一致。');
  const recheck=async()=>{
    const plan=planOf(await portal.call('seat_portal_status')),current=await readJson(journalFile);
    assertPlan(plan,current,config);
    if(!isDeepStrictEqual(stablePlan(plan),base) || !isDeepStrictEqual(current,baseLocal) ||
       !isDeepStrictEqual(await readJson(statusFile),status) || !isDeepStrictEqual(matchingReceipt(plan,current),receipt))
      throw new Error('核查期间计划、本机日志或回执变化，保持暂停。');
  };
  const readOfficial=async()=>{
    // snapshot() already collects the complete members and invitation lists.
    // This helper itself validates two such snapshots with plan checks between
    // them; calling observe() here would nest its own pair and read four times.
    try { return strictSnapshot(await browser.snapshot(),config,clock()); }
    catch(error) {
      if(error instanceof OfficialPageError && error.failureCode==='browser_unavailable' &&
         ['browser_unavailable','unknown'].includes(status.failureCode) && !await readIntent(intentFile)) {
        // Do not issue a retry ticket when the failure, journal or target
        // changed while the official read was pending.
        await recheck();
        error.reviewRetry={phase:'pre_submit',failureId:initial.globalFailureId,targetId:local.target.targetId,
          operationId:receipt.id,reason:'browser_unavailable',retryable:true,
          statusCheckedAt:status.checkedAt,statusFailureCode:status.failureCode};
      }
      throw error;
    }
  };
  const first=await readOfficial();await recheck();
  const second=await readOfficial();await recheck();
  strictSnapshot(first,config,clock());strictSnapshot(second,config,clock());
  if(Date.parse(second.observedAt)<Date.parse(first.observedAt) || !isDeepStrictEqual(inventory(first),inventory(second)))
    throw new Error('两次官方名单不一致，保持暂停。');
  await assertStopUnchanged(journalFile,stop);
  await writeIntent(intentFile,{version:1,phase:'submitted',failureId:initial.globalFailureId,
    targetId:local.target.targetId,operationId:receipt.id,journalDigest:digest(local),statusDigest:digest(status),
    firstObservedAt:first.observedAt,secondObservedAt:second.observedAt,previousStatusAt:status.checkedAt});
  await assertStopUnchanged(journalFile,stop);
  const reviewed=planOf(await portal.call('review_seat_failure',{decision:'resume_verified_operation',
    expectedFailureId:initial.globalFailureId,expectedTargetId:local.target.targetId,
    operationId:receipt.id,observation:bridgeObservation(second)}));
  assertPlan(reviewed,await readJson(journalFile),config,true);
  const after=planOf(await portal.call('seat_portal_status'));
  assertPlan(after,await readJson(journalFile),config,true);
  const checkReceipt=await portal.call('verified_review_receipt',{failureId:initial.globalFailureId,
    targetId:local.target.targetId,operationId:receipt.id});
  const verified=checkReceipt?.receipt;
  if(!verified || verified.failureId!==initial.globalFailureId || verified.targetId!==local.target.targetId ||
     verified.operationId!==receipt.id || verified.workspaceId!==config.workspaceId ||
     verified.observedAt!==second.observedAt || verified.reviewedAt!==after.workspaceReviewedAt)
    throw new Error('原复核回执不匹配，保持暂停。');
  if(!Number.isFinite(Date.parse(after.workspaceReviewedAt)) || Date.parse(after.workspaceReviewedAt)<Date.parse(second.observedAt) ||
     !isDeepStrictEqual(stablePlan(after),stablePlan(reviewed)) ||
     !isDeepStrictEqual(await readJson(journalFile),baseLocal) || !isDeepStrictEqual(await readJson(statusFile),status))
    throw new Error('复核结果或本机状态变化，不写入恢复证据。');
  await assertStopUnchanged(journalFile,stop);
  await writeStatus(statusFile,{checkedAt:new Date(clock()).toISOString(),mode:'idle',modelCalls:0,liveActions:true,
    reviewEvidence:{failureId:initial.globalFailureId,targetId:local.target.targetId,operationId:receipt.id,workspaceReviewedAt:after.workspaceReviewedAt,
      firstObservedAt:first.observedAt,secondObservedAt:second.observedAt,previousStatusAt:status.checkedAt}});
  await assertStopUnchanged(journalFile,stop);
  await writeIntent(intentFile,{...await readIntent(intentFile),phase:'settled',reviewedAt:after.workspaceReviewedAt});
  return {outcome:'reviewed',source:'fresh_review',workspaceResumed:true,officialSnapshots:2,memberActions:0,modelCalls:0};
}
