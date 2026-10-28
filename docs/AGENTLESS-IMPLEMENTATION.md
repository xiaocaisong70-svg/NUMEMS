# NUMEMS 无 Agent 副本

## 结论与真实状态

原版可以采用 TRAE 的“普通 Node 程序 + 已授权浏览器档案”路线，日常任务不需要启动 Agent。
本目录是独立副本，不修改原目录。新站拥有独立 Sites 项目和 D1 数据库。用户已授权停用旧 TRAE 执行任务并切换新执行器；不迁移原站数据库或历史租约。
`liveActions` 默认 false；当前本机已通过授权的真实邀请、加入、网页提醒、续期和成员回收验收，已启用新任务正式运行。最新阶段和证据见 `CUTOVER-20261022.md`，下文早期探测记录不代表当前任务开关。

TRAE 源码确实已有 `scripts/trae/executor.mjs` 和 `official-members.mjs`：邀请走页面控件，移除及名单读取调用后台同源接口。
“有这些代码”不能证明所有生产边界已经验证。对照发现：未完整校验所有页、未知角色可能默认为 member、未在第一项动作之前完整检查执行开关、按批次旧列表办理、邀请超时回收没有充分保护已加入者、异常可能笼统归为 approval_required/member_action。
因此本副本借鉴其确定性执行方式，采用原版较严格的可见页面核对和原有服务端规则，没有复制它的后台 DELETE 接口。

## 功能对照

| 功能 | 本副本实现 |
|---|---|
| 登录、管理员、员工白名单 | 沿用 Sites 登录和每次读写的服务端权限检查；不导入旧会话/Cookie |
| 申请、排队、续期、提前释放 | 沿用 `seat-engine.ts`：1–3 小时、FIFO、有排队者不续期、释放核实后才腾出容量 |
| 排队人数、可用数、预计等待、倒计时 | 保留原 React 界面与服务端时钟计算 |
| 5 分钟邀请窗口 | 到点启动撤回；官方已是成员则保护；claim 后加入的竞态提交 joined 回执 |
| 邀请、待接受核对、移除 | `scripts/agentless/core.mjs` 与 `BrowserAdapter`，直接执行已批准普通成员任务，无模型 |
| 执行速度 | 默认每 15 秒检查，每批最多 6 项；每项读取最新计划，回收优先，释放后同批邀请下一人 |
| 提醒与邀请邮件 | 到期前 30 分钟仅网页显示提醒和续期入口；普通程序在 OpenAI 官方后台发送工作空间邀请，由官方投递邀请邮件，无模型 |
| 故障隔离 | 确定的单成员/审批错误只隔离目标；登录、容量、角色和未知错误停止；不把未知错误猜成局部错误 |
| 临时后台不可用 | 仅尚未 claim 且云端标记 browser_unavailable 时，15/30/60 秒有限只读恢复；不能绕过安全验证 |
| 中断恢复 | 本机日志先记录 claim 意图、租约和点击意图，再做外部操作；云端回执可安全结案，未知结果不重发 |
| 告警 | 本机 status.json + 去重告警；可接 HTTPS 管理员通知网关；没有 Codex 消息兜底 |
| 单执行器 | 独立档案、独立锁、扫描其他 NUMEMS 任务和办理进程；未停旧执行器不能启用 |

0 模型 Token 指这些程序路径不调用模型，不代表免除 Business 席位费、云服务或邮件费用。
固定页面自动化仍依赖官方登录、网络和页面结构。可通过正常 SSO 跳转及精确选择已授权管理员账号续接已有会话；不填密码、不点击新授权同意、不处理验证码。官方要求额外验证时保持停止，界面改变需要维护。
15 秒是空闲轮询间隔，不是任何网络情况下都能在 15 秒内完成的承诺。

## 一次性配置与验收

