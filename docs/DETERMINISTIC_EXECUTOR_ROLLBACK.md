# 原版门户的确定性执行器改造与回退

本文针对 `D:\codexspace\business-seat-portal` 及其现有 Sites 站点。改造目标是减少日常办理对 Codex 的依赖；回退目标是在新程序故障时恢复改造前的**代码和运行路径**，同时保护持续更新的申请数据和官方成员状态。

## 已固定的改造前基线

| 项目 | 已核实的值 |
| --- | --- |
| Git 提交 | `b387021b82626aa726f8a093f862677161215f4e` |
| Git 标签 | `before-deterministic-executor-2026-10-20`，指向上述提交 |
| 离线 Git bundle | `D:\codexspace\backups\business-seat-portal-before-deterministic-executor-2026-10-20.bundle`；`git bundle verify` 已通过 |
| bundle SHA-256 | `C79BAEC28907F697DD56720AD9CD1CA5843E2BDB2960321298F6734D7DCFB5D3` |
| 旧执行器运行配置/状态快照 | `D:\codexspace\backups\business-seat-portal-runtime-before-deterministic-executor-2026-10-20.zip`；SHA-256 `816F876E751E3AD38A8D9CFB6DB854BE4D38CBC57DD91B6D7DE25E2B62046840` |
| Windows 原任务定义 | `D:\codexspace\backups\NUMEMS-Seat-Queue-before-deterministic-executor-2026-10-20.xml`；SHA-256 `36E7B59A6C5C50C9EFB73BC9007B22EE44E6622A0005FE12911A363FE450A9D5` |
| Sites 项目 ID | `appgprj_6ad6d76874cc8191a1f3191b8e66ca74` |
| 原版线上网址 | `https://numems-seat-portal.workspace-026021.chatgpt.site/` |
| 改造前线上版本 | 第 13 版，版本 ID `appgprj_6ad6d76874cc8191a1f3191b8e66ca74~appgver_f4c8e399feb88191ad6e89d711344c1e` |
| 第 13 版部署 | `appgdep_6ad8262d668c81918a438b9f65c690e8`，已成功，发布包已保存 |
| 站点访问模式 | `public`；应用内部登录与员工白名单仍须生效 |
| 生产数据库 | D1 绑定 `DB`，表 `portal_state`，列为 `id`、`revision`、`document` |

本地项目没有配置 Git remote。标签只存在于本机仓库，bundle 才是独立于该仓库的离线源码备份。检查备份时使用以下只读命令：

2026-10-20 21:00（本机时间）核对到原计划任务 `NUMEMS-Seat-Queue` 为 `Ready`，最近执行结果为 0，下次执行时间已安排；它并未因保存新代码而停用。不得让新执行器同时接管。

```powershell
git -C 'D:\codexspace\business-seat-portal' rev-list -n 1 before-deterministic-executor-2026-10-20
git -C 'D:\codexspace\business-seat-portal' bundle verify 'D:\codexspace\backups\business-seat-portal-before-deterministic-executor-2026-10-20.bundle'
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\codexspace\backups\business-seat-portal-before-deterministic-executor-2026-10-20.bundle'
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\codexspace\backups\business-seat-portal-runtime-before-deterministic-executor-2026-10-20.zip'
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\codexspace\backups\NUMEMS-Seat-Queue-before-deterministic-executor-2026-10-20.xml'
```

五项结果应分别匹配上表中的提交、验证通过和三个 SHA-256。运行快照包含旧检查器配置及状态，任务 XML 包含本机执行路径；仅存于本机备份目录，不得公开上传。不要删除第 13 版 Sites 发布包、bundle、运行快照或任务定义。

## 切换前检查

1. 保持当前第 13 版在线，先在本地完成代码检查、构建和同等功能验证。保存新版本不等于部署；部署是独立步骤。
2. 新执行器必须沿用门户现有的独占领取、观察官方完整成员与邀请列表、逐项核实、回报完成或隔离故障的约束。保持 D1 表结构与 `document` 格式向后兼容；本次改造不得对生产 D1 做不可逆迁移。当前 Sites 工具没有可验证的生产 D1 导出/恢复能力，涉及不兼容迁移时须暂停发布，先另行建立并演练数据库备份。
3. 记录旧检查程序的实际运行方式、Windows 计划任务 `NUMEMS-Seat-Queue` 的状态、Codex 唤醒配置、Sites 环境变量**名称与修订号**，以及新执行器的运行配置。不要将密钥值、浏览器 Cookie 或管理员登录资料写入仓库或回退说明。不能仅因一个账号下未找到计划任务，就断定其他账号下也未安装。
4. 生产切换前检查门户当前计划没有未完成的独占租约或结果不明的外部操作。若已有未完成办理，先按原流程核实官方状态并完成或隔离；不能让两个执行器同时领取和办理同一任务。
5. 先停用**旧**模型唤醒入口并确认它不再派发新唤醒，再启动**新**执行器。新执行器初次应只读观察／试运行，确认工作空间 ID、管理员账号、容量、成员与邀请清单、队列状态一致后才开启写操作。旧站、优化站和本地独立站不得同时针对同一工作空间启用成员写入执行器。
6. 切换后用真实、已批准的待办逐项验收申请、FIFO 排队、续期、到期判断、30 分钟提醒、5 分钟邀请等待保护、提前释放、邀请、加入状态核对与移除。不得为验收伪造员工申请、缩短截止时间或修改成员权限。

