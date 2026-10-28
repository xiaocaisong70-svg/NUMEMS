import { acceptanceDue } from '../seat-executor/core.mjs';
import { bridgeObservation, presence, assertOrdinary } from '../seat-executor/inventory.mjs';
import {recoverablePortalError} from './portal-recovery.mjs';
import {InventoryMismatchError} from '../seat-executor/browser.mjs';
import {safeOperationDiagnostic} from './operation-diagnostic.mjs';
import {cloudRecoveryOwned} from './recovery-fence.mjs';

const planOf = value => value.plan ?? value;
const isolated = new Set(['member_action', 'approval_required', 'mail_delivery']);
export class StopError extends Error {
  constructor(message, code = 'unknown') { super(message); this.failureCode = code; }
}
export function held(plan, kind, item) {
  return (plan.blockedOperations ?? []).some(h => h.operation.kind === 'mail'
    ? kind === 'mail' && h.operation.targetId === item.id
    : kind !== 'mail' && h.operation.email === item.email);
}
function guard(plan, config) {
  if (plan.workspaceId !== config.workspaceId || plan.administrator !== config.adminEmail)
    throw new StopError('门户身份或工作空间不匹配。', 'workspace_mismatch');
  if (plan.busy || plan.lease) throw new StopError('存在未完成租约；保留原任务，禁止重复执行。');
  if (plan.globalFailureCode || plan.lastError)
    throw new StopError('工作空间已暂停。', plan.globalFailureCode || 'unknown');
  return plan.enabled === true; // Test-only plans are already restricted by the server.
}
const safeCode = error => ['member_action','approval_required','login_expired','workspace_mismatch',
  'capacity_mismatch','role_mismatch','browser_unavailable'].includes(error.failureCode) ? error.failureCode : 'unknown';
const fatalObservationCodes = new Set(['login_expired','workspace_mismatch','capacity_mismatch','role_mismatch']);
const incompleteObservation = error => error instanceof InventoryMismatchError || error.failureCode==='browser_unavailable';
export const MEMBER_OPERATION_BUDGETS=Object.freeze({totalMs:120000,preflightMs:40000,freshMs:25000,actionMs:35000,verificationMs:35000});
const budgetError=()=>Object.assign(new StopError('本次成员办理的控制预算已用尽；保留原记录，禁止盲目重发。','browser_unavailable'),{code:'OPERATION_BUDGET_EXHAUSTED'});
function remaining(deadlineAt,now) {const value=Math.floor(deadlineAt-now());if(value<=0)throw budgetError();return value;}
function readControls(deadlineAt,now,shouldStop) {return {deadlineAt,budgetMs:Math.min(60000,remaining(deadlineAt,now)),now,...(shouldStop?{shouldStop}:{})};}
async function observeWithin(browser,deadlineAt,now,shouldStop) {
  const snapshot=await browser.observe(readControls(deadlineAt,now,shouldStop));
  remaining(deadlineAt,now);return snapshot;
}

// Called only after the cloud plan and local journal confirm no outstanding
// lease and strictly before claim_seat_operation. Never use in post-claim
// reconciliation: a prior external result could be uncertain there.
export async function observeBeforeClaim(browser, {pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  deadlineAt=Date.now()+40000,now=Date.now,shouldStop}={}) {
  try { return await observeWithin(browser,deadlineAt,now,shouldStop); }
  catch (error) {
    if (!(error instanceof InventoryMismatchError)) throw error;
    await pause(Math.min(1000,remaining(deadlineAt,now)));
    return observeWithin(browser,deadlineAt,now,shouldStop); // One bounded re-read; preserve the same complete-evidence checks.
  }
}