1. 新站由 Sites 云端承载，不能把 `127.0.0.1` 发给同事使用。新站已按用户明确授权开放公开登录入口；15 个原站员工邮箱已录入独立白名单，自动动作仍关闭。
2. 在新门户用 `xiaocaisong70@gmail.com` 登录，设置工作空间 `cd01c344-8ff9-41fd-a750-f7b30af9a7c9`、4 席位/保留 1、员工白名单，并完成首次盘点。现有成员作为固定占用，不凭空设截止时间。
3. 按用户最新要求，Sites 运行环境配置 `REMINDER_DELIVERY_MODE=in_app`，本机 `mailMode=in_app`。`PORTAL_PUBLIC_URL` 为新站 HTTPS 根网址。不需要 Gmail、SMTP、邮件中继或 Codex 工具服务。
4. 网页提醒基于服务端截止时间；离线、旧快照、已续期、已释放或已到期时不显示过时倒计时。通知记录保留但不标记为“邮件已发送”。关闭网页时不会弹出桌面窗口。官方邀请邮件与提醒邮件是两条独立流程。
5. `node scripts/agentless/main.mjs --init` 生成本机禁用配置。`node scripts/agentless/login.mjs` 打开普通 Edge 专用窗口，由管理员本人登录两个站点，然后关闭该窗口。此档案不会从原项目复制。
6. 先运行 `node scripts/agentless/host.mjs probe`，只读验证独立桌面、官方名单及门户管理员身份；不推进队列、不 claim、不邀请/移除/发信。通过后本机配置使用 `browserMode=isolated_desktop`、`headless=false`；`liveActions` 仍为 false。`node scripts/agentless/host.mjs once` 在禁用配置下仅读取计划；门户正常页面刷新仍可能推进纯队列状态。可用 `node scripts/agentless/main.mjs --config-check` 不联网核对配置。
7. 接管须先暂停原调度并确认原租约和唤醒均已结束；核实所有其他 NUMEMS 执行器停止，再将本机配置 `legacyCheckerDisabled=true`。本次用户已授权此步骤，旧 TRAE 任务已备份和停用。不要同时运行两个站点管理相同工作空间。
8. 运行 `node scripts/agentless/host.mjs admin prepare-test`；仅服务端预设的 `hit_wangning@outlook.com` 可进入测试计划。将本机 `liveActions=true`，运行 `node scripts/agentless/host.mjs once` 发送测试邀请；本人接受后核对状态，验证续期、网页 30 分钟提醒、提前释放及实际移除。`admin test-reminder ID` / `admin test-expire ID` 只能用于已登记测试申请。记录官方操作前后证据，并由员工确认收到 OpenAI 官方邀请邮件；不得伪造提醒邮件回执。
9. 验收通过后运行 `node scripts/agentless/host.mjs admin enable-live`；网页提醒模式下，服务端仍要求已存在真实邀请和真实成员回收验证记录；不会用撤销待接受邀请冒充成员移除。重新运行 `host.mjs probe` 成功后，使用 `scripts/agentless/install-task.ps1 -NodeExe <node.exe绝对路径>` 安装独立 `NUMEMS-Agentless` 登录后任务。安装器要求 15 分钟内的成功探测、匹配的桌面审计、官方和门户均验证成功，以及旧任务全部停止；不重启每分钟模型任务。
10. 开放员工访问前，明确选择新站的受众，维护员工白名单，并由一位已移除席位的员工验证登录、申请及再次加入。本次新站已明确授权公开入口并保留白名单，原站访问权限未改。

旧站员工白名单可以由管理员核对后录入新站；不能直接复制带旧 Site userId 的历史申请作为新申请。Sites 身份 ID 随站点变化。

## 运行与故障处理

- 运行：`node scripts/agentless/host.mjs run`；一次运行：`host.mjs once`；管理员操作：`host.mjs admin <命令>`。这些入口都通过隐藏 PowerShell 启动独立桌面，正常调度用隐藏 VBS。关闭 Codex 不影响程序逻辑，但承载电脑、Windows 用户会话、Edge 会话和网络仍需可用。
- 状态：`.sites-runtime/agentless/status.json`，包括最后时间、modelCalls、目标回执、邮件通道异常。
- 日志：`.sites-runtime/agentless/operation.json` 保存原租约，含秘密 token，不可上传；worker.lock 阻止并发。
- 告警：`.sites-runtime/agentless/alert.json`。可配置本机环境 `NUMEMS_ALERT_URL` / `NUMEMS_ALERT_TOKEN` 发送一次 HTTPS 告警；未配时仅落本机文件。未知告警投递不重复发送。
- 仅后台加载临时故障可自动只读恢复。登录失效保持停止，不会弹出登录窗口或启动 Agent；主动维护时才可运行 login。未知成员结果运行 `host.mjs admin reconcile`，只用原租约和官方状态结案，绝不重新点击。
- 如果 claim 响应丢失，日志没有租约 token，保留云端任务并人工核对；不能通过删除 operation.json 或清空数据库恢复。
- 管理员已处理完全部故障后，可执行 `host.mjs admin resolve-alert`，为下次新故障重新通知做准备。

### 不打断办理的本机停机

持续测试时运行 `node scripts/agentless/host.mjs run`，它会持续处理邀请加入窗口和到期回收。需要运行管理员命令前，先运行 `node scripts/agentless/stop.mjs`；该命令只写本机固定的停机请求并等待 `worker.lock` 释放，不启动浏览器、不调用模型，也不杀进程或撤销租约。默认等待 5 分钟，可用 `--timeout-ms 1000..600000` 设置有界等待。

