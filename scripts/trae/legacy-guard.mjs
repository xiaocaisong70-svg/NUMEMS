// Fail closed unless the original Windows queue task is actually disabled.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { root, runtimeDir } from "./config.mjs";

const execFileAsync = promisify(execFile);
const legacyProjectRoot = path.resolve(root, "..", "business-seat-portal");
const legacyStatusPath = path.join(legacyProjectRoot, ".sites-runtime", "queue-checker", "status.json");

export async function queryLegacyTaskState() {
  if (process.platform !== "win32") throw new Error("无法在非 Windows 环境核实旧计划任务状态。");
  const command = "$ErrorActionPreference='Stop'; " +
    "$tasks=@(Get-ScheduledTask -TaskPath '\\' -TaskName 'NUMEMS-Seat-Queue' -ErrorAction Stop); " +
    "if($tasks.Count -ne 1){throw 'Legacy task missing or ambiguous'}; " +
    "[Console]::Out.WriteLine($tasks[0].State.ToString())";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
  return stdout.trim();
}

export async function assertLegacyInactive(config, now = Date.now(),
  queryTaskState = queryLegacyTaskState, readStatusFile = readFile) {
  if (!config.legacyCheckerDisabled)
    throw new Error("旧按需检查任务未在本机配置中确认停用，拒绝并行办理。");
  let state;
  try { state = await queryTaskState(); }
  catch { throw new Error("无法核实旧 Windows 计划任务已停用，拒绝并行办理。"); }
  if (state !== "Disabled")
    throw new Error(`旧 Windows 计划任务状态为 ${state || "未知"}，拒绝并行办理。`);
  try {
    const status = JSON.parse(await readStatusFile(legacyStatusPath, "utf8"));
    if (!Number.isFinite(Date.parse(status.checkedAt)) || now - Date.parse(status.checkedAt) < 180_000)
      throw new Error("旧按需检查器最近仍在运行，拒绝并行办理。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { legacyTaskState: "Disabled", verifiedAt: new Date(now).toISOString(), runtimeDir };
}
