# V14 回退到 V13

当前可靠性改造的 V13 基线为 `336b98236f694c3ea574e970efaaf29361b0e909`，共 300 个源码文件。完整 Git bundle、原始 Git blob、SHA-256 清单和私有运行配置保存在本机 `D:\codexspace\reports\agentless-before-v14-20261028`。备份中的私有配置不能上传 GitHub。

## 触发条件

- 类型检查、回归、构建或独立 D1 验收失败：不发布，不替换运行源码。
- 发布后登录/白名单/排队/续期行为回归、任务领取重复、异常唤醒超过上限、运行入口失败或官方回执错误：立即暂停新领取，核对原租约后回退。
- 单独出现官方安全检查或登录失效，不足以判定版本回归；先检查实际证据，不恢复旧数据库掩盖任务。

## 顺序

1. 停用 `NUMEMS-Agentless` 定时任务，通过 `scripts/agentless/stop.mjs` 正常停机。禁止删除 lock、租约或故障票据强行继续。
2. 若备用模型仍在运行、排队、终态不明，或成员点击结果不明，先核对对应原回执。只有真实终态、无未结案租约及隔离项后才回退。到期不等于原操作失败。
3. 在当前 V14 云端关闭队列和成员执行开关，保留业务数据。用现有 `version_rollback_status` 核对当前修订、开关、无 busy/hold 和已结束故障票据。`rollback-v13.mjs --verify-cloud` 会经原登录通道重新读取，拒绝手写的生产证明。
4. 运行只读预检，再用显式独立归档目录应用回退：

```powershell
node scripts/agentless/rollback-v13.mjs --check --verify-cloud
node scripts/agentless/rollback-v13.mjs --apply --verify-cloud --target-root D:\codexspace\business-seat-portal-agentless --backup-dir D:\codexspace\reports\agentless-before-v14-20261028 --archive-dir D:\codexspace\reports\agentless-v14-rollback-YYYYMMDD-HHMMSS
```

5. 工具验证固定备份哈希、原始 blob 和全部 300 文件，将改造文件及新增文件归档，原子恢复源码。运行配置保持 `liveActions=false` 并移除 V14 备用执行设置；浏览器档案、当前 D1、原租约和故障日志保留。
6. 用 Sites 将原 V13 已保存版本重新发布到同一站点：`appgprj_6adace8f4e7481919901f886e4a0a2f2~appgver_53af12da2bd081918a0b463ef7b47028`。它是 Sites 内部第 15 个保存版本，产品版本是 V13。访问范围保持不变。
7. 重新构建/验证只读入口及当前官方成员名单。确认网页状态、配置、全部源码哈希和实际官方状态一致后，再按管理员授权恢复定时任务。工具绝不会自动启用旧执行器。

## 验证成功

全部 300 个源码文件与固定 V13 清单一致；Sites 部署显示 succeeded 且源提交为上述 SHA；无未结束旧进程或并行执行器；D1 请求/续期/历史和官方席位未丢失；登录与员工白名单行为一致；运行配置依然停用，需核验后再恢复。

离线回退测试在临时目录验证完整 300 文件恢复、篡改拒绝、未结案租约/模型票据拒绝及中途磁盘失败保留预映像和暂停状态。生产回退不能以离线测试代替新鲜云端和进程证据。
