import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// This is a regular Edge process, launched without Playwright, remote debugging,
// or browser automation flags. It owns only the executor's dedicated profile.
export function edgeCandidates(env = process.env) {
  return [
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
}

export function edgeLaunchArguments(profile, adminUrl, siteUrl) {
  if (!path.isAbsolute(profile)) throw new Error("Edge 登录档案必须使用绝对路径。");
  for (const value of [adminUrl, siteUrl]) {
    if (new URL(value).protocol !== "https:") throw new Error("登录页面必须使用 HTTPS。");
  }
  return [`--user-data-dir=${profile}`, "--no-first-run", "--new-window", adminUrl, siteUrl];
}

export async function findEdgeExecutable(env = process.env) {
  if (process.platform !== "win32") throw new Error("当前登录流程仅支持 Windows 上的普通 Edge。");
  for (const candidate of edgeCandidates(env)) {
    try { await access(candidate); return candidate; } catch { /* Try next installed location. */ }
  }
  throw new Error("没有找到系统安装的 Microsoft Edge，请先安装 Edge。");
}

export async function edgeProfileInUse(profile) {
  if (process.platform !== "win32") throw new Error("无法核对 Edge 专用档案是否已关闭。");
  // The profile path is passed in an environment variable, never interpolated
  // into a PowerShell command. No process command line is logged or returned.
  const script = [
    "$needle = $env:NUMEMS_EDGE_PROFILE",
    "$processes = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" -ErrorAction Stop",
    "$found = $processes | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1",
    "if ($null -eq $found) { '0' } else { '1' }",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, NUMEMS_EDGE_PROFILE: profile },
    windowsHide: true, timeout: 15_000,
  });
  const result = stdout.trim();
  if (result !== "0" && result !== "1") throw new Error("无法确认专用 Edge 窗口已关闭。");
  return result === "1";
}

export async function openNormalEdge(profile, adminUrl, siteUrl) {
  if (await edgeProfileInUse(profile))
    throw new Error("执行器专用 Edge 档案正在使用中，请先关闭该窗口或停止执行器；现有窗口不会被关闭。");
  const executable = await findEdgeExecutable();
  await mkdir(profile, { recursive: true });
  const child = spawn(executable, edgeLaunchArguments(profile, adminUrl, siteUrl), {
    detached: true, stdio: "ignore", windowsHide: false,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
