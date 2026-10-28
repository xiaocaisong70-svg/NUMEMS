import type { Actor, State } from "./seat-engine.ts";

export const REQUEST_RATE_LIMITS = { applyHour: 12, applyDay: 60, renewHour: 12 } as const;
type Counter = { email: string; hour: number; day: number; appliesHour: number; appliesDay: number; renewalsHour: number };
type RateState = State & { requestRates?: Counter[] };
export class RequestRateError extends Error { readonly status = 429; }

/** Bounded fixed-window counters are written in the same CAS as a successful
 * action. Failed commands and duplicate idempotency keys consume no budget. */
export function enforceRequestRate(previous: State, next: State, actor: Actor, command: Record<string, unknown>, now: string) {
  if (actor.isAdmin || !["apply", "renew"].includes(String(command.type)) || next.revision === previous.revision) return next;
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) throw new Error("时间无效。");
  const hour = Math.floor(instant / 3_600_000), day = Math.floor(instant / 86_400_000);
  const state = next as RateState;
  const counters = (state.requestRates ?? []).filter(c => c.day === day && state.config.whitelist.includes(c.email));
  const old = counters.find(c => c.email === actor.email);
  const counter: Counter = old ? { ...old } : { email: actor.email, hour, day, appliesHour: 0, appliesDay: 0, renewalsHour: 0 };
  if (counter.hour !== hour) { counter.hour = hour; counter.appliesHour = 0; counter.renewalsHour = 0; }
  if (command.type === "apply") {
    if (counter.appliesHour >= REQUEST_RATE_LIMITS.applyHour || counter.appliesDay >= REQUEST_RATE_LIMITS.applyDay)
      throw new RequestRateError("申请过于频繁：每小时最多 12 次、每天最多 60 次成功申请，请稍后重试。");
    counter.appliesHour++; counter.appliesDay++;
  } else {
    if (counter.renewalsHour >= REQUEST_RATE_LIMITS.renewHour) throw new RequestRateError("续期过于频繁：每小时最多 12 次成功续期，请稍后重试。");
    counter.renewalsHour++;
  }
  state.requestRates = [...counters.filter(c => c.email !== actor.email), counter];
  return state;
}