worker 在开始下一批之前、当前完整批次及回执结束之后、以及每秒等待时检查停机请求；不会在发送邀请、移除或保存回执途中取消操作。停机请求绑定锁中的 PID 和启动时间，旧请求对下一次启动无效；启动时只识别并忽略旧请求，不删除文件，避免误删同时到达的新请求。停机不禁用计划任务，也不代表业务租约已结束；正常停机后可继续使用隔离宿主运行管理员命令，再显式恢复 `host.mjs run`。

结果保存在 `.sites-runtime/agentless/stop-result.json`。只有 `stopped` 或 `already_stopped` 表示此次观察到锁已释放；若超时或实例发生替换，命令失败退出，保留请求、锁和原始办理日志，不强行停止或自动重做。异常处理中已保留的 `operation.json`、服务端租约及 `status.json` 的 blocked 状态不会被停机请求清除。常驻 worker 的正式安装仍须满足独占接管和真实验收条件。

## 独立桌面实现

TRAE 的有界面浏览器位于屏幕坐标之外，仍属于用户桌面。本副本改用 Windows `CreateDesktopW` 创建新的非输入桌面，通过 `CreateProcessW.lpDesktop` 指定 Node 和 Edge 的桌面；不调用 `SwitchDesktop`。隐藏启动器同时关闭新控制台和启动光标反馈。

子进程挂起启动，加入专用进程 Job 后才恢复执行；宿主退出时只终止自己的进程树。首次启动浏览器和每次外部写入前，程序用 Windows 原生 API 确认当前桌面、输入桌面、窗口站及随机宿主名称；无法证明隔离就停止，不回退到用户桌面。宿主每秒核对自身进程树的窗口，出现输入桌面窗口或审计失败时停止。

窗口审计是补充证据，一秒采样不能证明绝无毫秒级闪窗。主要隔离来自独立桌面及子进程继承，真实探测结果需要单独记录。保留 Chromium sandbox；没有复制 Cookie、关闭安全保护、修改指纹或解决验证码的代码。独立桌面改善窗口干扰，不能保证官方永不要求登录或真人验证。

新增证据：`.sites-runtime/agentless/isolated-probe.json` 和 `host-desktop.json`。前者记录官方/门户验证结果，后者记录进程与桌面审计；二者均不记录 Cookie、密码、窗口标题或页面内容。二者必须同时通过，不能用“桌面隔离通过”替代“登录/真实办理通过”。

只读诊断失败时另存 `probe-official-ui.json`，仅保留已渲染的后台文本，用于识别加载骨架和页面变化；该文件可能含成员邮箱，仅保存在忽略上传的本机运行目录。隔离管理员命令的结果写入 `admin-result.json`，无需弹控制台读取。门户读请求上限 20 秒、RPC 请求上限 30 秒；写入超时仍按结果不明处理，保留原办理日志。

### 加载变化与测试阶段核查

成员页必须有正确的已选标签、完整数据行、指定管理员的 Owner 角色及自身标记；邀请页不能采用旧成员表。标签提供数量时，完整分页后的记录数必须一致。数字紧贴邀请标签也应识别。加载超时只读失败可由普通程序有限复核；错误账号、角色、购买容量或已 claim 后的不明结果仍停止，不重复成员动作。

两次各自通过安全检查的快照若不同，可能是员工恰好接受了邀请，归类为 `browser_unavailable` 并只读复核；不能直接选其中一份继续写入。安全检查失败不能降级为此类暂态。

本轮测试中曾有 claim 前的旧版 `unknown` 暂停。仅部署维护时可运行 `node scripts/agentless/host.mjs admin review-test-workspace`：严格限定 testOnly、指定“未开始成员写入”诊断、无租约/隔离及本机日志不存在或已结案；取得两次独立完整官方核对且计划、日志未变后，提交现有核查接口。该入口不 claim、不邀请、不移除、不重写日志，也不属于日常 worker 的自动恢复路径。正式环境或任何未结案、审批隔离、结果不明的任务均拒绝。

## 回退

新副本未接管时：无需回退原版，原目录、原站及原执行器保持原状。
未来切换后，如构建失败、登录/角色/容量不符、重复发信、错回收或回执不一致：立即停止 `NUMEMS-Agentless`，将其 `liveActions=false`；保留 D1、租约、日志和官方名单证据。先确认是否有已发生但未结案的邀请/回收，核实后才恢复原执行器。
不能在“结果不明”时直接启用旧执行器，否则两个数据库可能重复处理同一成员。
回退成功标准：仅一个执行器在运行；门户占用等于官方完整成员+邀请；付费席位仍为 4；所有未完成回执已核对；员工登录和现有租约正常。

