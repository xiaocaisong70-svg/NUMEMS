# TRAE CN 执行器（Codex 巡检通路适配）

本目录是 `business-seat-portal` 的独立副本。门户状态机、数据库、界面和原有 Codex 脚本保持原样；新增一条**不依赖 Codex**的执行路径，由 TRAE CN 担任操作员。

本文件描述代码路径，不代表执行器已启用或已部署。客户端目前仍连接已配置的 NUMEMS Sites 门户；本地源代码修改不等于云端已生效。

## 架构

```
门户（云端，原样）
  ├─ /api/codex      管理员 JSON-RPC（原 MCP）
  ├─ /api/portal     登录与员工页面
  └─ process_seat_queue
        └─ relay 邮件中继（云端发送，替代 Codex Gmail 连接器）

scripts/trae/checker.mjs     每轮零模型巡检 → pending.json → 退出码 3
TRAE CN 代理                 官方 admin.openai.com 页面操作（TRAE 自己的浏览器）
scripts/trae/receipt.mjs     提交 observe / claim / complete / defer 回执
```

与 Codex 方案的差异：

| 环节 | Codex 方案 | TRAE CN 方案 |
| --- | --- | --- |
| 门户通信 | spawn `codex.exe app-server` | Playwright 复用管理员已登录的门户会话，直接调 `/api/codex` |
| 唤醒 | `thread/queue/add` 投递到 Codex 聊天 | 巡检器写 `pending.json`，TRAE 按 skill 读取执行 |
| 官方页面操作 | Codex 应用内浏览器 | TRAE 自己的浏览器（必须已登录管理员账号） |
| 邮件 | Codex Gmail 连接器 | 云端 `relay` HTTPS 中继，执行器完全不发信 |
| 巡检成本 | 0 次模型调用 | 0 次模型调用（仅 TRAE 办理时消耗） |

## 新增文件

- `scripts/trae/config.mjs`：绑定站点、管理员、工作空间，并限制浏览器档案位置。
- `scripts/trae/portal-client.mjs`：管理员会话内的门户 JSON-RPC 客户端，不复制 Cookie、不伪造身份头。
- `scripts/trae/checker-core.mjs`：复用原有事件指纹、唤醒窗口、故障结算规则的纯逻辑。
- `scripts/trae/checker.mjs`：巡检 CLI；`--ack` 结束本轮，`--resume` 人工恢复，`--status` 查看状态。
- `scripts/trae/receipt.mjs`：回执 CLI。
- `scripts/trae/login.mjs`：管理员本人登录门户专用 Edge 档案。
- `scripts/trae/legacy-guard.mjs`：每次真实巡检前核实旧 Windows 任务已停用，且旧状态至少三分钟没有更新。
- `.trae/skills/numems-seat-executor/SKILL.md`：TRAE 的办理规程。
- `tests/trae-checker.test.mjs`：纯逻辑测试。

另有两处最小改动：`package.json` 增加 `trae:*` 命令；`lib/portal-service.ts` 让 `local:trae-cn:` 前缀和旧的 `local:queue-checker:` 一样显示为 on-demand 程序。

## 首次启用

本机没有全局 `node`/`npm`，实际运行时是计划任务里指定的托管 Node：

```powershell
cd D:\codexspace\business-seat-portal-trae
$NODE = "C:\Users\xcsong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

# 1. 建立门户管理员会话（本人登录，程序不接触密码）
& $NODE scripts\trae\login.mjs

# 2. 只读验收：不投递提醒、不登记调度、不写待办
& $NODE scripts\trae\checker.mjs --dry-run

# 3. 停止旧执行方并确认切换（不可并行）
#    禁用根目录 Windows 任务 NUMEMS-Seat-Queue，确认状态为 Disabled，
#    且 D:\codexspace\business-seat-portal\.sites-runtime\queue-checker\status.json 已超过 3 分钟未更新。
#    旧 Codex heartbeat 保持停用。之后才创建本地配置文件：
#    .sites-runtime/trae-executor/config.json，内容至少为 {"legacyCheckerDisabled":true}
#    程序每轮仍会自行核对真实任务状态和旧 status.json。

# 4. 云端配置并验收邮件中继
#    REMINDER_DELIVERY_MODE=relay
#    中继必须返回真实 message id，供 complete_seat_operation 记录

# 5. 巡检（零模型）
& $NODE scripts\trae\checker.mjs
```

副本已包含 `playwright` 与 `playwright-core`，新执行器无需联网安装依赖。若要运行 `npm ci`、构建或部署，需另行安装完整 Node/npm；`package.json` 中的 `trae:*` 脚本仅在 `npm` 可用时作为别名。

