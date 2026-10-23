import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLegacyInactive } from "../scripts/trae/legacy-guard.mjs";

const absentStatus = async () => { const error = new Error("not found"); error.code = "ENOENT"; throw error; };

test("旧任务未在配置中确认停用时，在查询计划任务前失败关闭", async () => {
  let queried = false;
  await assert.rejects(assertLegacyInactive({ legacyCheckerDisabled: false }, Date.now(), async () => {
    queried = true;
    return "Disabled";
  }, absentStatus), /未在本机配置中确认停用/);
  assert.equal(queried, false);
});

test("旧 Windows 任务仍启用或最近仍有巡检记录时禁止 TRAE 执行", async () => {
  const stale = JSON.stringify({ checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  await assert.rejects(assertLegacyInactive({ legacyCheckerDisabled: true }, Date.now(),
    async () => "Ready", async () => stale), /状态为 Ready/);

  const recent = JSON.stringify({ checkedAt: new Date(Date.now() - 30_000).toISOString() });
  await assert.rejects(assertLegacyInactive({ legacyCheckerDisabled: true }, Date.now(),
    async () => "Disabled", async () => recent), /最近仍在运行/);
});

test("旧任务明确禁用且三分钟以上未运行后才允许切换", async () => {
  const stale = JSON.stringify({ checkedAt: new Date(Date.now() - 4 * 60_000).toISOString() });
  const result = await assertLegacyInactive({ legacyCheckerDisabled: true }, Date.now(),
    async () => "Disabled", async () => stale);
  assert.equal(result.legacyTaskState, "Disabled");
});
