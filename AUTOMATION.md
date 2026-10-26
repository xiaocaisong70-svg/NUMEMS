# NUMEMS 无 Agent 副本运行规程

本目录只运行 scripts/agentless。旧 Codex 队列与旧执行器入口已禁用，不能投递聊天任务。
完整步骤、接管前提、故障处理和回退见 docs/AGENTLESS-IMPLEMENTATION.md。

只办理服务端返回的有效计划；每项重新核对，observe → claim → 官方页面操作 → fresh observation → complete。
不加购、不改席位池、不操作 Owner 或管理员。5 分钟邀请超时只撤回仍待接受的邀请，保护当前已加入的成员。
未知结果保留原租约；单目标故障隔离后核实才能继续其它目标；禁止删除记录强行重试。
用户已授权切换：旧 NUMEMS-Seat-Executor-Trae 已停用，新 NUMEMS-Agentless 已安装并在独立桌面运行；本机 liveActions=true，真实邀请、加入、网页提醒、续期与成员回收通过后，云端已启用正式模式。未修改原版或 TRAE 项目文件，未迁移旧站生产租约。
用户已授权新站开放登录入口，业务数据仍须登录和员工白名单。REMINDER_DELIVERY_MODE=in_app，取消到期提醒邮件，保留官方邀请邮件。禁止为提醒启动 Codex 或调用模型。

后台运行入口为 scripts/agentless/host.mjs probe|once|run|admin，定时任务经 watchdog-hidden.vbs、watchdog.mjs 和 isolated-desktop.ps1 启动。采用独立 Win32 桌面；禁止将有界面浏览器回退到用户输入桌面。每次真实动作前复核隔离证据。可经正常登录跳转精确选择已授权的现有管理员账号；禁止自动填密码、点新的权限同意、处理验证码、复制 Cookie 或关闭 Chromium sandbox。
独立桌面、管理员登录和上述真实闭环验收已通过；其他 NUMEMS 任务未停止时禁止安装或启用本执行器。使用 scripts/agentless/stop.mjs 在完整办理与回执后正常停机，禁止删除锁或租约强行重做。当前接管记录见 docs/CUTOVER-20261022.md。

2026-10-25 修复：计划任务改经 watchdog-hidden.vbs → watchdog.mjs → 原隔离宿主，每分钟只检查本机健康，正常执行器运行时 IgnoreNew 不并行启动。输入桌面暂不可核验时等待恢复；只有进程已退出、本机日志结案且云端原有门槛通过后才继续。原生宿主持项目互斥时，可将已确认死亡且无未完成日志的旧锁归档，绝不删除日志、伪造回执或重做不确定操作。显式停机、未知/登录/角色/容量故障继续保持暂停。升级、实际故障与回退见 docs/WATCHDOG-RECOVERY-20261025.md。

2026-10-26 网络恢复修复：普通执行器改用管理员专用 refresh_seat_queue 同步纯队列与心跳，该接口不投递邮件或操作官方成员。身份读取、状态读取及该幂等刷新发生明确传输超时/网络失败时，先验证本机日志已结案，再保留进程并退避检查；成功后必须核对最新云端租约及完整官方名单。claim/complete/成员点击结果不明仍保留原日志，禁止当作网络读取故障重做。只有严格证明 claim RPC 尚未发送的 identity 阶段失败，才可记录 claimNotSent 并结束本机准备阶段。故障、发布与回退见 docs/PORTAL-RECOVERY-20261026.md。