本次独立桌面改造前的版本标记为 `agentless-before-isolated-desktop-20261022`，对应 `9b962591dfa2eb5e1766250c8cf947034d7b7148`。完整跟踪源码备份为本机 `outputs/agentless-before-isolated-desktop-20261022.zip`，SHA-256 为 `DF0C900677C3AF43A7987CED41A0782E7E8551DCD8DB746068B9DAF20693EB8C`；本机配置备份为 `.sites-runtime/agentless/config.before-isolated-desktop.json`。浏览器档案、数据库及办理日志不放入源码归档，不重置这些数据。

回退触发条件：编译/构建失败、独立桌面证据失败、出现用户桌面窗口、登录/安全验证失败、官方名单/角色/容量不符，或真实动作结果不明。停止新宿主/任务并保持 `liveActions=false`，保存当前源码和运行证据；在新的恢复目录解压 ZIP 并核验 SHA-256、对比上述 Git 标记，再恢复该版本的跟踪源码及备份配置，禁用真实动作。新增宿主文件应按本次 Git 差异逐一移出运行目录，禁止递归清空运行数据或直接清除租约。若曾有外部动作，必须先用原租约核实结果。验证恢复成功需源码与标记一致、配置仍禁用、旧版测试/构建通过、无新宿主进程/启用任务；云端如发布过新版本，可重新部署已保存的第 2 版，数据库保持不回退。

## 测试范围

`node --test tests/*.test.mjs` 包含继承的业务/权限测试、新增真实状态机集成测试和 Playwright 页面夹具测试。浏览器夹具拦截所有请求，不接触真实 OpenAI 账号。
`node node_modules/typescript/bin/tsc --noEmit` 检查类型；Sites build-site.mjs 进行生产构建。
本次结果写入 `docs/VALIDATION.md`。原版文件 SHA-256 基线保存在本地 `outputs/original-baseline.json`，执行 `node scripts/agentless/check-original.mjs` 可复核未改动。

## 当前公网验收状态（2026-10-22 本机时间）

新站公开访问、管理员通过 ChatGPT 登录、15 个邮箱白名单、未登录及伪造身份拒绝此前已验证。旧 headless 探测曾被 Cloudflare 和门户登录阻塞。

本轮改为独立 Win32 桌面中的正常有界面 Edge 后，2026-10-23 04:54:07 UTC 的只读探测完整通过：指定 Owner/工作空间校验、4 个已购席位/1 名成员/0 条邀请、门户管理员身份均成功；33 次宿主窗口审计中输入桌面所属窗口最大数为 0，浏览器确实在独立桌面创建窗口。正常登录流中自动选择了指定已有账号，没有输入密码、处理验证码或要求用户重复验证。

以上为切换前的只读记录。用户随后授权切换并完成真实闭环验收；当前 `NUMEMS-Seat-Executor-Trae` 已停用，`NUMEMS-Agentless` 已正式运行，实际进度见 `CUTOVER-20261022.md`。独立桌面不构成“以后绝不会再有官方验证”的承诺。

## V12 告警与恢复周期

- `alert.json` 改为最多 32 条的持久事件发件箱；当前事件的顶层字段保持 V11 兼容。不同故障代码或不同云端 failure ID 不再被旧的未关闭告警吞掉。同一事件始终保留原投递 ID，已接受的 HTTP 回执不重复投递。
- 没有 `NUMEMS_ALERT_URL` 时状态仍明确为 `local_only`，只记录本机并在门户显示现有故障；这不代表管理员已收到站外消息。`NUMEMS_ALERT_URL` 只允许 HTTPS，令牌通过本机环境变量 `NUMEMS_ALERT_TOKEN` 提供，不写入源码、网页或日志。不调用 Codex、模型或桌面弹窗。
- 未确认的网关投递默认不重复 POST。只有网关保证按 `Idempotency-Key` 持久去重时，才可显式配置 `NUMEMS_ALERT_IDEMPOTENT_RETRY=true`；普通程序使用同一 ID 退避重试，最多六次，不创造新的告警来绕过去重。未结案告警满 32 条时保留全部原 ID 并登记容量告警，不静默淘汰未知投递。
- `flushFailureAlerts` 可在普通循环中补发尚未配置通道时准备的告警，不创造业务任务或唤醒 Agent。健康恢复后不再投递已经关闭的旧事件。
- `health-cycle.mjs` 必须核对正式启用的云端计划、正确的管理员/工作空间、完整且新鲜的官方名单、服务端已收录相同官方观察时间、空闲云端租约和已结案的本机日志。只有通过这些门槛后，才关闭旧告警并将浏览器恢复退避记为新健康周期。单纯 `idle`、刷新心跳、进程重启、新的失败时间均不能重置退避。
- 浏览器恢复的新健康标记保留已退休的尝试数与原失败摘要；下一次独立故障从 60 秒开始，但看门狗原有的 PID、互斥、停止请求、角色/容量和未结案日志门槛仍全部有效。
