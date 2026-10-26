import { acceptanceDue } from '../seat-executor/core.mjs';
import { bridgeObservation, presence, assertOrdinary } from '../seat-executor/inventory.mjs';
import {recoverablePortalError} from './portal-recovery.mjs';

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

/** Fresh plan for every item. No API for starting or messaging an Agent exists here. */
export async function runBatch({ portal, browser, config, journal,
  clock = () => new Date(), maxItems = config.maxItems ?? 6 }) {
  let plan = planOf(await portal.call('seat_portal_status'));
  if (!config.liveActions) return { mode: 'dry_run', modelCalls: 0,
    pending: Object.fromEntries(['invites','removals','reminders','awaitingAcceptance']
      .map(k => [k, (plan[k] ?? []).length])) };
  if (!config.legacyCheckerDisabled) throw new StopError('旧执行器尚未确认停用。');
  // Journal reconciliation is read-only. Never discard a claim or uncertain send.
  await journal?.reconcile(plan);
  if (!guard(plan, config)) return { mode: 'disabled', actions: [], modelCalls: 0 };
  const actions = [], seen = new Set();
  let jobs;
  for (let index = 0; index < maxItems; index++) {
    // Production uses the endpoint whose contract excludes mail and all external
    // actions. Legacy/mock adapters retain their existing queue interface.
    jobs = typeof portal.refreshQueue==='function' ? await portal.refreshQueue()
      : await portal.call('process_seat_queue');
    if (!['in_app', 'relay'].includes(jobs.mailMode) || jobs.mailMode !== config.mailMode)
      throw new StopError('本机与云端提醒模式不一致，停止执行。');
    plan = planOf(await portal.call('seat_portal_status'));
    if (!guard(plan, config)) break;
    const next = ['remove', 'invite'].flatMap(kind =>
      (plan[kind === 'remove' ? 'removals' : 'invites'] ?? []).map(item => ({kind,item})))
      .find(({kind,item}) => !held(plan,kind,item) && !seen.has(`${kind}:${item.id}`));
    const acceptance = (plan.awaitingAcceptance ?? []).find(r => !held(plan,'acceptance',r) &&
      acceptanceDue(r,clock().getTime()) && !seen.has(`acceptance:${r.id}`));
    const target = next ?? (acceptance ? {kind:'acceptance',item:acceptance} : null);
    if (!target) break;
    const {kind,item} = target;
    seen.add(`${kind}:${item.id}`);
    let before;
    try {
      before = await browser.observe();
      await portal.call('observe_workspace', {observation:bridgeObservation(before)});
    } catch (error) {
      // The identity GET failed BEFORE observe_workspace was sent. Do not mark
      // an untouched target unknown; main still requires a settled journal.
      if(recoverablePortalError(error) && error.metadata.requestNotSent===true)throw error;
      await portal.call('defer_seat_operation', {kind:kind === 'acceptance' ? 'invite' : kind,
        targetId:item.id, failureCode:safeCode(error), detail:'官方完整名单核对失败；未开始成员写入。'});
      throw error;
    }
    if (kind === 'acceptance') { actions.push({kind,targetId:item.id,outcome:'checked'}); continue; }
    plan = planOf(await portal.call('seat_portal_status'));
    if (!guard(plan,config)) break;
    const current = (kind === 'remove' ? plan.removals : plan.invites)
      .find(r => r.id === item.id && r.email === item.email && !held(plan,kind,r));
    if (!current) { actions.push({kind,targetId:item.id,outcome:'state_changed'}); continue; }
    await journal?.prepare({kind,targetId:item.id,email:item.email});
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
    let attempted = false, sentAt;
    browser.onExternalAction = async () => { attempted = true; await journal?.attempting(); };
    const finish = async (after, outcome = 'verified') => {
      const args = {operationId:lease.id,token:lease.token,outcome,observation:bridgeObservation(after),
        ...(sentAt ? {invitationSentAt:sentAt} : {})};
      // Store evidence before the receipt write. An interrupted completion can be reconciled.
      await journal?.evidence(args);
      await portal.call('complete_seat_operation',args);
      await journal?.settled();
      actions.push({kind,targetId:item.id,outcome});
    };
    const joined = s => kind === 'remove' && current.removalReason === 'invitation_expired' &&
      lease.originalPresence === 'invite' && presence(s,lease.email) === 'member';
    const verified = s => kind === 'remove' ? presence(s,lease.email) === 'absent'
      : presence(s,lease.email) !== 'absent';
    try {
      // Recheck after claim, including role. Never revoke a joined member for invite timeout.
      const fresh = await browser.observe();
      assertOrdinary(fresh,lease.email,{config:{protectedEmails:[config.adminEmail]}});
      if (joined(fresh)) { await finish(fresh,'joined'); continue; }
      if (kind === 'remove' && current.removalReason === 'invitation_expired' &&
          presence(fresh,lease.email) === 'member') throw new StopError('邀请超时目标已加入，保留成员并停止。');
      if (!verified(fresh)) {
        if (kind === 'invite') sentAt = await browser.invite(lease.email,fresh);
        else await browser.remove(lease.email,fresh);
      }
      const after = await browser.observe();
      if (joined(after)) await finish(after,'joined');
      else if (verified(after)) await finish(after);
      else throw new StopError('操作后的真实状态未确认，保留租约。');
    } catch (error) {
      // Read-only reconciliation, at most once. No second invite/remove click.
      let after;
      try { after = await browser.observe(); } catch { /* Keep uncertainty. */ }
      if (after && (joined(after) || verified(after))) {
        await finish(after, joined(after) ? 'joined' : 'verified');
        continue;
      }
      let code = safeCode(error);
      if (code === 'browser_unavailable') code = 'unknown'; // Already claimed.
      await portal.call('complete_seat_operation', {operationId:lease.id,token:lease.token,
        outcome:attempted ? 'uncertain' : 'blocked',failureCode:code,
        detail:'程序办理未完成；保留原租约和证据，不自动重做外部动作。'});
      const check = planOf(await portal.call('seat_portal_status'));
      const hold = check.blockedOperations?.find(h => h.operation.id === lease.id);
      if (!isolated.has(code) || !hold || check.busy || check.lastError || check.globalFailureCode)
        throw error;
      await journal?.settled();
      actions.push({kind,targetId:item.id,outcome:'isolated',failureCode:code});
    } finally { browser.onExternalAction = () => {}; }
  }
  return {mode:actions.length ? 'processed' : 'idle',actions,modelCalls:0,
    mailChannelError:plan.mailChannelError ?? null};
}
