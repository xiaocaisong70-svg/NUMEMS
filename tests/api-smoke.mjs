import assert from "node:assert/strict";
const base = process.env.TEST_PORTAL_URL ?? "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Local preview only");
let checks = 0;
const request = (path, init) => fetch(new URL(path, base), init);
const health = await request("/api/health");
assert.equal(health.status, 200);
assert.equal((await health.json()).storage, "ready");
checks++;
const publicData = await (await request("/api/portal")).json();
assert.equal(publicData.user, null);
assert.equal(JSON.stringify(publicData).includes("whitelist"), false);
assert.equal(JSON.stringify(publicData).includes("2712467009"), false);
assert.equal(publicData.view.requests.length, 0);
checks++;
for (const type of ["apply", "configure", "confirm_removed"]) {
  const response = await request("/api/portal", {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ type }),
  });
  assert.equal(response.status, 401, type);
  checks++;
}
const csrf = await request("/api/portal", {
  method: "POST", headers: { origin: "https://unrelated.example" },
  body: '{"type":"apply"}',
});
assert.equal(csrf.status, 403);
checks++;
const mcpCsrf = await request("/mcp", {
  method: "POST",
  headers: { origin: "https://unrelated.example", "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"process_seat_queue"}}',
});
assert.equal(mcpCsrf.status, 403);
checks++;
const noWorkerAuth = await request("/api/jobs", { method: "POST" });
assert.equal(noWorkerAuth.status, 401);
checks++;
console.log(`${checks} preview HTTP checks passed.`);
