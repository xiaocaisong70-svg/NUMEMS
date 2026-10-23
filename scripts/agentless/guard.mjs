import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function queryConflicts() {
  if(process.platform !== 'win32') throw new Error('当前安装流程只支持 Windows。');
  const script = "$ErrorActionPreference='Stop'; " +
    "$tasks=@(Get-ScheduledTask | Where-Object {$_.TaskName -like 'NUMEMS*' -and $_.TaskName -ne 'NUMEMS-Agentless' -and $_.State -ne 'Disabled'}); " +
    "$workers=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {$_.ProcessId -ne [int]$env:NUMEMS_OWN_PID -and $_.CommandLine -match 'queue-checker\\.mjs|trae[\\\\/]executor\\.mjs|seat-executor[\\\\/]main\\.mjs|agentless[\\\\/]main\\.mjs'}); " +
    "[pscustomobject]@{tasks=@($tasks | ForEach-Object {$_.TaskName}); workers=$workers.Count} | ConvertTo-Json -Compress";
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,timeout:15000,env:{...process.env,NUMEMS_OWN_PID:String(process.pid)}});
  return JSON.parse(stdout);
}
export async function assertExclusive(config,query=queryConflicts) {
  if(!config.liveActions) return;
  if(!config.legacyCheckerDisabled) throw new Error('尚未配置独占接管；现有执行器不受本项目影响。');
  const result=await query();
  if(!Array.isArray(result.tasks) || !Number.isInteger(result.workers) || result.workers<0 ||
      result.tasks.length || result.workers) throw new Error('检测到其他 NUMEMS 定时任务或办理进程；禁止双执行器。');
}
