# NUMEMS · 无 Agent 席位门户

Developed by xcsong.

这是新站 **Sites 第 5 版**的源码归档与后续维护分支。网页托管在 Sites，Windows 上的普通程序负责工作空间成员操作，日常办理不调用模型，也不唤醒 Codex。

- [线上新站](https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/)
- 维护分支：`agentless`；固定版本：`agentless-v5`
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

`verify-release.mjs` 用于核对第 5 版归档文件。修改代码后出现差异是预期行为；发布新版本时应保留旧清单并增加新版本记录。

本轮已通过 228 项回归测试、TypeScript 检查和生产构建；真实收件人完成了邀请、加入、网页提醒、续期与测试到期后的实际移除。多人转派、提前释放和撤邀等其他分支的验证范围见验收说明。

## 部署与运行

GitHub 保存源码和版本，**不会因推送而自动部署站点或启用执行器**。此应用使用服务端登录、数据库和管理接口，不能直接作为纯静态 GitHub Pages 发布。

全新克隆默认关闭真实动作，运行配置在忽略上传的 `.sites-runtime/` 下。请按安装说明配置独立运行目录、管理员会话，完成只读探测、容量核对与单执行器检查后再启用；不要同时运行旧版和新版执行器。现有生产环境不应直接运行克隆目录中的初始化或安装命令。

`.openai/hosting.json` 保留了本版的 Sites 项目绑定。恢复现有站点时先核对目标；另建测试站必须重新绑定独立项目、数据库和地址，避免将测试发布到生产站点。

运行依赖本机持续在线及管理员会话有效。官方要求重新登录或真人验证时仍会安全暂停；本项目不绕过验证，也不保证会话永久有效。

## 版本与隐私

此快照对应 Sites 源提交 `bee319c270dc845aa0748b7a8bfc26c8ab17696f`。GitHub 归档额外整理了说明、忽略规则和校验工具；业务源码、测试及依赖锁文件保持一致，逐文件差异可查 [manifest.json](releases/agentless-v5/manifest.json)。`package.json` 的 `1.0.0` 是包版本，不等同于 Sites 发布序号。

上传范围包括源码、依赖锁文件、数据库迁移、测试和说明。浏览器档案、密码、Cookie、令牌、生产数据库、运行配置和日志不在上传范围内。代码中保留必要的站点、工作空间和管理员/测试邮箱配置，这些是非秘密标识。

仓库原有 `main` 分支和旧版本标签保持不变。`agentless` 与现有 TRAE 版本独立维护，不要直接将两套执行器同时接管同一工作空间。
