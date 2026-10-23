throw new Error('此独立副本已停用旧调度入口；请运行 scripts/agentless/main.mjs。');
// Optional standalone scheduler. Secrets come from the process environment.
const base = process.env.SEAT_PORTAL_URL;
const token = process.env.PORTAL_WORKER_TOKEN;
const serviceToken = process.env.SITES_SERVICE_ACCESS_TOKEN;
if (!base || !token) {
  console.error("Set SEAT_PORTAL_URL and PORTAL_WORKER_TOKEN; private Sites also require supported service access.");
  process.exit(1);
}
const origin = new URL(base);
if (origin.protocol !== "https:" && origin.hostname !== "127.0.0.1") {
  throw new Error("HTTPS is required.");
}
const headers = { authorization: `Bearer ${token}` };
if (serviceToken) headers["OAI-Sites-Authorization"] = `Bearer ${serviceToken}`;
async function run() {
  try {
    const response = await fetch(new URL("/api/jobs", origin), {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(new Date().toISOString(), JSON.stringify(await response.json()));
    return true;
  } catch (error) {
    console.error(new Date().toISOString(), "Scheduler failed:", error.message);
    return false;
  }
}
const initialSuccess = await run();
if (process.argv.includes("--once") && !initialSuccess) process.exitCode = 1;
if (!process.argv.includes("--once")) {
  // Completion-based scheduling prevents overlapping runs.
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 5 * 60_000));
    await run();
  }
}
