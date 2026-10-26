# 第 5 版本机回收中断修复（2026-10-25）

## 原因与实证

2026-10-23 01:44（America/Los_Angeles），隔离宿主的 `OpenInputDesktop` 审计失败，原始错误为 `Input desktop cannot be audited`。这通常发生在锁屏、安全桌面或会话切换期间；原始日志不能证明本次具体是哪一种。宿主关闭自己的 Job，worker 未能执行 finally，留下进程已死亡的锁文件；本地业务状态仍是之前的 idle，云端没有租约或故障。

原计划任务只有登录触发，没有下一次定期启动或故障恢复，因此之后到期的两份申请虽已由云端正确转为 pending_removal，却无人执行。不能把云端 enabled 或已登记 scheduleId 当作本机仍在线的证明。

处理前已固定 `before-watchdog-recovery-20261025` 标签、完整源码 tar 和原任务 XML，保留原宿主、状态、日志及锁证据。确认旧进程不存在、本机 journal=settled、云端 busy=false/lease=null 后归档旧锁，原日志未删除。只读探测核实官方 4 个已购席位、管理员和两名员工。原有 `host.mjs once` 随后真实移除两名到期普通成员，两条回执均为 verified。原来的申请已回收；之后新提交的申请按新记录办理。

## 改动

- `watchdog.mjs` 是普通 Node 程序，计划任务每分钟触发；常驻 worker 健康时任务仍运行，`IgnoreNew` 阻止重叠。
- 外层先核对旧 host/lock PID 均已死亡；存活、PID 复用、无权限或身份不明时不启动。
- 仅已知输入桌面暂不可审计、claim 前 browser_unavailable、完整审计且无故障的空闲 worker 意外中止可成为恢复候选；管理员刚完成的安全 probe/once 可作为初始启动依据。
- 在启动前检查桌面可访问；不可访问就等下一次普通程序检查，不打开浏览器、不要求用户认证、不启动模型。
- 原生宿主取得项目互斥后，再次确认旧锁 PID 不存在且 journal 已结案，才将旧锁移动到同一运行目录的唯一归档文件。归档不等于操作结案。
- 原有执行器继续核对最新云端身份、工作空间、容量、角色、租约、隔离项和官方状态。已有 claim/attempting/completing、云端忙或不确定操作禁止通过重启重做。
- 正常停机、登录/容量/角色/未知错误继续保持暂停；看门狗不循环重发邀请或重复移除。已有浏览器只读恢复仍走原 recover_browser 证据门槛。
- 宿主在互斥内两次复核启动票据、旧宿主 PID 和停机文件摘要；启动决策后出现的停机请求也会使新 worker 停下，不能当作旧实例请求忽略。启动前的原生输入桌面暂不可用有单独分类，其余隔离错误仍不自动恢复。

本次只修改本机执行器和计划任务；云端页面、数据库规则和 Sites 发布版本不变。日常看门狗和办理程序均不调用模型、不投递 Codex 聊天任务；执行窗口继续只在隔离桌面中运行。

## 升级和检查

确认无运行实例/未完成租约，完成最近 15 分钟内的 `host.mjs probe`，然后在实际 Windows 用户下运行：

```powershell
node scripts/agentless/host.mjs probe
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File scripts/agentless/install-task.ps1 -NodeExe <node.exe绝对路径> -UpgradeWatchdog
```

升级仅匹配本项目的原任务、动作和 Windows 用户，备份旧任务 XML 后替换同一个 `NUMEMS-Agentless`；旧 TRAE/原版任务保持停用。只读查看 `.sites-runtime/agentless/watchdog.json`、`status.json` 和 `host-desktop.json`。`waiting_desktop` 表示等待桌面恢复，`held` 表示需要依据日志排障；不能删文件假装恢复。

验证覆盖：锁屏时等待且不启动 worker、恢复后只启动一次、未结案日志/存活或复用 PID/权限失败均拒绝、正常停止不再启动、宿主互斥内旧锁归档并原样保留日志；既有回归继续覆盖成员与容量保护。

本次规则及非浏览器回归 **224/224 通过、0 跳过**；其中安装、隔离宿主、日志恢复、看门狗和停机相关的定向回归为 **42/42 通过**，两组有重叠，不能相加。全量回归的 `agentless-modal.test.mjs` 和 `agentless-stale-table.test.mjs` 离线浏览器夹具长时间未结束，已停止其测试进程；本轮不能声称全量浏览器回归通过。之前完成的真实两条回收、新申请邀请及持续运行的零输入桌面窗口审计另行核实，生产执行器没有随测试停止。原始报告保存在忽略上传的 `outputs/watchdog-*-20261025.txt`。

## 回退

看门狗导致启动异常、重复启动、错误恢复或隔离检查退化时停止升级：先用 `stop.mjs` 等本批回执结束，确认退出后禁用同一计划任务。保留运行目录、租约和日志。按 `before-watchdog-recovery-20261025` 恢复脚本，在安全状态下导入已保存的原任务 XML。确认只有一个执行器、无未完成租约、官方库存与门户一致再启动。不要恢复旧数据库来撤销已经完成的真实回收。

回退后原版仅登录启动的限制也会恢复，不能据此保证自动恢复。第五版 GitHub 固定标签仍保持原内容；本次是本机执行器的独立修复记录。