## 本地自检（不接触线上）

```powershell
# 构建：只写副本的 dist/.vinext
& $NODE scripts\run-framework.mjs build

# 启动本地服务：仅监听 127.0.0.1，使用本地 D1
$env:SITES_RUNTIME_ROOT = "D:\codexspace\business-seat-portal-trae\.runtime-trae"
& $NODE --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev `
  --config dist/server/wrangler.json --local --persist-to .runtime-trae/d1 `
  --ip 127.0.0.1 --port 8792 --inspector-port 0

# 首次本地运行需建表
& $NODE --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute `
  site-creator-d1 --local --persist-to .runtime-trae/d1 --config dist/server/wrangler.json `
  --file drizzle/0000_bored_stick.sql
```

本地依赖解析说明：`node_modules` 中 43 个 `@scope` 与 404 个普通包采用指向原目录的只读目录联接，`playwright`、`next`、`react`、`vite` 为实体复制。若原目录被删除，本地构建会失去联接依赖，但 TRAE 执行器仍可独立运行。

退出码 `0` 表示空闲，`3` 表示有 `pending.json`，`2` 表示暂停，`1` 表示错误。

## 切换规程

1. **先停旧执行方**：停用并核实旧计划任务 `NUMEMS-Seat-Queue` 三分钟内不再产生 `status.json`；确认 Codex 聊天里没有未完成的席位操作。
2. 配置 relay 并完成一次真实提醒验收；巡检器在 `mailMode != relay` 时会拒绝工作。
3. 在管理员页面执行 `set_codex_live(enabled:true)`，重新走一遍邀请、撤回、提醒的真实验收，不沿用 Codex 的验收结果。
4. 确保 TRAE 浏览器已登录管理员账号，且门户专用档案已完成 `trae:login`。
5. 同一工作空间只允许一个执行方写入；不得让旧巡检和 TRAE 并行。

`checker.mjs` 普通执行默认拒绝运行。只有本机配置显式写入 `legacyCheckerDisabled:true`，且每轮都通过 Windows 任务状态及原版项目状态文件新鲜度检查，才会调用 `process_seat_queue` 或登记 TRAE 调度。`--dry-run` 只读取计划；`--status`、`--ack` 和 `--resume` 不执行成员动作。

## 唯一未验证的前提

**TRAE 的浏览器能否通过 Cloudflare 打开 `admin.openai.com` 并保持管理员登录。** 原项目的独立 Playwright 档案（`seat-executor`）已被 Cloudflare 安全验证拦截，这也是它 `liveActions:false` 未上线的原因。

- 若 TRAE 复用你日常已登录的真实浏览器 → 与 Codex 应用内浏览器等价，方案完整可用。
- 若 TRAE 使用全新自动化档案 → 会撞上同一堵墙，此时不要尝试绕过验证；本方案只能完成巡检与回执，官方页面操作仍需人工或换回 Codex。

这一点只能实测，无法从代码静态判定。

## 无法替代的部分

- **无人值守**：TRAE 需要在有会话的桌面端被唤起。巡检器本身可定时运行，但办理动作仍由 TRAE 代理执行。
- **唤醒投递**：当前没有 TRAE 事件推送 API。普通 Node 检查器只写 `pending.json` 并以退出码 3 标记待办；TRAE 仍须由其自身任务或本机操作者启动，读取并处理待办。若每分钟直接唤起 TRAE 模型，会失去“仅巡检零模型”的节省效果。当前只能保证巡检阶段零模型，不能保证待办处理阶段零模型或完全无人值守。
- **邮件接入**：TRAE 客户端只接受 `mailMode=relay`。云端 HTTPS relay 必须先配置并真实验收；本机旧版 Gmail Connector 与 TRAE 客户端不通用。relay 未验收时不能声称提醒已可用。
- **浏览器登录**：门户回执使用专用 Edge 档案；官方成员操作需要 TRAE 可访问并登录 `admin.openai.com` 的浏览器。两者是不同会话，任一登录失效都会阻止完整办理。
- **旧脚本**：`scripts/queue-checker*.mjs` 仍依赖 `codex.exe`，本方案不调用它们；保留仅为回滚参考。

## 回滚

停用 TRAE 巡检，删除 `.sites-runtime/trae-executor`，重新启用旧 `NUMEMS-Seat-Queue`，并把门户的 `scheduleId` 恢复为旧值。门户数据无需迁移。
