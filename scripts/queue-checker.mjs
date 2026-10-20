import { readFile, writeFile, mkdir, rename, open, unlink } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server-client.mjs";
import { prepareWake, wakeMessage, acknowledgementOutcome, SCHEDULE_ID } from "./queue-checker-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, ".sites-runtime", "queue-checker");
const configPath = join(directory, "config.json");
const statePath = join(directory, "state.json");
const statusPath = join(directory, "status.json");
const lockPath = join(directory, "checker.lock");
const args = process.argv.slice(2);
const argument = name => args[args.indexOf(name) + 1];
async function readJson(path, fallback) {
  try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
async function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
async function lock() {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return async () => { await handle.close(); await unlink(lockPath); };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = await readJson(lockPath);
    if (!Number.isInteger(old.pid)) throw Error("Invalid lock; manual review required.");
    try { process.kill(old.pid, 0); return null; }
    catch (check) {
      if (check.code !== "ESRCH") return null;
      // Only remove this exact stale lock after proving its owner no longer exists.
      await unlink(lockPath); return lock();
    }
  }
}

await mkdir(directory, { recursive: true });
if (args.includes("--ack")) {
  const id = argument("--ack"), outcome = argument("--outcome");
  if (!/^[0-9a-f-]{36}$/.test(id ?? "") || !["done", "blocked", "uncertain"].includes(outcome))
    throw Error("Invalid acknowledgement.");
  const state = await readJson(statePath);
  const ackPath = join(directory, `ack-${id}.json`);
  const old = await readJson(ackPath, null);
  if (old) {
    if (old.outcome !== outcome) throw Error("Acknowledgement already recorded with a different outcome.");
  } else {
    if (state.active?.id !== id) throw Error("Acknowledgement does not match the active wake.");
    await save(ackPath, { id, outcome, at: new Date().toISOString() });
  }
  console.log(`NUMEMS wake acknowledgement saved: ${outcome}.`);
}
const unlock = args.includes("--ack") ? null : await lock();
if (!unlock) { process.exitCode = 0; }
else {
  let client;
  try {
    const state = await readJson(statePath, { version: 1, seen: {}, checks: 0, wakes: 0 });
    const savedAck = state.active
      ? await readJson(join(directory, `ack-${state.active.id}.json`), null) : null;
    if (args.includes("--resume")) {
      // Run explicitly only after resolving the actual blocking condition.
      if (state.active) throw Error("An unacknowledged wake still exists; reconcile it first.");
      delete state.halted;
      for (const [key, item] of Object.entries(state.seen))
        if (item.outcome !== "done") delete state.seen[key];
      await save(statePath, state); console.log("NUMEMS dispatch resumed.");
    } else if (args.includes("--status")) {
      console.log(JSON.stringify(await readJson(statusPath, { state: "not_started" }), null, 2));
    } else {
      const config = await readJson(configPath);
      if (!config.cli || !config.threadId || config.projectPath !== root)
        throw Error("Checker configuration is missing or inconsistent.");
      // Use the user's normal Codex credential store. No passwords, cookies,
      // connector bearer tokens or current-turn environment are copied or saved.
      const cleanEnv = Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !/^(CODEX|OPENAI|MCP|CXX|RUST)/i.test(key)));
      client = new AppServerClient(config.cli, { cwd: root, env: cleanEnv });
      let interactive = false;
      client.on("interactiveRequest", () => { interactive = true; });
      await client.initialize();
      const toolSession = await client.createToolSession(root);
      await client.portal(toolSession, "process_seat_queue");
      const snapshot = await client.portal(toolSession, "seat_portal_status");
      if (interactive) throw Error("Connector approval required; checker cannot approve it.");
      if (savedAck) {
        const outcome = acknowledgementOutcome(state.active, savedAck, snapshot.plan);
        for (const key of state.active.keys) state.seen[key] = { at: savedAck.at, outcome };
        state.lastAcknowledgement = { ...savedAck, outcome };
        if (outcome !== "done") state.halted = { reason: "ack_" + outcome, at: savedAck.at };
        delete state.active;
      }
      const decision = prepareWake(state, snapshot.plan);
      state.checks++;
      if (decision.kind === "stalled") {
        state.halted = { reason: "wake_not_acknowledged", at: new Date().toISOString() };
      }
      if (decision.kind === "wake") {
        const id = randomUUID();
        // Persist intent BEFORE sending. A crash can never cause a blind resend.
        state.active = { id, clientId: `numems:${id}`, phase: "sending",
          keys: decision.events.map(item => item.key), createdAt: new Date().toISOString() };
        await save(statePath, state);
        try {
          const queued = await client.enqueue(config.threadId, state.active.clientId,
            wakeMessage(id, decision.events, root));
          if (!queued.queuedSubmission?.id) throw Error("Queue receipt missing.");
          state.active.phase = "queued"; state.active.queuedId = queued.queuedSubmission.id;
          state.wakes++;
        } catch {
          state.active.phase = "uncertain";
          state.halted = { reason: "queue_result_unknown", at: new Date().toISOString() };
          // Keep the intent and stop: do not re-enqueue after an unknown response.
        }
      }
      if (state.active?.phase === "sending") {
        const queued = await client.queued(config.threadId);
        const found = queued.find(item => item.clientUserMessageId === state.active.clientId);
        if (found) { state.active.phase = "queued"; state.active.queuedId = found.id; }
        else {
          state.active.phase = "uncertain";
          state.halted = { reason: "interrupted_queue_write", at: new Date().toISOString() };
        }
      }
      const registeredId = state.halted || config.taskName !== "NUMEMS-Seat-Queue" ||
        !snapshot.plan.enabled || snapshot.plan.testOnly || snapshot.plan.lastError ? "" : SCHEDULE_ID;
      if (snapshot.plan.scheduleId !== registeredId)
        await client.portal(toolSession, "record_codex_schedule", { scheduleId: registeredId });
      await save(statePath, state);
      const status = { checkedAt: new Date().toISOString(), mode: "ordinary_program",
        state: state.halted ? "blocked" : state.active ? "waiting_for_codex" : decision.kind,
        modelCallsByChecker: 0, queueWakes: state.wakes, checks: state.checks,
        pending: { invites: snapshot.plan.invites.length, removals: snapshot.plan.removals.length,
          reminders: snapshot.plan.reminders.length, acceptance: snapshot.plan.awaitingAcceptance.length },
        ...(state.halted ? { reason: state.halted.reason } : {}),
        ...(state.active ? { wakeId: state.active.id } : {}),
      };
      await save(statusPath, status);
      // Task Scheduler captures the exit code. No per-minute chat or email noise.
      if (args.includes("--once")) console.log(JSON.stringify(status));
    }
  } catch (error) {
    await save(statusPath, { checkedAt: new Date().toISOString(), mode: "ordinary_program",
      state: "error", modelCallsByChecker: 0, error: error.message });
    console.error(`NUMEMS checker: ${error.message}`); process.exitCode = 1;
  } finally { await client?.close(); await unlock(); }
}
