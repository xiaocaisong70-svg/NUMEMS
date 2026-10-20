/** No client wall clock is used for a live countdown. */
export function serverClock(sample: string, receivedAt: number, monotonicNow: number) {
  return Date.parse(sample) + Math.max(0, monotonicNow - receivedAt);
}
export function remainingSeconds(deadline: string | null | undefined, nowMs: number) {
  if (!deadline || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((Date.parse(deadline) - nowMs) / 1000));
}
export function countdownText(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