## 何时立即回退

- 发布前：任一相关测试、类型检查、构建或权限校验失败，停止发布；第 13 版继续在线。
- 发布中：Sites 部署失败、版本 ID 或目标项目不符、访问范围意外改变，停止切换并回退。
- 发布后：员工登录/白名单、申请/排队/续期/提前释放、倒计时/5 分钟转派、30 分钟提醒、官方邀请/核对/移除的行为或页面表现退化；出现错误成员操作、重复邀请/邮件、容量超配、任务长期阻塞、D1 读取错误、执行器重复运行或无法可靠判断外部操作结果时，立即冻结外部写操作并回退。

对于成员操作、邮件发送或审批结果不明的任务，回退之前先记录并核对实际官方状态；**不能**因为换回旧代码就盲目重试。此类任务保持隔离，直到取得明确回执。

## 回退步骤

1. 停止新执行器及其计划任务／服务，确认不会再发送邮件、邀请或移除。标记并保留进行中的 operation ID、租约和回执。检查旧检查程序是否仍在运行，避免双执行器。若无法确认新进程停止，先不要恢复旧自动办理。
2. 调用 Sites `get_site`，确认项目 ID 和当前访问模式仍为上表所示。对**同一项目**调用 `deploy_site_version`，传入上表中的第 13 版版本 ID；不要创建新 Site，也不要改变访问名单、绑定、D1 或席位数量。随后用返回的部署 ID 调用 `get_deployment_status`，直到状态为 `succeeded`，并确认网址仍为原版网址。该站点为公共访问模式，使用普通的 `deploy_site_version`，而非仅所有者可访问站点的私有部署接口。
3. 将本地执行路径恢复到基线。先保留失败改造的修改：如工作树有未提交文件，在项目目录执行 `git stash push --include-untracked -m 'failed deterministic executor cutover'`，检查 `git status --porcelain` 为空后，执行 `git switch --detach before-deterministic-executor-2026-10-20`。不要直接对带有未保存修改的目录执行 `git reset --hard`。若本地仓库损坏，可在**新的空目录**从离线 bundle 恢复，不覆盖原目录：

   ```powershell
   git clone 'D:\codexspace\backups\business-seat-portal-before-deterministic-executor-2026-10-20.bundle' 'D:\codexspace\business-seat-portal-recovery'
   git -C 'D:\codexspace\business-seat-portal-recovery' switch --detach before-deterministic-executor-2026-10-20
   git -C 'D:\codexspace\business-seat-portal-recovery' rev-parse HEAD
   ```

   新目录只用于核验与恢复源码。旧版 `queue-checker` 的配置含绝对项目路径；要在新目录运行它，须单独核对和重新配置。不要复制忽略目录中的浏览器资料、密钥或旧进程锁。
4. 只在确认新执行器已经停止、未完成操作已经核对、旧版门户读取当前 D1 正常之后，按切换前记录的状态恢复原有检查程序或调度。不要顺手开启原先未启用的每分钟 Codex 自动化。

## 回退成功的验证

- Sites 部署状态为 `succeeded`，其 `version_id` 精确等于上表第 13 版；`get_site` 返回原网址和原访问模式。源码提交应为 `b387021b82626aa726f8a093f862677161215f4e`。
- 管理员与白名单员工可按原有方式登录；其他账号不能读取申请数据。员工页面及管理员页的关键操作、中文提示、倒计时、队列人数/剩余席位/预计等待时间与原版一致。
- 读取当前 D1 队列和站点状态成功，已有申请、通知及审计记录仍在；与官方工作空间的完整成员和邀请列表核对占用容量。生产 D1 保持原有数据，不将其还原到旧时间点。
- 只存在一个实际负责写入的执行器；旧检查程序是否恢复应与切换前记录一致。已隔离或结果不明的任务不自动重试。
- 对本地恢复的基线源码运行原有检查：`node --experimental-strip-types --test tests/seat-engine.test.mjs`、`node node_modules/typescript/bin/tsc --noEmit`，以及适用的 Sites 构建。线上核对优先使用现有真实状态，不制造测试成员变更。

站点版本回退**不能**撤销已经发出的邮件、ChatGPT 官方邀请/移除、生产 D1 写入或外部执行器的本地状态。此方案通过不兼容数据迁移禁令、单执行器切换、外部操作回执核对和第 13 版重新部署，确保可恢复原版对当前数据的运行能力。
