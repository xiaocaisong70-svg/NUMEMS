import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { BrowserAdapter } from "./browser.mjs";

// Human sign-in only. The dedicated profile stays inside ignored local runtime;
// no cookie, password or token is printed, exported or submitted by this script.
const config = { ...await loadConfig(), headless: false, liveActions: false };
const browser = new BrowserAdapter(config);
const prompt = createInterface({ input: stdin, output: stdout });
try {
  await browser.open();
  await browser.page.goto(browser.url(), { waitUntil: "domcontentloaded" });
  const portal = await browser.context.newPage();
  await portal.goto(config.siteUrl, { waitUntil: "domcontentloaded" });
  console.log("请本人在两个标签页完成管理员登录；不要在终端输入密码。");
  await prompt.question("确认已看到 My Workspace 和 NUMEMS 管理员页面后，按 Enter 保存专用浏览器登录档案。 ");
  await browser.observe();
  const access = await portal.evaluate(async () => {
    const response = await fetch("/api/portal", { cache: "no-store", credentials: "same-origin" });
    return { status: response.status, data: await response.json() };
  });
  if (access.status !== 200 || access.data?.access !== "allowed" ||
      access.data?.user?.email?.toLowerCase() !== config.adminEmail)
    throw new Error("门户管理员身份尚未通过核对，登录档案未验收。");
  console.log("官方完整成员/邀请列表和门户管理员身份已通过只读核对。");
} finally {
  prompt.close();
  await browser.close();
}
