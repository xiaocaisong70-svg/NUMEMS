# V13 回退至 V12

本工具仅用于明确的维护回退。默认只检查，不改文件、不打开浏览器、不调用模型。`--verify-cloud` 才会通过现有隔离桌面宿主读取门户的回退状态；这不是成员办理。`--apply` 才会替换本机源码。工具不会发布 Sites、修改或恢复 D1、不删除浏览器档案，不取消租约或故障交接票据，也不会重新启用执行器。

## 触发条件

以下任一项成立时先暂停执行器并保留日志，再评估回退：构建／启动失败；申请、排队、续期、五分钟撤邀或提前释放发生回归；故障交接出现重复唤醒或执行权不明确；界面错误要求管理员认证；恢复后没有按真实官方证据结案。若只在独立开发目录构建失败，正式 V12 未被替换，无需回退正式环境。

Cloudflare 再次要求验证本身不能证明 V13 回归，V12 也可能遇到相同限制。发生未结案成员操作、结果不明、租约保留或故障诊断仍在执行时，不得靠降级清除阻塞；必须按原凭据完成核对，或继续保持暂停。

## 已锁定的回退点

- V12 原始源码：`aa41d10d4d1481c472d6073a232dcdaaa94b1948`，279 个规范字节文件。
- 本机备份：`D:\codexspace\reports\agentless-before-recovery-v13-20261028`，包含 `canonical/`、`runtime/`、`manifest.json` 和 `source-v12.bundle`。
- 工具硬编码 manifest SHA-256 与 bundle SHA-256，并逐文件校验长度、SHA-256、Git blob SHA-1；移动备份目录不改变其内容即可继续使用。
- Sites 正式项目：`appgprj_6adace8f4e7481919901f886e4a0a2f2`。
- **应用 V12 对应 Sites 原生保存版本 13**：`appgprj_6adace8f4e7481919901f886e4a0a2f2~appgver_9c701ec6d7ec8191a8aef3af7e314ccf`。应用版本号与 Sites 保存序号不同。
- 该 V12 原部署：`appgdep_6ae18ef8434481919760924d38a0526b`。
- GitHub 注释标签 `agentless-v12`，归档提交 `ea9beb63cbdf64bca2e35a6d6a2cdbbc2212b3ab`。GitHub 归档提交与 Sites 源提交不是同一个仓库中的标识，不能混用。

## 操作顺序

1. 在任务计划程序停用 `NUMEMS-Agentless`，同时确认其他 NUMEMS 执行器没有开启。使用现有 `node scripts/agentless/stop.mjs` 正常停机，等待其成功返回。不要强杀浏览器、删除 `worker.lock`、删除 `operation.json` 或改写 `fault-rescue.json`。工具要求最近十五分钟的正常停机结果；超时或锁未释放时保持暂停。
2. 在门户管理员设置中关闭自动分配，并使用现有管理员停用操作关闭成员执行开关。页面、申请数据和业务记录保留。必须在**当前 V13 云端仍在运行时**取得回退安全证明；先降级云端会丢失检查 V13 独占票据的能力，工具会拒绝这种不完整证明。
3. 在 V13 源目录执行默认检查。检查本身只读；输出 `requiresFreshCloudProof: true` 表示本机与备份通过，但仍不能应用。

```powershell
node scripts/agentless/rollback-v12.mjs --check `
  --backup-dir "D:\codexspace\reports\agentless-before-recovery-v13-20261028" `
  --target-root "D:\codexspace\business-seat-portal-agentless"
```

4. 执行带云端验证的检查。工具直接调用目标目录现有的 `host.mjs admin rollback-status`，通过隔离桌面读取真实门户状态，核对本次命令、时间、成功结果、修订号、云端调度与成员执行均已关闭、没有未结案租约／隔离项／活动故障票据。工具不接受外部 JSON 文件代替这次读取。如果身份验证未通过，停止回退并保留证据，不绕过验证。

```powershell
node scripts/agentless/rollback-v12.mjs --check --verify-cloud `
  --backup-dir "D:\codexspace\reports\agentless-before-recovery-v13-20261028" `
  --target-root "D:\codexspace\business-seat-portal-agentless"
```

5. 明确应用。每次必须指定**新的、绝对且与目标／备份目录互不包含**的归档目录；下例名称仅作示例，已经存在时请换新名称。执行前会再次实时读取云端和本机状态。

```powershell
node scripts/agentless/rollback-v12.mjs --apply --verify-cloud `
  --backup-dir "D:\codexspace\reports\agentless-before-recovery-v13-20261028" `
  --target-root "D:\codexspace\business-seat-portal-agentless" `
  --archive-dir "D:\codexspace\reports\agentless-rollback-v12-REPLACE-WITH-UNIQUE-TIME"
```

工具先校验并暂存全部 279 个 V12 文件，完整复制当前被替换文件到 `before/`，复制额外 V13 源码到 `extras/`，保存当前配置。替换成功后，额外源码逐文件移入 `moved-extras/`，不会递归删除。当前配置仅去掉新 `faultRescue` 配置并强制 `liveActions=false`；现有站点、管理员、浏览器路径、轮询配置以及其他设置保留。所有实际业务日志、故障票据、浏览器登录档案、依赖目录、D1 数据保持原位。最后逐文件核验字节与摘要，结果必须是 `state: restored_stopped`。

6. 由 Sites 原生工具回退云端，不能只修改本机。先 `get_site` 确认项目、Owner 与访问范围。正式站是公开登录入口，保留其原有访问范围，**不要使用 owner-private 部署工具，也不要改变共享权限**。调用 `deploy_site_version`，传入上面的正式 `project_id` 和保存版本 ID。仅当返回 pending/building/publishing 时，用返回的 `deployment_id` 调用 `get_deployment_status`，直到 succeeded；不要上传旧数据库快照，不新建站点，不把 GitHub 提交 ID 当成 Sites 版本 ID。
7. 检查正式网页、管理员与员工登录、个人数据隔离、排队／续期／提前释放展示。读取官方完整成员与邀请清单，将其与门户比较；只读探针必须证明工作空间、角色、已购容量和隔离桌面正常。需要重新构建时运行既有安装与构建脚本，不手工改依赖路径。确认构建、健康检查与只读探针通过后，按原运维流程重新开启云端开关、`liveActions` 和唯一计划任务。请勿在未完成验证时自动恢复。

## 验证清单与中断处理

- `rollback-progress.json` 为 `restored_stopped`，源码 279 个文件全部匹配固定 manifest，额外源码有归档，原配置有副本。
- 工具结果仍为 `liveActions=false`，计划任务仍 Disabled；故障票据、操作回执和浏览器档案未被删除或替换。
- Sites 部署确认 succeeded，正式 URL 不变；新的部署指向上面的 V12 保存版本，访问范围和 D1 绑定不变。
- 新申请、排队与续期仍使用当前业务数据，不能恢复备份时刻的 D1；V12 与 V13 使用同一归档表结构，无需 V11 的历史重建操作。
- 若磁盘故障、文件被占用、状态变化或任何校验失败，工具会留下 `partial_stopped`、完整 `staging-v12/`、`before/` 和自身维护锁。此时**不是回退成功**，不可启用任务。确认维护进程确已退出后，先核对归档清单、剩余文件及实际云端状态；由维护人员恢复／续做，不删除业务租约或票据来“解锁”。
- 离线测试覆盖损坏备份、越界路径、活动宿主／任务、未结案日志／票据、过期云端证明、279 文件完整恢复、额外源码归档，以及中途磁盘失败。测试只使用临时合成项目，不对正式项目执行回退。
