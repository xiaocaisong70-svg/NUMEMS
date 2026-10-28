# NUMEMS · 无 Agent 席位门户

Developed by xcsong.

这是新站 **Sites 第 10 版（2026-10-27）**的源码与维护分支。网页托管在 Sites，Windows 上的普通程序负责工作空间成员操作，日常办理不调用模型，也不唤醒 Codex。

- [线上新站](https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/)
- 维护分支：`agentless`；当前版本归档分支：`agentless-v10`（以归档提交 SHA 为准）
- [第十版说明与校验清单](releases/agentless-v10/README.md)
- [到期回收根因修复与验收边界](docs/EXPIRY-ROOTFIX-20261027.md)
- [第七版说明与校验清单](releases/agentless-v7/README.md)
- [官方成员状态对账与执行器恢复](docs/RECONCILIATION-20261027.md)
- [第六版说明与校验清单](releases/agentless-v6/README.md)
- [门户网络超时恢复、纯队列刷新与回退](docs/PORTAL-RECOVERY-20261026.md)
- [第五版看门狗修复归档](releases/agentless-v5-watchdog-20261025/README.md)
- [回收中断原因、看门狗与升级/回退](docs/WATCHDOG-RECOVERY-20261025.md)
- [第 5 版发布与验收说明](releases/agentless-v5/README.md)
- [版本管理与回退指南](docs/GITHUB-VERSIONING.md)
- [安装和运行配置](docs/AGENTLESS-IMPLEMENTATION.md)
- [真实流程验收记录](docs/CUTOVER-20261022.md) / [测试范围](docs/VALIDATION.md)

## 功能

| 模块 | 行为 |
| --- | --- |
| 申请与排队 | 按小时申请，单次最多 3 小时；按队列顺序分配；保护管理员并核对实际容量 |
| 邀请与加入 | OpenAI 官方发送邀请邮件；5 分钟到点启动撤回，按官方当前状态保护已加入者 |
| 提醒与续期 | 剩余 30 分钟网页提醒；续期后取消旧提醒；有其他员工排队时遵循公平续期限制 |
| 提前释放与到期回收 | 员工申请提前释放或到期后执行回收，核实成功并保存回执后才释放名额 |
| 确定性执行 | observe → claim → 官方页面操作 → 核实 → complete；逐目标隔离故障，结果不明时停止重复操作 |
| 网络恢复 | 安全读取与纯队列刷新超时后退避检查，核对最新租约和官方名单后继续；未确认的成员写入保留原日志 |
| 成员状态对账 | 核对官方完整名单；保护已加入者、保留未结案租约，并安全处理成员状态变化 |
| 桌面隔离 | 在独立 Windows 桌面运行正常 Edge；本轮真实邀请、加入核对和回收未在用户输入桌面出现窗口 |

到期提醒仅在网页显示，**不发送到期提醒邮件**。邀请邮件仍由 OpenAI 官方发送。

## 开发与验证

需要 Node.js **22.13 或更新版本**。真实执行器还需要 Windows、Edge、有效的专用管理员登录档案、Sites 门户授权和唯一运行实例。

```powershell
git clone --branch agentless https://github.com/xiaocaisong70-svg/NUMEMS.git NUMEMS-agentless
cd NUMEMS-agentless
git switch -c feature/your-change
node scripts/verify-release.mjs
npm run install:ci
node --test tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

`verify-release.mjs` 默认核对 `agentless-v10` 归档；也可显式指定版本名。旧版须先检出相应固定标签，再运行该标签自带的校验脚本。修改代码后出现差异是预期行为；新版本保留旧清单并增加新的版本记录。

第十版通过 **85 项联合测试**、TypeScript、Sites 生产构建及独立真实 D1 的 **6 项合成数据原子性测试**。三条到期记录已由管理员授权的受控官方浏览器流程完成真实回收并保存回执；这不等同于无模型执行器全链路验收。专用浏览器在隐藏模式仍可能遭官方安全验证阻塞，运行状态须以实时计划、宿主日志和官方名单为准，不能据本归档宣称无人值守已通过。

第七版通过 **127 项针对性及回归测试**、TypeScript 和 Sites 生产构建。隔离桌面只读双快照与恢复已核实，恢复后自动到期回收及官方邀请取得回执，输入桌面执行窗口数为 0。本次未重跑全部浏览器夹具，不宣称全量浏览器回归通过；第六版的验证范围保留在对应版本说明中。

## 部署与运行

GitHub 保存源码和版本，**不会因推送而自动部署站点或启用执行器**。此应用使用服务端登录、数据库和管理接口，不能直接作为纯静态 GitHub Pages 发布。

全新克隆默认关闭真实动作，运行配置在忽略上传的 `.sites-runtime/` 下。请按安装说明配置独立运行目录、管理员会话，完成只读探测、容量核对与单执行器检查后再启用；不要同时运行旧版和新版执行器。现有生产环境不应直接运行克隆目录中的初始化或安装命令。

`.openai/hosting.json` 保留了本版的 Sites 项目绑定。恢复现有站点时先核对目标；另建测试站必须重新绑定独立项目、数据库和地址，避免将测试发布到生产站点。

运行依赖本机持续在线及管理员会话有效。官方要求重新登录或真人验证时仍会安全暂停；本项目不绕过验证，也不保证会话永久有效。

## 版本与隐私

原第五版快照对应 Sites 源提交 `bee319c270dc845aa0748b7a8bfc26c8ab17696f`，原始清单保存在 [manifest.json](releases/agentless-v5/manifest.json)。GitHub 归档额外整理了说明、忽略规则和校验工具。`package.json` 的 `1.0.0` 是包版本，不等同于 Sites 发布序号。

第十版发布源提交为 `1a55cfe21f1914997df41facbd584bc58ad42d42`，完整性以[第十版清单](releases/agentless-v10/manifest.json)为准。本版为原操作暂停遗留的根因修复，保留官方验证、角色和容量保护；不是两分钟空闲对账候选版。

第七版发布源提交为 `b1caa6877d04a3552ad2b934e730f3970f7cd1a4`，完整性以[第七版清单](releases/agentless-v7/manifest.json)为准。它修复官方名单与席位数短暂不一致后无法恢复、以及进程号复用使看护程序持续停住的问题。领取前只进行有界重读；已领取或结果不明时保留原租约。空闲两分钟对账候选版没有包含在第七版内。

第六版发布源提交为 `4f3a325fcde294aa8956a49108911510b0734e1f`，其完整性以[第六版清单](releases/agentless-v6/manifest.json)为准。`refresh_seat_queue` 只更新内部队列与心跳，不投递邮件或操作官方成员。

上传范围包括源码、依赖锁文件、数据库迁移、测试和说明。浏览器档案、密码、Cookie、令牌、生产数据库、运行配置和日志不在上传范围内。代码中保留必要的站点、工作空间和管理员/测试邮箱配置，这些是非秘密标识。

仓库原有 `main` 分支和旧版本标签保持不变。`agentless` 与现有 TRAE 版本独立维护，不要直接将两套执行器同时接管同一工作空间。
