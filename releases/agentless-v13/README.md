# NUMEMS agentless V13

Developed by xcsong.

网页：[NUMEMS 门户](https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/)。逻辑版本 **V13**，对应 Sites 内部发布版本 **15**；两套计数独立。源码为 `336b98236f694c3ea574e970efaaf29361b0e909`。

正常申请、排队、续期、提醒、邀请、核对和回收由确定性程序运行，不启动模型。普通安全检查先有限等待、完整重读和一次同配置上下文重启；仅在恢复失败后投递一次受独占票据保护的只读 Codex 故障诊断。只有新鲜的明确交互/登录证据才提示本人操作。不能保证官方会话永久有效或永远无需管理员。

保留员工白名单、1–3 小时使用/续期、FIFO、五分钟超时撤邀、保护当前已加入者、网页三十分钟提醒与提前释放。原操作不明时保留原租约，禁止重复邀请/移除；诊断 ACK 不等于执行权释放，必须核对精确消息的真实终结轮次与官方完整名单。

## 验收

本次全量回归 569 项通过；真实私有 D1 9 组通过，另有 43 项断言。TypeScript 和生产构建通过。具体运行核对范围见 manifest 的 validation 字段，不把历史成员测试冒充本版真实外部动作验收。

## 版本与回退

维护分支 `agentless`，本版使用真正 annotated Tag `agentless-v13`。固定回退点为 `agentless-v12`（归档提交 `ea9beb63cbdf64bca2e35a6d6a2cdbbc2212b3ab`），保留全部历史分支与 Tag。完整部署和回退见 [V13 说明](../../docs/V13-RELEASE.md)、[回退规程](../../ROLLBACK-V13.md)和 [清单](manifest.json)。

配置、Cookie、凭据、浏览器档案、生产 D1 与操作日志不上传。代码回退不覆盖当前业务数据库，也不撤销已经完成的成员操作。

```powershell
git clone --branch agentless-v13 https://github.com/xiaocaisong70-svg/NUMEMS.git NUMEMS-agentless-v13
cd NUMEMS-agentless-v13
node scripts/verify-release.mjs
```
