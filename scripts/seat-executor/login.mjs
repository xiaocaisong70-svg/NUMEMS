import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { BrowserAdapter } from "./browser.mjs";
import { edgeProfileInUse, openNormalEdge } from "./human-login.mjs";

// Human sign-in uses ordinary Edge first. Playwright starts only after that
// window is closed, and then performs read-only administrator verification.
// The dedicated profile stays inside ignored local runtime; no credential is
// printed, exported or submitted by this script.
const config = { ...await loadConfig(), headless: false, liveActions: false };
const browser = new BrowserAdapter(config);
const prompt = createInterface({ input: stdin, output: stdout });
try {
  await openNormalEdge(config.profile, browser.url(), config.siteUrl);
  console.log("已打开普通 Edge 专用窗口。请本人在两个标签页完成登录；不要在终端输入密码。");
  console.log("确认看到 My Workspace 和 NUMEMS 管理员页面后，请关闭这次专用 Edge 窗口。其他 Edge 窗口不用关闭。");
  for (;;) {
    await prompt.question("关闭专用窗口后按 Enter，程序才会进行只读核对。 ");
    if (!await edgeProfileInUse(config.profile)) break;
    console.log("专用 Edge 档案仍在使用中。请关闭刚才打开的专用窗口；程序不会替你关闭浏览器。");
  }
  await browser.open();
  await browser.page.goto(browser.url(), { waitUntil: "domcontentloaded" });
  await browser.observe();
  const portal = await browser.context.newPage();
  await portal.goto(config.siteUrl, { waitUntil: "domcontentloaded" });
  const access = await portal.evaluate(async () => {
    const response = await fetch("/api/portal", { cache: "no-store", credentials: "same-origin" });
    return { status: response.status, data: await response.json() };
  });
  if (access.status !== 200 || access.data?.access !== "allowed" ||
      access.data?.user?.email?.toLowerCase() !== config.adminEmail)
    throw new Error("门户管理员身份尚未通过核对，登录档案未验收。");
  console.log("普通 Edge 登录档案中的官方完整成员/邀请列表和门户管理员身份已通过只读核对。");
} finally {
  prompt.close();
  await browser.close();
}
