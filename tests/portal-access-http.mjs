// Exercises only the loopback preview and its local D1 fixture; never production.
import assert from "node:assert/strict";
import { readdirSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createState, transition, PROTECTED_OWNER_EMAIL } from "../lib/seat-engine.ts";

const base = process.env.TEST_PORTAL_URL ?? "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Local preview only");
const root = realpathSync(resolve(".wrangler/state/v3/d1"));
const candidates = readdirSync(root, { recursive: true })
  .filter(name => String(name).endsWith(".sqlite") && !String(name).endsWith("metadata.sqlite"));
let db;
for (const name of candidates) {
  const path = realpathSync(resolve(root, String(name)));
  const local = relative(root, path);
  assert.ok(local && !local.startsWith("..") && !isAbsolute(local), "Local D1 path only");
  const candidate = new DatabaseSync(path);
  if (candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_state'").get()) {
    assert.equal(db, undefined, "Only one local portal database may be tested");
    db = candidate;
  } else candidate.close();
}
assert.ok(db, "Start the preview with the local portal migration applied");
const original = db.prepare("SELECT document,revision FROM portal_state WHERE id='main'").get();
assert.ok(original, "Local portal state must exist");
const restore = db.prepare("UPDATE portal_state SET document=?,revision=? WHERE id='main'");
const save = state => restore.run(JSON.stringify(state), state.revision);
const read = () => JSON.parse(db.prepare("SELECT document FROM portal_state WHERE id='main'").get().document);
const owner = { userId: "fixture-owner", email: PROTECTED_OWNER_EMAIL, isAdmin: true };
const other = { userId: "fixture-other", email: "private-peer@example.test", isAdmin: false };
const NOW = new Date().toISOString();
let checks = 0;
try {
  let fixture = transition(createState(NOW), owner, { type: "configure", config: {
    whitelist: [other.email], automationEnabled: false,
  } }, NOW);
  fixture = transition(fixture, other, {
    type: "apply", name: "Private peer", reason: "PRIVATE_OTHER_EMPLOYEE_REASON", hours: 1,
  }, NOW);
  save(fixture);
  const request = (path, init) => fetch(new URL(path, base), init);
  const login = await request("/signin-with-chatgpt?return_to=/", { redirect: "manual" });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const signedGet = () => request("/api/portal", { headers: { cookie } });
  const post = body => request("/api/portal", {
    method: "POST", headers: { origin: base, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const denied = await signedGet();
  assert.equal(denied.status, 403);
  const closed = await denied.json();
  assert.equal(closed.access, "not_authorized");
  assert.equal(closed.view, null);
  assert.equal(JSON.stringify(closed).includes(other.email), false);
  checks++;
  for (const type of ["apply", "renew", "release", "configure", "confirm_removed"]) {
    const r = await post({ type, email: other.email, isAdmin: true, id: fixture.requests[0].id });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).access, "not_authorized");
    checks++;
  }
  assert.deepEqual(read(), fixture, "Rejected requests must not change the stored document");
  checks++;
  const deniedPage = await (await request("/", { headers: { cookie } })).text();
  assert.match(deniedPage, /此邮箱尚未开通访问/);
  assert.equal(deniedPage.includes("PRIVATE_OTHER_EMPLOYEE_REASON"), false);
  checks++;

  // Give the same verified local identity portal access, with no workspace membership.
  fixture.config.whitelist.push("seedy@sites.test");
  save(fixture);
  const allowed = await signedGet();
  assert.equal(allowed.status, 200);
  const data = await allowed.json();
  assert.equal(data.access, "allowed");
  assert.equal(data.view.eligible, true);
  assert.deepEqual(data.view.requests, []);
  assert.equal(JSON.stringify(data).includes(other.email), false);
  assert.equal("whitelist" in data.view.config, false);
  checks++;
  const applied = await post({ type: "apply", name: "Local employee", reason: "Returning to request a seat", hours: 1 });
  assert.equal(applied.status, 200);
  const submitted = await applied.json();
  assert.equal(submitted.view.requests.length, 1);
  assert.equal(submitted.view.requests[0].email, "seedy@sites.test");
  assert.equal(submitted.view.requests[0].status, "queued");
  assert.equal(JSON.stringify(submitted).includes("PRIVATE_OTHER_EMPLOYEE_REASON"), false);
  checks++;
  const escalated = await post({ type: "configure", isAdmin: true, config: { totalSeats: 9 } });
  assert.equal(escalated.status, 400);
  assert.match((await escalated.json()).error, /管理员/);
  checks++;

  const revoked = read();
  revoked.config.whitelist = [other.email];
  save(revoked);
  assert.equal((await signedGet()).status, 403, "Access must be checked on every read");
  const staleSession = await post({ type: "cancel", id: submitted.view.requests[0].id });
  assert.equal(staleSession.status, 403, "A previous login must not retain revoked access");
  assert.deepEqual(read(), revoked);
  checks++;
  console.log(`${checks} local HTTP access-isolation checks passed; fixture will be restored.`);
} finally {
  restore.run(original.document, original.revision);
  db.close();
}
