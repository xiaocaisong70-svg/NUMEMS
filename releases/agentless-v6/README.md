# NUMEMS agentless-v6

归档日期：2026-10-26。Developed by xcsong.

本标签对应已成功发布的 **Sites 第 6 版**与配套本机执行器。维护分支为 `agentless`；第五版及看门狗修复版标签继续保留。

## 本版修复

门户请求发生网络超时后，旧程序会将其归为 unknown，导致后台长期暂停。第六版明确区分安全读取、纯队列刷新及成员写入：

- 新增管理员专用 `refresh_seat_queue`，只更新内部队列与心跳，任何提醒模式下均不发送邮件或操作官方成员。
- 身份、状态读取及新刷新接口发生明确网络故障后，按 5/15/30/60/120/300 秒退避；之后每 300 秒检查，恢复前核对最新租约和完整官方名单。
- 已领取、已点击、待回执或结果不明的操作不能按读取故障重做；只有严格证明 claim POST 尚未发出，才能记录证据并结束对应本机准备阶段。
- 保留申请、FIFO 排队、续期、提前释放、到期判断、网页提醒、五分钟邀请保护和管理员/容量保护。日常不调用模型、不唤醒 Codex，执行窗口仍隔离在独立 Windows 桌面。

## 来源及部署

| 项目 | 值 |
| --- | --- |
| 线上地址 | https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/ |
| 发布源提交 | `4f3a325fcde294aa8956a49108911510b0734e1f` |
| 上一源提交 | `d6013c85ec821abfd83c5890c3a0e0f61833ab7a` |
| 上一 GitHub 提交 | `e07737f00578be8bb9a9aa35c53d95b5c30bb837` |
| Sites 版本号 | 6 |
| Sites 版本 ID | `appgprj_6adace8f4e7481919901f886e4a0a2f2~appgver_331f1c9c45388191b3c2e6debbf1f01a` |
| 成功部署 ID | `appgdep_6adf1d38180481918e40d80d265b4ebd` |
| 本机发布包 SHA-256 | `2acb18b800edf0d38baf48fe8470ff10fbe6f493ac0c91df550b94445c1b5bc0` |

GitHub 版本额外整理公开说明与校验工具，因此它的提交 ID 与 Sites 源提交不同。[manifest.json](manifest.json) 同时记录来源与导出文件哈希；执行器、业务、测试、迁移和依赖锁文件与来源 Git blob 保持一致。

## 验证范围

- 259 项规则及非浏览器回归通过，0 跳过；TypeScript 与 Sites 生产构建通过。
- 覆盖读取超时恢复、只读导航网络分类、停止请求、新租约出现时拒绝恢复、未发 claim 证明、认证/协议拒绝，以及纯刷新在 relay 模式下也不发邮件。
- 两名到期普通成员的实际回收、官方邀请和后台恢复已核实，已购席位数仍为 4，输入桌面执行窗口数为 0。
- 本轮未重复运行既有离线浏览器夹具，不宣称全量浏览器回归通过。历史卡住用例的记录保留在第五版修复说明中。

原始运行证据留在本机，不随公开归档上传。用户本人仍须接受官方邀请；发出邀请不等于已经加入。官方强制重新认证、角色或容量异常、实际写入结果不明时仍安全暂停。

## 校验与恢复

```powershell
git clone --branch agentless-v6 https://github.com/xiaocaisong70-svg/NUMEMS.git NUMEMS-agentless-v6
cd NUMEMS-agentless-v6
node scripts/verify-release.mjs
```

清单不包括自身，其内容由 Git 固定。旧版清单须检出对应旧标签再校验。克隆不包含生产配置和登录档案，默认关闭真实动作；不要直接启动第二个执行器。

本机和云端版本需要配套：先发布新接口再启用本机程序。恢复与回退步骤见 [版本管理](../../docs/GITHUB-VERSIONING.md) 和 [本次修复](../../docs/PORTAL-RECOVERY-20261026.md)。推荐回退标签为 `agentless-v5-watchdog-20261025`；回退代码不会撤销外部成员操作或数据库变化。

本次 GitHub 上传不重新部署、不启停任务、不办理成员。密码、Cookie、Token、浏览器档案、运行日志、任务 XML 和生产数据库均不上传。
