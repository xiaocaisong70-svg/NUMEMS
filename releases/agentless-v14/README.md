# NUMEMS agentless V14

Developed by xcsong.

网页：[NUMEMS 门户](https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/)。逻辑版本 **V14**，对应 Sites 内部发布版本 **17**；两套计数独立。冻结源码为 `fa24df3f901368edfa9936ee3ed193d25ab39c76`。

日常申请、排队、续期、网页提醒、邀请、核对和回收继续由确定性程序执行，正常轮询不调用模型。只有有限恢复失败且存在有效待办时，才可按显式授权交给 Codex 成员办理后备：最多三个冻结目标，服务端创建起五分钟写入期限，同一连续故障最多两张执行票据、滚动 24 小时最多六张，单目标成功领取后不重复授权。未知原操作只读核对，不重新点击。

V14 保留员工白名单、1–3 小时申请/续期、FIFO、五分钟邀请窗口、保护当前已加入者、网页剩余三十分钟提醒和提前释放。邀请发送时间立即记录，失联后按原租约与完整官方证据核对；不同目标的已知隔离不会被当作未知结果重复操作。有有效待办时普通复核最长间隔一分钟，不沿用空闲故障的三十分钟退避。

官方 Cloudflare 或登录验证仍可能要求管理员本人处理，不绕过验证码、不复制 Cookie、不改变浏览器指纹，不承诺永久无人值守。共享聊天无法保证硬中断；票据到期拒绝新写，执行器仍须等精确模型终态、租约及实际官方状态核对后才能接回。模型 ACK 和“已排队”都不能代替实际完成证据。

## 验收

本次全量回归 640 项通过；真实私有 D1 7 组通过，另有 36 项断言。TypeScript 与生产构建通过。真实成员动作、后备通路与运行环境的具体核对范围见 manifest.validation；不把旧版测试、模拟结果、排队回执或未完成的运行冒充本版真实闭环验收。

**本版实际运行验收限制：** 尚未完成 V14 真实邀请或回收写入验收。原生专用浏览器仍处于 challenge；现有 IAB 已只读核对完整官方名单（2 名成员、4 个已购席位，13:00 UTC 待接受邀请为空）。执行型后备于 12:52:13 UTC 投递，但因当前开发聊天轮次与排队，在领取之前已于 12:57:11 UTC 到期，没有真实 V14 成员写入。最终 13:00 UTC 计划任务已恢复 Ready、liveActions=true，旧 TRAE/队列任务保持停用；但执行器仍被安全检查阻挡，网页正确显示后备超时，监督器等待精确排队轮次的真实终态（agent_deadline_expired_stop_unconfirmed）。任务启用与执行器健康是不同状态，不能据此宣称备用办理闭环或无人值守可用性已经通过。


## 版本与回退

维护分支 `agentless`；本版通过受校验工作流建立真正 annotated Tag `agentless-v14`。固定回退点为 `agentless-v13`（GitHub 归档提交 `8b914fe37a29b0b16cc2ba07a60ecbb95be97abb`），保留全部历史分支与 Tag。完整设计见 [V14 说明](../../docs/V14-RELIABILITY.md)、[回退规程](../../ROLLBACK-V14.md) 和 [清单](manifest.json)。

回退先停机并核对真实模型终态、原操作和云端 CAS；需要时将已结束 handled 票据受控转换为 V13 兼容状态。代码回退不覆盖当前业务 D1，不撤销已经发生的成员操作，不清除未知租约，不自动启用执行器。配置、凭据、Cookie、浏览器档案、生产 D1 和本机日志不上传。

```powershell
git clone --branch agentless-v14 https://github.com/xiaocaisong70-svg/NUMEMS.git NUMEMS-agentless-v14
cd NUMEMS-agentless-v14
node scripts/verify-release.mjs
```
