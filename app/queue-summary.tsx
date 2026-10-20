"use client";
import type { WaitEstimate } from "../lib/queue-estimate";
export function waitLabel(estimate: WaitEstimate | undefined, now: number) {
  if (!estimate || estimate.status === "uncertain") return "暂无法估算";
  if (estimate.status === "paused") return "等待恢复办理";
  if (estimate.status === "ready") return "可进入分配";
  const low = Math.max(0, Math.ceil((Date.parse(estimate.earliestAt!) - now) / 60_000));
  const high = Math.max(0, Math.ceil((Date.parse(estimate.latestAt!) - now) / 60_000));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return "同步中";
  if (!high) return "等待办理确认";
  return low === high ? `约 ${high} 分钟` : `约 ${low}–${high} 分钟`;
}
export default function QueueSummary({ aggregate, estimate, now, stale, position, hasRequest }: {
  aggregate: Record<string, number | boolean>; estimate?: WaitEstimate; now: number;
  stale: boolean; position?: number | null; hasRequest: boolean;
}) {
  return <section className="queue-overview" aria-label="实时席位与排队">
    <div className="queue-metrics">
      <div><span>正在等候</span><strong>{aggregate.queued ?? "—"}<small> 人</small></strong><p>仅包含排队中的申请</p></div>
      <div><span>当前可分配</span><strong>{aggregate.inventoryVerified ? aggregate.availableSeats ?? "—" : "待盘点"}<small>{aggregate.inventoryVerified ? " 席" : ""}</small></strong><p>已扣除保留、邀请及回收中的席位</p></div>
      <div><span>{position ? `我的预计等待 · 第 ${position} 位` : hasRequest ? "我的席位安排" : "新申请预计等待"}</span><strong className="wait-value">{stale ? "等待同步" : hasRequest && !position ? "已有席位安排" : waitLabel(estimate, now)}</strong><p>{stale ? "连接中断时保留上次数据，请刷新" : "估算值，实际以官方办理确认结果为准"}</p></div>
    </div>
    <p className="queue-explanation">{stale ? "数据超过 45 秒未同步。倒计时不能代替官方加入与回收状态。" : estimate?.reason ?? "各端使用同一服务端队列。"}
      <span>状态每 10 秒同步；自动办理还需巡检与执行时间。</span></p>
  </section>;
}
