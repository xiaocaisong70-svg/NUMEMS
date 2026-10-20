"use client";
import { useEffect, useState } from "react";
import { serverClock } from "../lib/portal-time";
export function usePortalClock(sample?: string) {
  const [clock, setClock] = useState({ now: Date.parse(sample ?? ""), stale: false });
  useEffect(() => {
    if (!sample) return;
    const receivedAt = performance.now();
    const tick = () => setClock({ now: serverClock(sample, receivedAt, performance.now()),
      stale: performance.now() - receivedAt > 45_000 });
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sample]);
  return clock;
}
