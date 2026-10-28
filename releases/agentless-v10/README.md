# NUMEMS agentless-v10

归档日期：2026-10-27。Developed by xcsong.

本归档对应已发布 Sites 第十版及配套本机源码，维护分支为 agentless，版本归档分支为 agentless-v10（并非 Git tag，取回时以归档提交 SHA 为准）。原 main 分支及既有标签、历史校验清单保留。

## 来源

| 项目 | 值 |
| --- | --- |
| 线上地址 | https://numems-seat-portal-agentless.workspace-026021.chatgpt.site/ |
| Sites 发布源提交 | 1a55cfe21f1914997df41facbd584bc58ad42d42 |
| 源树 | ddc19e505e8e98871597842ce26acfed7f29d17a |
| Sites 版本号 | 10 |
| Sites 版本 ID | appgprj_6adace8f4e7481919901f886e4a0a2f2~appgver_a6d0ad7ada5481919806d4e445cfa6ea |
| 成功部署 ID | appgdep_6ae16229b1588191ae05c63d629f27f2 |
| 发布包 SHA-256 | a4c2e6b3a0282d30ddc5e81fe0dc3cd8fa4fc4c0a1007d4d5bb3351b78574262 |

## 修复与验证

修复原操作成功核实后暂停遗留的状态机缺口；减少恢复核查重复读取；为官方页面自然等待和诊断保留严格边界。85 项针对性联合测试、TypeScript 与生产构建通过，独立真实 D1 6 项合成数据测试通过。详见[修复说明](../../docs/EXPIRY-ROOTFIX-20261027.md)。

三笔真实到期回收由授权的受控官方浏览器流程完成，并非无模型执行器的端到端验收。隐藏执行仍可能遭官方安全验证阻塞；本归档不承诺会话永久有效、所有后续回收永不暂停或无人值守已通过。

## 校验

检出版本归档分支后运行；需要不可变引用时，请同时保存本次 GitHub 归档提交 SHA：

```powershell
git clone --branch agentless-v10 https://github.com/xiaocaisong70-svg/NUMEMS.git NUMEMS-agentless-v10
cd NUMEMS-agentless-v10
node scripts/verify-release.mjs
```

清单不包含自身，由 Git 提交固定；v10 以版本分支及精确提交引用，旧版须检出其原标签后使用对应校验工具。业务源码与 Sites 源树按字节比较；README、公共维护文档、忽略规则和校验工具的整理差异在 manifest 中标记。密码、Cookie、Token、运行配置、生产数据库、任务导出和操作日志均不在上传范围。

## 回退

GitHub 上一固定版本为 agentless-v7。生产另保留第九版 Sites 归档和配套文件备份；回退时暂停后续调度、保留未完成租约和官方回执，再按[版本管理](../../docs/GITHUB-VERSIONING.md)核对恢复。代码回退不能撤销已经发生的成员或数据库变化。
