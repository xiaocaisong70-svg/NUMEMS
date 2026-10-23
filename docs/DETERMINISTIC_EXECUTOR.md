> 历史参考：本副本实际运行请遵循 docs/AGENTLESS-IMPLEMENTATION.md；不要执行下列旧版安装或切换命令。

# NUMEMS 原版站点的确定性执行器

原版站点继续托管网页、员工登录、白名单、申请、FIFO 排队、续期、到期判断、五分钟加入倒计时、提前释放和申请记录。新增的 `scripts/seat-executor` 是运行在管理员电脑上的普通 Node 程序：仅按现有门户计划执行，读取官方完整成员/邀请列表，经 `observe → claim → 官方操作 → 完整核实 → complete` 回报。循环本身不发起模型调用。云端 D1 状态格式和原有员工页面保持不变。

## 能力边界

- 当前 Business 工作空间没有经过验证的官方 ChatGPT 成员管理 API 与 Admin 凭据；`UnavailableOfficialMemberApi` 故意拒绝调用。程序仅对官方管理网页的可见控件作严格定位；页面、登录、工作空间、Owner、容量或角色不符合预期时停止，绝不调用 Platform API 或猜测内部接口。
- 2026-10-20 对此工作空间的真实只读验收发现：管理员在普通 Edge 中登录后，自动化浏览器打开 `admin.openai.com` 仍被 Cloudflare 安全验证拦截，无法读取完整成员清单。因此**不得启用**本执行器的真实邀请／移除，也不得绕过验证、复用私有接口或把 Platform 组织 API 当作 ChatGPT Business 席位 API。旧 `NUMEMS-Seat-Queue` 必须继续负责当前成员办理；只有官方页面自动读取恢复并通过真实验收，或 OpenAI 提供此工作空间可用的正式成员接口，才能重新评估切换。
- 五分钟期限以实际点击发送邀请的 UTC 时间记录；到点先核对官方状态。已成为普通成员者保留；仍是邀请者才撤回。若点击结果不明，只重新读取完整官方状态，不重复点击。
- 邮件可由原站现有的 HTTPS 中继通过云端 `runJobs` 发送，或由本机已连接 Gmail 的 App Server 传输。两条通道都无需模型；同一时间只能启用一条。发信结果不明时登记 `mail_delivery`，保留通知 ID，不自动重发。Gmail 连接器仍依赖本机 Codex 运行时及其授权状态，若希望运行时完全脱离 Codex，应选择已验收的 HTTPS 中继。
- 官方网页登录、安全校验、连接器授权或实际移除时的即时审批不能由程序跳过。尤其 `AUTOMATION.md` 记载的移除审批要求仍然有效。未经真实审批流程验收，不得将 `liveActions` 设为 `true`，也不得以脚本作为绕过被拒审批的替代途径。程序出错时隔离目标或停止，管理员核实后按原流程恢复。

## 当前可行的混合优化

原有 `NUMEMS-Seat-Queue` 巡检已经在普通程序中检查待办，空队列不唤醒模型。新增的邮件分支可在本机旧巡检配置中**显式**设置 `mailMode: "gmail_connector"` 后，直接调用已连接 Gmail 发送有效的到期前 30 分钟提醒，保存消息 ID，并只把邀请、移除和加入核对交给原 Codex 办理。缺省或 `mailMode: "codex"` 时维持改造前的全部路径。此路径使用 Codex App Server 作连接器传输，但不发起模型轮次；每次领取前及发送前均核对发件账号为 `xiaocaisong70@gmail.com`。启用前应完成账号连通性检查，首封有效提醒须核对真实 Gmail 回执，若异常立即按回退手册停用。

若发送结果不明，门户登记 `mail_delivery` 隔离该通知，禁止自动重发。云端邮件模式若切成 relay，本机直发会拒绝运行，防止双通道。2026-10-20 本机时间，管理员授权向本人邮箱发送了一封独立的通道测试邮件，App Server 返回 Gmail 消息 ID （保存在本机验收记录中），在 Gmail“已发送”中核对一致；随后本机旧巡检配置启用了 `mailMode: "gmail_connector"`。测试不涉及席位，不能代替首封由普通程序直接发送的真实提醒验收。切换前已有的 Codex 邮件唤醒 （原通知标识留存本机） 由原路径办理，普通程序排除了它；Gmail 已发送、门户回执及旧唤醒确认均完成，消息 ID （保存在本机验收记录中）。Cloudflare 验证阻止了官方成员页面的无人值守核对，所以此邮件优化不改变成员办理归属。若启用后异常，先把旧巡检配置的 `mailMode` 恢复为 `codex`，核对未完成邮件租约和 Gmail 已发送记录，再恢复巡检；不能仅改配置就重发结果不明的通知。

## 部署和切换

