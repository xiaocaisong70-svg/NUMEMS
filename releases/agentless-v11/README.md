# NUMEMS agentless-v11

归档日期：2026-10-27（America/Los_Angeles）。Developed by xcsong.

本版对应已发布的 Sites 第 11 版。维护分支为 `agentless`，发布标签约定为 `agentless-v11`；标签必须由上传流程实际创建并核实，本文件不单独证明远端 Tag 已存在。

## 来源与修复

- Sites 源提交：`59a43e80f55d93419c2e8dc010e4ea2e998a8427`。
- 线上地址：https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/
- 修复二次“保留付费席位”确认框的延迟空档；明确等待保留按钮，禁止选择减少或购买席位。
- 对操作后的不完整官方读取最多做 3 次只读核对；不重做成员点击、不延长租约。完成 RPC 结果不明时保留原证据，避免重复提交。
- 保留白名单阶段诊断；空队列调度登记不再额外导航官方成员页面。恢复等待可正常停机，跨进程故障采用有界退避。

## 验证与边界

105 项联合回归及新增启动/诊断 5 项小测试通过，生产构建通过。第二轮真实申请、官方邀请、加入核对、网页提前释放、成员移除与回执均由普通程序完成，没有人工补回执；该轮释放到回执约 87.597 秒。运行记录为 0 模型调用、0 用户输入桌面窗口，4 个已购席位保留。

这些是本次验收结果，并不保证官方页面永不改变或登录永久有效。管理员已选择：官方再次要求安全验证时暂停办理，由本人处理，核对通过后恢复。网站托管在 Sites，本机 Windows 程序执行成员操作；电脑及合法会话仍是运行条件。

## 校验和取回

远端标签核实完成后：

```powershell
git clone --branch agentless-v11 https://github.com/xiaocaisong70-svg/NUMEMS.git NUMEMS-agentless-v11
cd NUMEMS-agentless-v11
node scripts/verify-release.mjs
```

清单校验导出文件的大小和 SHA-256，记录源 Git blob；清单自身由归档 Git 提交固定。业务代码按 `git cat-file` 的原始 blob 字节导出；少量既有公共文档与忽略规则继续保留，差异在清单中说明。发布包本地压缩文件哈希与 Sites 提供的内容哈希分别记录，不能假定两者含义相同。

不包含登录档案、Cookie、令牌、运行配置、生产数据库、操作日志、任务导出、依赖目录或构建目录。历史清单保持原样；应检出对应历史版本后校验，而不是在本版树上套用旧版清单。

## 回退

第十版归档提交是 `f99df460f7b44c71248918ab0c66cf7633c20589`，Sites 版本为 10，源提交为 `1a55cfe21f1914997df41facbd584bc58ad42d42`。按[版本管理与回退](../../docs/GITHUB-VERSIONING.md)正常停机、保留证据并核实状态后恢复。备份 ZIP 的 CRLF 与源 Git blob 的 LF 不能混作同一原始字节来源。源码回退不会撤销已经发生的成员操作。

## Tag 创建流程

GitHub 专用的 `.github/workflows/tag-agentless-v11.yml` 仅在 `agentless` 分支的 `releases/agentless-v11/manifest.json` 发生推送变更时触发，创建固定到该提交的 annotated Tag。作业仅声明 `contents: write`，使用仓库内的 `GITHUB_TOKEN` 和 Python 标准库直接调用 GitHub API；没有第三方 Action，不运行业务执行器，不部署 Sites，不调用模型或读取运行凭据。已有标签必须指向本次提交，否则失败退出，绝不覆盖旧 Tag。上传流程仍必须检查工作流结果及远端 `refs/tags/agentless-v11`，不能将版本分支当作标签成功。
