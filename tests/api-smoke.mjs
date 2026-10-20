import assert from "node:assert/strict";
const base = process.env.TEST_PORTAL_URL ?? "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Local preview only");
let checks = 0;
const request = (path, init) => fetch(new URL(path, base), init);
const health = await request("/api/health");
assert.equal(health.status, 200);
assert.equal((await health.json()).storage, "ready");
checks++;
const publicResponse = await request("/api/portal");
assert.equal(publicResponse.status, 401);
assert.match(publicResponse.headers.get("cache-control"), /no-store/);
const publicData = await publicResponse.json();
assert.equal(publicData.user, null);
assert.equal(publicData.access, "signin_required");
assert.equal(JSON.stringify(publicData).includes("whitelist"), false);
assert.equal(JSON.stringify(publicData).includes("2712467009"), false);
assert.equal(publicData.view, null);
assert.equal(JSON.stringify(publicData).includes("availableSeats"), false);
checks++;
const anonymousPage = await (await request("/")).text();
assert.match(anonymousPage, /使用 ChatGPT 登录/);
assert.equal(anonymousPage.includes("whitelist"), false);
checks++;
const fakeIdentity = await request("/api/portal", { headers: {
  "oai-authenticated-user-id": "forged",
  "oai-authenticated-user-email": "xiaocaisong70@gmail.com",
} });
assert.equal(fakeIdentity.status, 401, "The preview dispatch strips caller-supplied identity headers");
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
const signIn = await request("/signin-with-chatgpt?return_to=/", { redirect: "manual" });
assert.equal(signIn.status, 302);
const employeeCookie = signIn.headers.get("set-cookie")?.split(";")[0];
assert.ok(employeeCookie, "Preview employee sign-in must succeed");
const employeeResponse = await request("/api/portal", {
  headers: { cookie: employeeCookie },
});
assert.ok([200, 403].includes(employeeResponse.status));
const employeeBefore = await employeeResponse.json();
assert.equal(employeeBefore.user.email, "seedy@sites.test");
assert.equal(employeeBefore.user.isAdmin, false);
if (employeeResponse.status === 403) {
assert.equal(employeeBefore.access, "not_authorized");
assert.equal(employeeBefore.view, null);
for (const type of ["apply", "renew", "release", "configure", "confirm_removed"]) {
  const denied = await request("/api/portal", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie: employeeCookie },
    body: JSON.stringify({ type, id: "not-owned" }),
  });
  assert.equal(denied.status, 403, `${type} must check the whitelist before executing`);
  assert.equal((await denied.json()).access, "not_authorized");
  checks++;
}
}
for (const path of ["/mcp", "/api/codex"]) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "process_seat_queue", arguments: {} } });
  for (const cookie of [undefined, employeeCookie]) {
    const denied = await request(path, { method: "POST", body,
      headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    });
    assert.equal(denied.status, 200);
    const error = (await denied.json()).result;
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /管理员/);
    checks++;
  }
  const crossSite = await request(path, { method: "POST", body,
    headers: { origin: "https://unrelated.example", "content-type": "application/json", cookie: employeeCookie },
  });
  assert.equal(crossSite.status, 403);
  checks++;
  const nonJson = await request(path, { method: "POST", body,
    headers: { origin: base, "content-type": "text/plain" },
  });
  assert.equal(nonJson.status, 415);
  checks++;
}
const employeeAfter = await (await request("/api/portal", {
  headers: { cookie: employeeCookie },
})).json();
assert.deepEqual(employeeAfter.view, employeeBefore.view, "Rejected worker calls must not mutate state");
checks++;
console.log(`${checks} preview HTTP checks passed.`);
