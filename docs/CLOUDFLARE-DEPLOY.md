# Cloudflare 部署与托管

本文档把 NUMEMS 席位门户从 ChatGPT Sites 迁到 Cloudflare Workers，使 TRAE CN 可以自己执行部署。

## 本次部署状态

- Worker：`numems-seat-portal-trae`
- 地址：`https://numems-seat-portal-trae.numems.workers.dev/`
- D1：`numems-seat-portal-trae-db`，已建表，`/api/health` 返回 `storage:"ready"`
- 身份模式：`PORTAL_IDENTITY_MODE=oauth`，**只信任服务端签名过的会话 Cookie**
- 登录页 `/login` 已上线；未写入 OAuth 凭据前，登录按钮会返回 `/login?error=not_configured`

## 安全要点

迁移到 Cloudflare 后，客户端可以自行伪造 `oai-authenticated-user-*` 请求头。因此 `PORTAL_IDENTITY_MODE=oauth` 时，代码完全忽略这些头，只接受经 HMAC-SHA256 签名的 `portal_session` Cookie。不要在生产环境把它改回 `sites`。

## 迁移前必须知道

- **网址会变**。`https://numems-seat-portal-trae.workspace-026021.chatgpt.site/` 属于 ChatGPT 的域名，Cloudflare 无法复现。迁移后使用 `https://<worker>.<account>.workers.dev/` 或你自己的域名。
- **登录方式会变**。新站不再有 `oai-authenticated-user-*` 请求头，改用 Google / Microsoft OAuth，登录后按邮箱继续匹配管理员和白名单。
- **办席位仍在本机**。Cloudflare 只托管网页与数据；`admin.openai.com` 的浏览器操作仍由 TRAE/Playwright 在管理员电脑上完成。

## 一、创建 Cloudflare 资源

1. 注册 Cloudflare 账号，记下 **Account ID**。
2. 创建 D1 数据库：

```powershell
$env:CLOUDFLARE_API_TOKEN = "<你的 API Token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<你的 Account ID>"
node node_modules/wrangler/bin/wrangler.js d1 create numems-seat-portal-trae-db
```

命令返回的 `database_id` 就是后面要用的 `CF_D1_DATABASE_ID`。

API Token 至少需要：

- Workers Scripts: Edit
- D1: Edit
- Account Settings: Read

## 二、第一次部署

在项目根目录设置环境变量（PowerShell 示例）：

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<account id>"
$env:CF_D1_DATABASE_ID = "<database id>"
$env:CF_WORKER_NAME = "numems-seat-portal-trae"
$env:CF_D1_DATABASE_NAME = "numems-seat-portal-trae-db"
```

先做一次不接触账号的检查：

```powershell
npm run deploy:cloudflare:dry -- --skip-build
```

正式构建、建表并部署：

```powershell
npm run deploy:cloudflare -- --migrate
```

`--migrate` 会先检查 `portal_state` 是否存在，只在首次部署时执行 `drizzle/0000_bored_stick.sql`。

## 三、启用 Google / 微软 OAuth

站点当前不依赖 Cloudflare Access，因此无需绑卡。登录由应用内 OAuth 完成，回调地址固定为：

- `https://numems-seat-portal-trae.numems.workers.dev/api/auth/google/callback`
- `https://numems-seat-portal-trae.numems.workers.dev/api/auth/microsoft/callback`

### Google

1. 打开 <https://console.cloud.google.com/apis/credentials>，新建项目（例如 `numems-seat-portal`）。
2. **OAuth consent screen**：类型选 External，填写应用名与支持邮箱，测试用户里加入管理员与 Gmail 员工邮箱。
3. **Create credentials → OAuth client ID → Web application**。
4. Authorized redirect URI 填上面的 Google 回调地址，创建后得到 **Client ID** 与 **Client Secret**。

### Microsoft

1. 打开 <https://entra.microsoft.com> → App registrations → New registration。
2. 名称随意，Supported account types 选 **Accounts in any organizational directory and personal Microsoft accounts**。
3. Redirect URI 选 Web，填上面的 Microsoft 回调地址。
4. **Certificates & secrets → New client secret**，复制密钥值（只显示一次）；Client ID 在 Overview 页。

