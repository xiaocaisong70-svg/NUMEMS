# NUMEMS 原版站点的确定性执行器

原版站点继续托管网页、员工登录、白名单、申请、FIFO 排队、续期、到期判断、五分钟加入倒计时、提前释放和申请记录。新增的 `scripts/seat-executor` 是运行在管理员电脑上的普通 Node 程序：仅按现有门户计划执行，读取官方完整成员/邀请列表，经 `observe → claim → 官方操作 → 完整核实 → complete` 回报。循环本身不发起模型调用。云端 D1 状态格式和原有员工页面保持不变。

## 能力边界

- 当前 Business 工作空间没有经过验证的官方 ChatGPT 成员管理 API 与 Admin 凭据；`UnavailableOfficialMemberApi` 故意拒绝调用。程序仅对官方管理网页的可见控件作严格定位；页面、登录、工作空间、Owner、容量或角色不符合预期时停止，绝不调用 Platform API 或猜测内部接口。
- 五分钟期限以实际点击发送邀请的 UTC 时间记录；到点先核对官方状态。已成为普通成员者保留；仍是邀请者才撤回。若点击结果不明，只重新读取完整官方状态，不重复点击。
- 邮件可由原站现有的 HTTPS 中继通过云端 `runJobs` 发送，或由本机已连接 Gmail 的 App Server 传输。两条通道都无需模型；同一时间只能启用一条。发信结果不明时登记 `mail_delivery`，保留通知 ID，不自动重发。Gmail 连接器仍依赖本机 Codex 运行时及其授权状态，若希望运行时完全脱离 Codex，应选择已验收的 HTTPS 中继。
- 官方网页登录、安全校验、连接器授权或实际移除时的即时审批不能由程序跳过。尤其 `AUTOMATION.md` 记载的移除审批要求仍然有效。未经真实审批流程验收，不得将 `liveActions` 设为 `true`，也不得以脚本作为绕过被拒审批的替代途径。程序出错时隔离目标或停止，管理员核实后按原流程恢复。

## 部署和切换

1. 用 `npm ci` 安装锁定依赖，运行 `node --test tests/*.test.mjs`、`node node_modules/typescript/bin/tsc --noEmit` 和 `node scripts/run-framework.mjs build`。执行器文件不作为 Cloudflare 请求处理代码打包。
2. 在 `.sites-runtime/seat-executor/config.json` 配置确切的原版站点、工作空间和管理员资料。默认配置已绑定 `My Workspace`、四席位和 `xiaocaisong70@gmail.com`，且 `liveActions:false`。先运行 `node scripts/seat-executor/login.mjs`，由管理员本人在专用 Edge 档案的两个标签页完成官方管理后台与门户登录。密码、Cookie 和令牌不会经脚本输出或提交到 Git。之后运行 `node scripts/seat-executor/main.mjs --once` 只读核对待办数量；它不会办理成员或邮件。
3. 核实旧 `NUMEMS-Seat-Queue` 计划任务的实际状态；停止旧检查程序及任何旧唤醒入口后，确认三分钟内无新 `queue-checker/status.json` 记录，门户无未完成租约。旧版、优化版和本地零模型版不能同时对同一工作空间执行成员写入。`legacyCheckerDisabled` 只有在**真实停用并核实**后才能设为 `true`；程序还会拒绝最近仍运行过的旧检查器。
4. 邮件若选 `relay`，须先在原版 Sites 环境变量中实际配置 `REMINDER_DELIVERY_MODE=relay`、`REMINDER_WEBHOOK_URL`、`REMINDER_WEBHOOK_TOKEN`、`PORTAL_PUBLIC_URL`，并对一次真实有效提醒核对中继消息 ID。若选 `gmail_connector`，需配置本机 `codexCli`，对真实提醒核对 Gmail 消息 ID 和“已发送”，且云端不得同时启用 relay。不能通过模拟成功回执来验收。未验收通道时保持原邮件办理方式。
5. 使用真实、已批准的普通成员申请做完整加入、五分钟超时保护、续期、三十分钟提醒、到期或提前释放和回收的端到端验收。不得创建测试申请或改变真实截止时间来缩短流程。移除前若出现即时审批要求，停止并按 `AUTOMATION.md` 办理；审批拒绝时记录 `approval_required` 并保持 `liveActions:false`。只有此前所有条件满足后才可考虑开启执行器写入并登记其调度标识。当前交付默认**不接管线上任务**。

生产切换验收通过后，可在实际登录的 Windows 用户下运行 `scripts/seat-executor/install-task.ps1 -NodeExe <node.exe绝对路径>` 注册登录后自动启动的隐藏计划任务。安装器再次检查 `liveActions:true`、旧任务已停用以及用户身份；注册前先按回退手册保存旧任务 XML。安装器不会自行禁用原任务，避免误停现有服务。

`config.json` 可选设置：`pollSeconds`（10–300，默认 15）、`browserChannel`（`msedge` 或 `chrome`）、`headless`、`profile`、`mailMode`（`codex`/`gmail_connector`/`relay`）、`codexCli`、`liveActions` 和 `legacyCheckerDisabled`。`codex` 仅用于只读阶段；真实执行拒绝该模式。站点和工作空间固定校验，修改邮箱或席位数量不会自动转向另一个工作空间。

## 运行和故障

`node scripts/seat-executor/main.mjs` 常驻运行，持有独占锁，并将当前状态写入忽略版本控制的 `.sites-runtime/seat-executor/status.json`。每轮先处理云端队列，再读取最新计划；先回收、后邀请，加入核对限于邀请后第 2、4 分钟及员工主动请求。云端已有有效三十分钟提醒才会触发邮件。普通程序异常后退出，不自动重试外部动作。真实执行故障会尝试用原有本地 Codex 队列向当前管理员聊天投递**一条去重故障通知**；投递不启动模型，但聊天处理异常可能消耗模型 Token。通知投递结果不明时也不重发，并把状态保存在 `.sites-runtime/seat-executor/alert.json`。本机和 Codex 均不可用时无法保证聊天通知送达，仍须查看计划任务退出码与本地 `status.json`。`install-task.ps1` 用隐藏启动器避免反复弹出终端窗口，并设置有限次失败重启。

原有队列、页面和邮件规则由已有状态机持续提供；新程序只改变办理执行层。生产切换、失败和回退按 [回退手册](./DETERMINISTIC_EXECUTOR_ROLLBACK.md) 执行。站点回退不会撤销已发邮件或官方成员操作。