/** Fresh plan for every item. No API for starting or messaging an Agent exists here. */
export async function runBatch({ portal, browser, config, journal,
  clock = () => new Date(), maxItems = config.maxItems ?? 6,
  pause = ms => new Promise(resolve=>setTimeout(resolve,ms)),shouldStop=async()=>false,budgets=MEMBER_OPERATION_BUDGETS }) {
  budgets={...MEMBER_OPERATION_BUDGETS,...budgets};
  if(Object.entries(budgets).some(([key,value])=>!Object.hasOwn(MEMBER_OPERATION_BUDGETS,key)||!Number.isInteger(value)||value<1||value>(key==='totalMs'?120000:key==='actionMs'?45000:60000)))
    throw new Error('Invalid bounded member operation timing.');
  const now=()=>clock().getTime(),stopped=actions=>({mode:actions.length?'processed':'idle',actions,stopped:true,modelCalls:0});
  let plan = planOf(await portal.call('seat_portal_status'));
  if (!config.liveActions) return { mode: 'dry_run', modelCalls: 0,
    pending: Object.fromEntries(['invites','removals','reminders','awaitingAcceptance']
      .map(k => [k, (plan[k] ?? []).length])) };
  if (!config.legacyCheckerDisabled) throw new StopError('旧执行器尚未确认停用。');
  // Journal reconciliation is read-only. Never discard a claim or uncertain send.
  await journal?.reconcile(plan);
  if(cloudRecoveryOwned(plan))return {mode:'fault_rescue_pending',actions:[],modelCalls:0};
  if (!guard(plan, config)) return { mode: 'disabled', actions: [], modelCalls: 0 };
  const actions = [], seen = new Set();
  let jobs;
  for (let index = 0; index < maxItems; index++) {
    if(await shouldStop())return stopped(actions);
    // Production uses the endpoint whose contract excludes mail and all external
    // actions. Legacy/mock adapters retain their existing queue interface.
    jobs = typeof portal.refreshQueue==='function' ? await portal.refreshQueue()
      : await portal.call('process_seat_queue');
    if (!['in_app', 'relay'].includes(jobs.mailMode) || jobs.mailMode !== config.mailMode)
      throw new StopError('本机与云端提醒模式不一致，停止执行。');
    plan = planOf(await portal.call('seat_portal_status'));
    if(cloudRecoveryOwned(plan))return {mode:'fault_rescue_pending',actions,modelCalls:0};
    if (!guard(plan, config)) break;
    const next = ['remove', 'invite'].flatMap(kind =>
      (plan[kind === 'remove' ? 'removals' : 'invites'] ?? []).map(item => ({kind,item})))
      .find(({kind,item}) => !held(plan,kind,item) && !seen.has(`${kind}:${item.id}`));
    const acceptance = (plan.awaitingAcceptance ?? []).find(r => !held(plan,'acceptance',r) &&
      acceptanceDue(r,clock().getTime()) && !seen.has(`acceptance:${r.id}`));
    const target = next ?? (acceptance ? {kind:'acceptance',item:acceptance} : null);
    if (!target) break;
    const {kind,item} = target;
    const deadlineAt=now()+budgets.totalMs,preflightDeadline=Math.min(deadlineAt,now()+budgets.preflightMs);
    seen.add(`${kind}:${item.id}`);
    let before;
    try {
      before = await observeBeforeClaim(browser,{pause,deadlineAt:preflightDeadline,now,shouldStop});
      await portal.call('observe_workspace', {observation:bridgeObservation(before)});
    } catch (error) {
      if(error.code==='OFFICIAL_READ_CANCELLED' && await shouldStop())return stopped(actions);
      // The identity GET failed BEFORE observe_workspace was sent. Do not mark
      // an untouched target unknown; main still requires a settled journal.
      if(recoverablePortalError(error) && error.metadata.requestNotSent===true)throw error;
      if (error instanceof InventoryMismatchError) {
        const detail = `${error.message} 未开始成员写入；等待完整官方名单只读复核。`;
        let deferred;
        try {
          deferred = planOf(await portal.call('defer_seat_operation', {
            kind:kind === 'acceptance' ? 'invite' : kind,
            targetId:item.id, failureCode:'browser_unavailable', detail,
          }));
        } catch (deferError) {
          // The defer write may have reached the server. Never reclassify an
          // unconfirmed RPC as safely recoverable, even after a transport error.
          const blocked = new StopError('名单不一致的暂停登记未确认，保持停止并核对。');
          blocked.cause = deferError; throw blocked;
        }
        if (deferred?.workspaceId !== config.workspaceId || deferred?.administrator !== config.adminEmail ||
            deferred.globalFailureCode !== 'browser_unavailable' || deferred.lastError !== detail ||
            deferred.busy !== false || deferred.lease != null || deferred.browserRecovery?.eligible !== true) {
          throw new StopError('名单不一致的暂停回执不完整或已变化，保持停止并核对。');
        }
        // Only now can main perform its guarded, read-only browser recovery.
        const unavailable = new StopError(error.message, 'browser_unavailable');
        unavailable.cause = error; throw unavailable;
      }
      await portal.call('defer_seat_operation', {kind:kind === 'acceptance' ? 'invite' : kind,
        targetId:item.id, failureCode:safeCode(error), detail:'官方完整名单核对失败；未开始成员写入。'});
      throw error;
    }
    if (kind === 'acceptance') { actions.push({kind,targetId:item.id,outcome:'checked'}); continue; }
    if(await shouldStop())return stopped(actions);
    if(now()>=deadlineAt)return {mode:'processed',actions:[...actions,{kind,targetId:item.id,outcome:'not_started',reason:'budget_exhausted'}],modelCalls:0};
    plan = planOf(await portal.call('seat_portal_status',{},readControls(deadlineAt,now)));
    if(cloudRecoveryOwned(plan))return {mode:'fault_rescue_pending',actions,modelCalls:0};
    if (!guard(plan,config)) break;
    const current = (kind === 'remove' ? plan.removals : plan.invites)
      .find(r => r.id === item.id && r.email === item.email && !held(plan,kind,r));
    if (!current) { actions.push({kind,targetId:item.id,outcome:'state_changed'}); continue; }
    if(await shouldStop())return stopped(actions);
    await journal?.prepare({kind,targetId:item.id,email:item.email});
    const cancelled=await shouldStop()?'stop_requested':now()>=deadlineAt?'budget_exhausted':null;
    if(cancelled) {
      await journal?.cancelUnsentPreparation?.({kind,targetId:item.id,email:item.email},cancelled);
      if(cancelled==='stop_requested')return stopped(actions);
      return {mode:'processed',actions:[...actions,{kind,targetId:item.id,outcome:'not_started',reason:cancelled}],modelCalls:0};
    }
    let claimed;
    try {claimed=await portal.call('claim_seat_operation', {kind,targetId:item.id});}
    catch(error) {
      if(recoverablePortalError(error) && error.metadata.stage==='identity' &&
        error.metadata.requestedOperation==='claim_seat_operation' && error.metadata.requestNotSent===true) {
        // Identity check failed before the claim POST existed. Preserve that
        // proof, not a fictitious lease; no sent/uncertain claim may use this path.
        await journal?.settleUnsentClaim({kind,targetId:item.id,email:item.email},error.metadata);
      }
      throw error;
    }
    const lease = planOf(claimed).lease;
    if (!lease || lease.kind !== kind || lease.targetId !== item.id || lease.email !== item.email ||
        !lease.token || !lease.id) throw new StopError('领取结果与目标不符，禁止外部操作。');
    await journal?.claimed(lease);
    let attempted = false, sentAt, finishStarted = false;
    browser.onExternalAction = async () => { attempted = true; await journal?.attempting(); };
    browser.onExternalActionCommitted=async submission=>{
      if(!attempted||kind!=='invite'||submission?.kind!=='invite'||submission.email!==lease.email||
          !Number.isFinite(Date.parse(submission.invitationSentAt))||Date.parse(submission.invitationSentAt)<Date.parse(lease.claimedAt)||
          Date.parse(submission.invitationSentAt)>now()+5000)
        throw new StopError('邀请提交时间与原租约不符，保留原记录。');
      sentAt=submission.invitationSentAt;
      await journal?.submitted?.({operationId:lease.id,token:lease.token,...submission});
    };
    let verificationAttempts=0,verificationDeadline;
    const verify=async()=>{
      verificationDeadline??=Math.min(deadlineAt,now()+budgets.verificationMs);
      if(verificationAttempts>=4)throw budgetError();
      verificationAttempts++;
      return observeWithin(browser,verificationDeadline,now);
    };
    const finish = async (after, outcome = 'verified') => {
      finishStarted = true;
      const args = {operationId:lease.id,token:lease.token,outcome,observation:bridgeObservation(after),
        ...(sentAt ? {invitationSentAt:sentAt} : {})};
      // Store evidence before the receipt write. An interrupted completion can be reconciled.
      await journal?.evidence(args);
      await portal.call('complete_seat_operation',args);
      await journal?.settled();
      actions.push({kind,targetId:item.id,outcome});
    };
    const invitationOnly = ['invitation_expired','whitelist_revoked'].includes(current.removalReason);
    const joined = s => kind === 'remove' && invitationOnly &&
      lease.originalPresence === 'invite' && presence(s,lease.email) === 'member';
    const verified = s => kind === 'remove' ? presence(s,lease.email) === 'absent'
      : presence(s,lease.email) !== 'absent';
    const assertTarget = snapshot => {
      try {assertOrdinary(snapshot,lease.email,{config:{protectedEmails:[config.adminEmail]}});}
      catch (cause) {
        const blocked=new StopError('目标不再是可办理的普通成员，保留原租约并停止。','role_mismatch');
        blocked.cause=cause;throw blocked;
      }
    };
    try {
      // Recheck after claim, including role. Never revoke a joined member for invite timeout.
      const fresh = await observeWithin(browser,Math.min(deadlineAt,now()+budgets.freshMs),now);
      assertTarget(fresh);
      if (joined(fresh)) { await finish(fresh,'joined'); continue; }
      if (kind === 'remove' && invitationOnly &&
          presence(fresh,lease.email) === 'member') throw new StopError('邀请超时目标已加入，保留成员并停止。');
      if (!verified(fresh)) {
        const actionOptions={deadlineAt,budgetMs:Math.min(budgets.actionMs,remaining(deadlineAt,now)),now};
        if (kind === 'invite') sentAt = (await browser.invite(lease.email,fresh,actionOptions))??sentAt;
        else await browser.remove(lease.email,fresh,actionOptions);
      }
      const after = await verify();
      assertTarget(after);
      if (joined(after)) await finish(after,'joined');
      else if (verified(after)) await finish(after);
      else throw new StopError('操作后的真实状态未确认，保留租约。');
    } catch (error) {
      const operationDiagnostic=safeOperationDiagnostic(error);
      const blockedWithDiagnostic=(message,cause,code='unknown')=>{
        const blocked=new StopError(message,code);blocked.cause=cause;
        if(operationDiagnostic)blocked.operationDiagnostic=operationDiagnostic;
        return blocked;
      };
      // A receipt write or local evidence write may already have landed. Do not
      // call finish again, overwrite the retained receipt, or send a failure RPC.
      if(finishStarted) {
        throw blockedWithDiagnostic('原操作回执写入未确认；保留原租约与本地证据，禁止重复提交。',error);
      }
      if(operationDiagnostic)await journal?.update?.({operationDiagnostic});
      // Preserve the proven reconciliation policy: an immediate catch read,
      // then at most two further reads after 1s/3s. All four possible readings
      // share one deadline; none repeats an action or extends the original lease.
      let after,reconcileError;
      if(!fatalObservationCodes.has(safeCode(error))) {
        for(let attempt=1;attempt<=3 && now()<Math.min(deadlineAt,verificationDeadline??deadlineAt);attempt++) {
          if(attempt>1)await pause(Math.max(0,Math.min(attempt===2?1000:3000,Math.min(deadlineAt,verificationDeadline??deadlineAt)-now())));
          await journal?.update?.({postActionReconcile:{stage:'observing',attempt,classification:'read_only'}});
          try {
            const observed=await verify();
            assertTarget(observed);
            await journal?.update?.({postActionReconcile:{stage:'observed',attempt,classification:'complete_read'}});
            after=observed;reconcileError=undefined;
            break;
          } catch(readError) {
            reconcileError=readError;
            const retryable=incompleteObservation(readError);
            await journal?.update?.({postActionReconcile:{stage:'failed',attempt,
              classification:retryable?'incomplete_read':safeCode(readError)}});
            if(!retryable || attempt===3)break;
          }
        }
      }
      if (after && (joined(after) || verified(after))) {
        try {await finish(after, joined(after) ? 'joined' : 'verified');}
        catch(completionError) {
          throw blockedWithDiagnostic('原操作回执写入未确认；保留原租约与本地证据，禁止重复提交。',completionError);
        }
        continue;
      }
      const failure=reconcileError??error;
      let code = safeCode(failure);
      if (code === 'browser_unavailable') code = 'unknown'; // Already claimed.
      let check;
      try {
        await portal.call('complete_seat_operation', {operationId:lease.id,token:lease.token,
          outcome:attempted ? 'uncertain' : 'blocked',failureCode:code,
          detail:'程序办理未完成；保留原租约和证据，不自动重做外部动作。'});
        check = planOf(await portal.call('seat_portal_status'));
      } catch (registrationError) {
        // A claim already exists. Even a later read timeout must not enter the
        // normal pre-claim read-only recovery path; the write could have landed.
        throw blockedWithDiagnostic('已领取任务的完成登记或状态核对未确认；保留原租约与证据，禁止自动重试。',registrationError);
      }
      const hold = check.blockedOperations?.find(h => h.operation.id === lease.id);
      if (!isolated.has(code) || !hold || check.busy || check.lastError || check.globalFailureCode) {
        if (code === 'unknown' || isolated.has(code)) {
          // Do not leak a misleading pre-claim browser_unavailable signal or
          // its "no action started" text after the operation was claimed.
          throw blockedWithDiagnostic('已领取任务的操作结果或核实未确认；保留原租约与证据，禁止自动重试。',failure);
        }
        throw blockedWithDiagnostic('已领取任务的官方身份、角色或容量核对失败；保留原租约并停止。',failure,code);
      }
      await journal?.settled();
      actions.push({kind,targetId:item.id,outcome:'isolated',failureCode:code});
    } finally { browser.onExternalAction = () => {};browser.onExternalActionCommitted=()=>{}; }
  }
  return {mode:actions.length ? 'processed' : 'idle',actions,modelCalls:0,
    mailChannelError:plan.mailChannelError ?? null};
}