1. 用 `npm ci` 安装锁定依赖，运行 `node --test tests/*.test.mjs`、`node node_modules/typescript/bin/tsc --noEmit` 和 `node scripts/run-framework.mjs build`。执行器文件不作为 Cloudflare 请求处理代码打包。
2. 在 `.sites-runtime/seat-executor/config.json` 配置确切的原版站点、工作空间和管理员资料。默认配置已绑定 `My Workspace`、四席位和 `xiaocaisong70@gmail.com`，且 `liveActions:false`。先运行 `node scripts/seat-executor/login.mjs`：脚本会打开**普通系统 Edge** 的隔离档案，由管理员本人在两个标签页登录官方管理后台与门户；确认后关闭这次专用 Edge 窗口，再在终端按 Enter。脚本只在窗口关闭后用 Playwright 读取官方完整成员/邀请列表和门户管理员状态，不在自动化浏览器中执行 Google/OpenAI 登录，也不关闭用户原有 Edge 窗口。密码、Cookie 和令牌不会经脚本输出或提交到 Git。若 Google 仍提示浏览器不安全，请使用普通 Edge 完成必要的本人安全验证；验证失败则保持 `liveActions:false`，不改用已登录的日常浏览器档案或绕过安全校验。之后运行 `node scripts/seat-executor/main.mjs --once` 只读核对待办数量；它不会办理成员或邮件。
3. 核实旧 `NUMEMS-Seat-Queue` 计划任务的实际状态；停止旧检查程序及任何旧唤醒入口后，确认三分钟内无新 `queue-checker/status.json` 记录，门户无未完成租约。旧版、优化版和本地零模型版不能同时对同一工作空间执行成员写入。`legacyCheckerDisabled` 只有在**真实停用并核实**后才能设为 `true`；真实执行的每一轮还会从 Windows 查询旧任务必须为 `Disabled`，并拒绝最近仍运行过的旧检查器。任务缺失或系统查询失败时也会停止，不把配置标志当作停用证据。
4. 邮件若选 `relay`，须先在原版 Sites 环境变量中实际配置 `REMINDER_DELIVERY_MODE=relay`、`REMINDER_WEBHOOK_URL`、`REMINDER_WEBHOOK_TOKEN`、`PORTAL_PUBLIC_URL`，并对一次真实有效提醒核对中继消息 ID。若选 `gmail_connector`，需配置本机 `codexCli`，对真实提醒核对 Gmail 消息 ID 和“已发送”，且云端不得同时启用 relay。不能通过模拟成功回执来验收。未验收通道时保持原邮件办理方式。
5. 使用真实、已批准的普通成员申请做完整加入、五分钟超时保护、续期、三十分钟提醒、到期或提前释放和回收的端到端验收。不得创建测试申请或改变真实截止时间来缩短流程。移除前若出现即时审批要求，停止并按 `AUTOMATION.md` 办理；审批拒绝时记录 `approval_required` 并保持 `liveActions:false`。只有此前所有条件满足后才可考虑开启执行器写入并登记其调度标识。当前交付默认**不接管线上任务**。

生产切换验收通过后，可在实际登录的 Windows 用户下运行 `scripts/seat-executor/install-task.ps1 -NodeExe <node.exe绝对路径>` 注册登录后自动启动的隐藏计划任务。安装器再次检查 `liveActions:true`、旧任务已停用以及用户身份；注册前先按回退手册保存旧任务 XML。安装器不会自行禁用原任务，避免误停现有服务。

`config.json` 可选设置：`pollSeconds`（10–300，默认 15）、`browserChannel`（`msedge` 或 `chrome`）、`headless`、`profile`、`mailMode`（`codex`/`gmail_connector`/`relay`）、`codexCli`、`liveActions` 和 `legacyCheckerDisabled`。`codex` 仅用于只读阶段；真实执行拒绝该模式。站点和工作空间固定校验，修改邮箱或席位数量不会自动转向另一个工作空间。

## 运行和故障

`node scripts/seat-executor/main.mjs` 常驻运行，持有独占锁，并将当前状态写入忽略版本控制的 `.sites-runtime/seat-executor/status.json`。每轮先处理云端队列，再读取最新计划；先回收、后邀请，加入核对限于邀请后第 2、4 分钟及员工主动请求。云端已有有效三十分钟提醒才会触发邮件。普通程序异常后退出，不自动重试外部动作。真实执行故障会尝试用原有本地 Codex 队列向当前管理员聊天投递**一条去重故障通知**；投递不启动模型，但聊天处理异常可能消耗模型 Token。通知投递结果不明时也不重发，并把状态保存在 `.sites-runtime/seat-executor/alert.json`。本机和 Codex 均不可用时无法保证聊天通知送达，仍须查看计划任务退出码与本地 `status.json`。`install-task.ps1` 用隐藏启动器避免反复弹出终端窗口，并设置有限次失败重启。

原有队列、页面和邮件规则由已有状态机持续提供；新程序只改变办理执行层。生产切换、失败和回退按 [回退手册](./DETERMINISTIC_EXECUTOR_ROLLBACK.md) 执行。站点回退不会撤销已发邮件或官方成员操作。