Outlook / Hotmail 账号用 Microsoft 登录；QQ 邮箱需先用该邮箱注册微软账号。

### 写入 Cloudflare

Client ID 作为普通变量，由部署脚本从环境注入：

```powershell
$env:GOOGLE_CLIENT_ID = "<google client id>"
$env:MICROSOFT_CLIENT_ID = "<microsoft client id>"
$env:PUBLIC_ORIGIN = "https://numems-seat-portal-trae.numems.workers.dev"
npm run deploy:cloudflare
```

密钥单独写入（不要写进代码或 Git）：

```powershell
node node_modules/wrangler/bin/wrangler.js secret put GOOGLE_CLIENT_SECRET --config dist/server/wrangler.deploy.json
node node_modules/wrangler/bin/wrangler.js secret put MICROSOFT_CLIENT_SECRET --config dist/server/wrangler.deploy.json
node node_modules/wrangler/bin/wrangler.js secret put SESSION_SECRET --config dist/server/wrangler.deploy.json
```

`SESSION_SECRET` 用随机长字符串（例如 64 位十六进制）；更换后所有已登录会话立即失效。

部署完成后：未登录访问 `/` 会提示登录，`/api/portal` 返回 401；登录后邮箱进入原有管理员/白名单判断。

## 四、提醒与执行器密钥

以下值不要写进代码或 Git：

```powershell
node node_modules/wrangler/bin/wrangler.js secret put REMINDER_WEBHOOK_TOKEN --config dist/server/wrangler.deploy.json
node node_modules/wrangler/bin/wrangler.js secret put PORTAL_WORKER_TOKEN --config dist/server/wrangler.deploy.json
```

`REMINDER_WEBHOOK_URL`、`REMINDER_DELIVERY_MODE=relay`、`PORTAL_PUBLIC_URL` 由部署脚本写入普通变量。

## 五、持续部署

仓库已包含 `.github/workflows/deploy-cloudflare.yml`。在 GitHub 配置：

**Secrets**

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

**Variables**

- `CF_D1_DATABASE_ID`
- `CF_WORKER_NAME`（可省略，默认 `numems-seat-portal-trae`）
- `CF_D1_DATABASE_NAME`（可省略）
- `GOOGLE_CLIENT_ID`
- `MICROSOFT_CLIENT_ID`
- `PORTAL_PUBLIC_URL`
- `PUBLIC_ORIGIN`

之后推送到 `main` 会自动执行：安装依赖 → 构建 → `wrangler deploy`。

也可以不接 GitHub，直接让 TRAE 执行：

```powershell
npm run deploy:cloudflare
```

TRAE 负责构建和调用 `wrangler`，但它不是常驻服务；真正的“推送即部署”由 GitHub Actions 完成。

## 六、后续托管

| 事项 | 做法 |
|---|---|
| 查看日志 | Cloudflare 控制台 → Workers → 该 Worker → Logs |
| 回滚版本 | `wrangler rollback --config dist/server/wrangler.deploy.json` |
| 数据库备份 | D1 → Time Travel，或 `wrangler d1 export` |
| 健康检查 | 定期访问 `/api/health`，应返回 `storage:"ready"` |
| 到期提醒 | 保持 `REMINDER_DELIVERY_MODE=relay`，并配置 relay 地址/令牌 |
| 席位执行 | 管理员电脑上的 TRAE 巡检 + 浏览器办理 |

## 七、给执行器改用新地址

部署后把以下环境变量指向新站，避免提醒链接和执行器仍访问旧站：

```powershell
$env:PORTAL_SITE_URL = "https://numems-seat-portal-trae.<account>.workers.dev/"
```

覆盖位置：

- `scripts/trae/config.mjs`
- `scripts/queue-checker.mjs`
- 提醒邮件正文（服务端读取 `PORTAL_PUBLIC_URL`）

## 八、免费额度

- Workers：10 万请求/天，10ms CPU/请求
- D1：500MB/库、5GB/账户，500 万行读/天、10 万行写/天
- Google / Microsoft OAuth：免费，无用户数限制
- Cloudflare Access 不在本方案中使用（启用需绑定付款方式）

每天几十次访问远低于限制。若日志频繁出现 CPU 超限，再升级 Workers Paid（$5/月）。
