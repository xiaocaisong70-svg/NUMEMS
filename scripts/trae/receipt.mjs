// 供 TRAE 代理在完成官方页面操作后提交门户回执。
// 用法：node scripts/trae/receipt.mjs <tool> '<json>'   或   <tool> @args.json
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { TraePortalClient } from "./portal-client.mjs";

const usage = `用法：node scripts/trae/receipt.mjs <tool> ['<json>' | @文件]
tool: process_seat_queue | seat_portal_status | observe_workspace |
      claim_seat_operation | complete_seat_operation | defer_seat_operation |
      review_seat_failure | record_codex_schedule`;

const [tool, raw] = process.argv.slice(2);
if (!tool) {
  console.error(usage);
  process.exit(1);
}

let args = {};
try {
  if (raw?.startsWith("@")) args = JSON.parse(await readFile(raw.slice(1), "utf8"));
  else if (raw) args = JSON.parse(raw);
} catch (error) {
  console.error(`参数 JSON 无法解析：${error.message}\n${usage}`);
  process.exit(1);
}

const client = new TraePortalClient(await loadConfig());
try {
  const result = await client.call(tool, args);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // 结果未经证实，禁止调用方自动重试外部动作。
  console.error(`门户回执未确认：${error.message}`);
  console.error("请先核对官方页面真实状态；不得盲目重试。");
  process.exitCode = 1;
} finally {
  await client.close();
}
