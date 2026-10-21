import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendFatalAlert, markExecutorHealthy } from "../scripts/seat-executor/alert.mjs";
import { registerLiveSchedule, EXECUTOR_SCHEDULE_ID } from "../scripts/seat-executor/main.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "numems-alert-test-"));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, alertPath: path.join(directory, "alert.json"),
    checkerConfigPath: path.join(directory, "checker.json") };
}

function fakeClient({ enqueue, queued = async () => [] } = {}) {
  return { on() {}, async initialize() {},
    async enqueue(...args) { return enqueue(...args); },
    async queued(...args) { return queued(...args); },
    async close() {} };
}
const destination = { liveActions: true, alertCli: process.execPath,
  alertThreadId: "thread-12345678" };

test("dry-run failure never writes an alert or contacts App Server", async t => {
  const files = await fixture(t);
  let opened = 0;
  const result = await sendFatalAlert({ ...files, config: { ...destination, liveActions: false },
    clientFactory() { opened++; throw new Error("Should not open App Server"); } });
  assert.equal(result.state, "disabled");
  assert.equal(opened, 0);
  await assert.rejects(readFile(files.alertPath), { code: "ENOENT" });
});

test("fatal live alert persists intent before enqueue and deduplicates after receipt", async t => {
  const files = await fixture(t);
  let writes = 0;
  const client = fakeClient({ async enqueue(threadId, clientId, message) {
    writes++;
    const intent = JSON.parse(await readFile(files.alertPath, "utf8"));
    assert.equal(intent.phase, "enqueuing");
    assert.equal(intent.clientId, clientId);
    assert.equal(threadId, destination.alertThreadId);
    assert.match(message, /确定性执行器故障告警/);
    assert.doesNotMatch(message, /secret-password/);
    return { queuedSubmission: { id: "queued-1" } };
  } });
  const args = { ...files, config: destination, newId: () => "alert-one",
    clientFactory: () => client };
  assert.equal((await sendFatalAlert(args)).state, "queued");
  assert.equal((await sendFatalAlert(args)).state, "deduped");
  assert.equal(writes, 1);
  assert.equal(JSON.parse(await readFile(files.alertPath, "utf8")).queuedId, "queued-1");
});

test("unknown queue/add outcome is persisted and never resent", async t => {
  const files = await fixture(t);
  let writes = 0, reads = 0;
  const client = fakeClient({ async enqueue() { writes++; throw new Error("timeout"); },
    async queued() { reads++; return []; } });
  const args = { ...files, config: destination, newId: () => "alert-unknown",
    clientFactory: () => client };
  assert.equal((await sendFatalAlert(args)).state, "uncertain");
  assert.equal((await sendFatalAlert(args)).state, "uncertain");
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(JSON.parse(await readFile(files.alertPath, "utf8")).phase, "uncertain");
});

test("an interrupted enqueue is reconciled read-only by its durable client ID", async t => {
  const files = await fixture(t);
  await writeFile(files.alertPath, JSON.stringify({ version: 1, id: "alert-previous",
    clientId: "numems-executor-alert:alert-previous", phase: "enqueuing",
    createdAt: "2026-10-20T00:00:00Z" }));
  let writes = 0;
  const result = await sendFatalAlert({ ...files, config: destination,
    clientFactory: () => fakeClient({
      async enqueue() { writes++; throw new Error("Must not enqueue"); },
      async queued() { return [{ id: "queued-previous",
        clientUserMessageId: "numems-executor-alert:alert-previous" }]; },
    }) });
  assert.equal(result.state, "queued");
  assert.equal(writes, 0);
  assert.equal(JSON.parse(await readFile(files.alertPath, "utf8")).queuedId, "queued-previous");
});

test("missing destination preserves a prepared alert for later configuration", async t => {
  const files = await fixture(t);
  const first = await sendFatalAlert({ ...files, config: { liveActions: true },
    newId: () => "alert-pending" });
  assert.equal(first.state, "not_configured");
  let writes = 0;
  const second = await sendFatalAlert({ ...files, config: destination,
    clientFactory: () => fakeClient({ async enqueue(_thread, clientId) {
      writes++; assert.equal(clientId, "numems-executor-alert:alert-pending");
      return { queuedSubmission: { id: "queued-later" } };
    } }) });
  assert.equal(second.state, "queued");
  assert.equal(writes, 1);
});

test("a checker destination is reused only when bound to this project", async t => {
  const files = await fixture(t);
  await writeFile(files.checkerConfigPath, JSON.stringify({ projectPath: files.directory,
    cli: process.execPath, threadId: "thread-87654321" }));
  let target;
  const result = await sendFatalAlert({ ...files, projectRoot: files.directory,
    config: { liveActions: true }, clientFactory(cli, options) {
      target = { cli, cwd: options.cwd };
      return fakeClient({ async enqueue(threadId) {
        assert.equal(threadId, "thread-87654321");
        return { queuedSubmission: { id: "queued-checker" } };
      } });
    } });
  assert.equal(result.state, "queued");
  assert.deepEqual(target, { cli: process.execPath, cwd: files.directory });
});

test("a later healthy live cycle closes the incident before another fatal stop", async t => {
  const files = await fixture(t);
  const ids = ["alert-old", "alert-new"];
  const client = fakeClient({ async enqueue() { return { queuedSubmission: { id: "queued" } }; } });
  const args = { ...files, config: destination, newId: () => ids.shift(),
    clientFactory: () => client };
  assert.equal((await sendFatalAlert(args)).id, "alert-old");
  await markExecutorHealthy(files.alertPath, () => new Date("2026-10-20T01:00:00Z"));
  assert.equal((await sendFatalAlert(args)).id, "alert-new");
});

test("new schedule marker is registered once only after a healthy live cycle", async () => {
  const calls = [], portal = { async call(name, args) { calls.push({ name, args }); } },
    browser = { async observe() { calls.push({ name: "official_observe" }); } };
  let registered = await registerLiveSchedule({ config: { liveActions: false }, portal, browser,
    result: { mode: "dry_run" } });
  assert.equal(registered, false);
  registered = await registerLiveSchedule({ config: destination, portal, browser,
    result: { mode: "mail_channel_required" }, registered });
  assert.equal(registered, false);
  registered = await registerLiveSchedule({ config: destination, portal, browser,
    result: { mode: "idle" }, registered });
  assert.equal(registered, true);
  assert.deepEqual(calls, [{ name: "official_observe" }, { name: "record_codex_schedule",
    args: { scheduleId: EXECUTOR_SCHEDULE_ID } }]);
  await registerLiveSchedule({ config: destination, portal, browser,
    result: { mode: "remove_verified" }, registered });
  assert.equal(calls.length, 2);
});

test("schedule stays unregistered if the official inventory is unavailable", async () => {
  let wrote = false;
  const portal = { async call() { wrote = true; } };
  const browser = { async observe() { throw new Error("login expired"); } };
  await assert.rejects(registerLiveSchedule({ config: destination, portal, browser,
    result: { mode: "idle" } }), /login expired/);
  assert.equal(wrote, false);
});
