import {PROTECTED_OWNER_EMAIL} from './seat-engine.ts';
import {TARGET_WORKSPACE_ID, observeWorkspace, type BridgeState, type FailureCode, type Observation} from './codex-bridge.ts';

const idleCodes = ['browser_unavailable','login_expired','workspace_mismatch','capacity_mismatch','role_mismatch','unknown'];
const validExpected = (value: unknown) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
function guardIdleWrite(input: BridgeState, expectedObservedAt: string | null) {
  const b=input.codex;
  if (!b?.enabled || b.testOnly || !input.config.inventoryVerified || input.config.workspaceId !== TARGET_WORKSPACE_ID ||
      !input.config.protectedEmails.includes(PROTECTED_OWNER_EMAIL) || b.lease || b.operationFailureOrigin)
    throw new Error('存在未结案操作或身份配置异常，不能登记空闲核对。');
  if (b.globalFailureCode || b.lastError) throw new Error('已有故障，不能用空闲核对覆盖。');
  if ((b.observation?.observedAt ?? null) !== expectedObservedAt)
    throw new Error('成员证据已更新，不能登记旧的空闲核对。');
}
/** The guard and official state reconciliation share the same aggregate CAS.
 * A claim/fault/new observation arriving after the local preflight wins; an idle
 * read must never modify that newer operation or downgrade its evidence. */
export function applyIdleObservation(input: BridgeState, args: {observation: Observation; expectedObservedAt: string | null}, now: string): BridgeState {
  if (!args || Object.keys(args).sort().join(',') !== 'expectedObservedAt,observation' || !validExpected(args.expectedObservedAt))
    throw new Error('空闲核对参数无效。');
  guardIdleWrite(input,args.expectedObservedAt);
  return observeWorkspace(input,args.observation,now);
}
/** Targetless, pre-action health failure. Never clears/downgrades a fault or a lease. */
export function recordIdleFailure(input: BridgeState, args: {failureCode: FailureCode; expectedObservedAt: string | null}, now: string): BridgeState {
  if (!args || Object.keys(args).sort().join(',') !== 'expectedObservedAt,failureCode' ||
      !idleCodes.includes(args.failureCode) ||
      !validExpected(args.expectedObservedAt))
    throw new Error('空闲核对故障参数无效。');
  const next = structuredClone(input), b = next.codex;
  guardIdleWrite(next,args.expectedObservedAt);
  if (!b) throw new Error('执行器尚未启用。');
  b.globalFailureCode = args.failureCode;
  b.lastError = '定期官方名单核对未完成；尚未开始外部操作，保留申请与全部席位占用。';
  if (args.failureCode === 'browser_unavailable') b.browserUnavailableAt = now;
  else delete b.browserUnavailableAt;
  next.revision++;
  next.audit.push({id:'codex_'+next.revision+'_'+Date.parse(now),at:now,actor:PROTECTED_OWNER_EMAIL,action:'codex_workspace_blocked'});
  // Central history compaction preserves this incident's provenance atomically.
  return next;
}
