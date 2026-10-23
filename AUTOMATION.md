# NUMEMS 无 Agent 副本运行规程

本目录只运行 scripts/agentless。旧 Codex 队列与旧执行器入口已禁用，不能投递聊天任务。
完整步骤、接管前提、故障处理和回退见 docs/AGENTLESS-IMPLEMENTATION.md。

只办理服务端返回的有效计划；每项重新核对，observe → claim → 官方页面操作 → fresh observation → complete。
不加购、不改席位池、不操作 Owner 或管理员。5 分钟邀请超时只撤回仍待接受的邀请，保护当前已加入的成员。
未知结果保留原租约；单目标故障隔离后核实才能继续其它目标；禁止删除记录强行重试。
用户已授权切换：旧 NUMEMS-Seat-Executor-Trae 已停用，新 NUMEMS-Agentless 已安装并在独立桌面运行；本机 liveActions=true，真实邀请、加入、网页提醒、续期与成员回收通过后，云端已启用正式模式。未修改原版或 TRAE 项目文件，未迁移旧站生产租约。
用户已授权新站开放登录入口，业务数据仍须登录和员工白名单。REMINDER_DELIVERY_MODE=in_app，取消到期提醒邮件，保留官方邀请邮件。禁止为提醒启动 Codex 或调用模型。

后台运行入口为 scripts/agentless/host.mjs probe|once|run|admin，定时任务经 run-hidden.vbs 和 isolated-desktop.ps1 启动。采用独立 Win32 桌面；禁止将有界面浏览器回退到用户输入桌面。每次真实动作前复核隔离证据。可经正常登录跳转精确选择已授权的现有管理员账号；禁止自动填密码、点新的权限同意、处理验证码、复制 Cookie 或关闭 Chromium sandbox。
独立桌面、管理员登录和上述真实闭环验收已通过；其他 NUMEMS 任务未停止时禁止安装或启用本执行器。使用 scripts/agentless/stop.mjs 在完整办理与回执后正常停机，禁止删除锁或租约强行重做。当前接管记录见 docs/CUTOVER-20261022.md。
