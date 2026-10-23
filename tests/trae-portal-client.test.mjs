import { test } from "node:test";
import assert from "node:assert/strict";
import { TraePortalClient } from "../scripts/trae/portal-client.mjs";

const config = {
  siteUrl: "https://example.invalid/", adminEmail: "a@b.c", workspaceId: "w",
  profile: "p", headless: true, browserChannel: "",
};

test("解析门户回执文本", async () => {
  const client = new TraePortalClient(config);
  client.page = {
    evaluate: async (_fn, arg) => ({
      status: 200,
      body: { jsonrpc: "2.0", id: arg.id,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true, plan: { enabled: false } }) }] } },
    }),
  };
  assert.deepEqual(await client.call("seat_portal_status"),
    { ok: true, plan: { enabled: false } });
});

test("门户报错或返回非 JSON 时拒绝确认", async () => {
  const failed = new TraePortalClient(config);
  failed.page = {
    evaluate: async (_fn, arg) => ({ status: 200,
      body: { jsonrpc: "2.0", id: arg.id, result: { isError: true, content: [] } } }),
  };
  await assert.rejects(() => failed.call("seat_portal_status"), /未能确认/);

  const malformed = new TraePortalClient(config);
  malformed.page = {
    evaluate: async (_fn, arg) => ({ status: 200,
      body: { jsonrpc: "2.0", id: arg.id,
        result: { content: [{ type: "text", text: "not-json" }] } } }),
  };
  await assert.rejects(() => malformed.call("seat_portal_status"), /非预期回执/);
});

test("拒绝执行器白名单以外的门户工具", async () => {
  const client = new TraePortalClient(config);
  await assert.rejects(() => client.call("set_codex_live"), /不允许/);
});
