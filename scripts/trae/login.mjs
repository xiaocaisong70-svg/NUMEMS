// 由管理员本人在普通 Edge 专用窗口中登录门户；程序只在窗口关闭后做只读身份核对。
// 密码、Cookie 与令牌不会打印、导出或提交到 Git。
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { TraePortalClient } from "./portal-client.mjs";
import { edgeProfileInUse, findEdgeExecutable } from "../seat-executor/human-login.mjs";

const config = { ...await loadConfig(), headless: false };
const prompt = createInterface({ input: stdin, output: stdout });
try {
  if (await edgeProfileInUse(config.profile))
    throw new Error("TRAE 专用 Edge 档案正在使用中，请先关闭该窗口。");
  const executable = await findEdgeExecutable();
  await mkdir(config.profile, { recursive: true });
  const child = spawn(executable,
    [`--user-data-dir=${config.profile}`, "--no-first-run", "--new-window", config.siteUrl],
    { detached: true, stdio: "ignore", windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  console.log("已打开 TRAE 专用 Edge 窗口。请本人在页面完成 ChatGPT 登录，并确认看到管理员申请中心。");
  console.log("不要在此窗口里输入密码到终端；登录完成后关闭这个专用窗口。");
  for (;;) {
    await prompt.question("关闭专用窗口后按 Enter，程序才会进行只读核对。 ");
    if (!await edgeProfileInUse(config.profile)) break;
    console.log("专用 Edge 档案仍在使用中。请关闭刚才打开的窗口；程序不会替你关闭浏览器。");
  }
  const client = new TraePortalClient(config);
  try {
    await client.open();
    console.log("门户管理员身份已通过只读核对。TRAE 执行器可以使用该档案提交回执。");
  } finally {
    await client.close();
  }
} finally {
  prompt.close();
}
