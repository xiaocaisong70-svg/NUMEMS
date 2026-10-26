import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
test('native host dead-lock recovery preserves evidence and refuses live or unfinished workers', {skip:process.platform!=='win32'},()=>{
  const launcher=path.resolve(import.meta.dirname,'../scripts/agentless/isolated-desktop.ps1').replaceAll("'","''");
  const script=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$errors=$null; $tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${launcher}',[ref]$tokens,[ref]$errors)
if($errors){throw 'Launcher syntax failed.'}
$recover=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Restore-SettledWorkerLock'},$true).Body.GetScriptBlock()
$runtimePath=Join-Path ([IO.Path]::GetTempPath()) ('numems-dead-lock-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($runtimePath)
$lockPath=Join-Path $runtimePath 'worker.lock'
$journalPath=Join-Path $runtimePath 'operation.json'
$report=@{}
$result=@()
try {
  foreach($phase in @('claiming','claimed','attempting','completing')) {
    [IO.File]::WriteAllText($lockPath,'{"pid":2147483647,"at":"2026-10-26T01:00:00Z"}')
    [IO.File]::WriteAllText($journalPath,('{"phase":"'+$phase+'"}'))
    $blocked=$false
    try {& $recover} catch {$blocked=$true}
    $result+=@{case=$phase;blocked=$blocked;lockRetained=[IO.File]::Exists($lockPath)}
  }
  [IO.File]::WriteAllText($journalPath,'{"phase":"settled"}')
  [IO.File]::WriteAllText($lockPath,('{"pid":'+$PID+',"at":"2026-10-26T01:00:00Z"}'))
  $blocked=$false;try {& $recover} catch {$blocked=$true}
  $result+=@{case='alive';blocked=$blocked;lockRetained=[IO.File]::Exists($lockPath)}
  [IO.File]::WriteAllText($lockPath,'{"pid":2147483647,"at":"2026-10-26T01:00:00Z"}')
  $original=[IO.File]::ReadAllText($lockPath)
  & $recover
  $archives=@([IO.Directory]::GetFiles($runtimePath,'worker.lock.archived-*.json'))
  $result+=@{case='settled_dead';lockRetained=[IO.File]::Exists($lockPath);archived=($archives.Count -eq 1 -and [IO.File]::ReadAllText($archives[0]) -ceq $original);journalPreserved=([IO.File]::ReadAllText($journalPath) -ceq '{"phase":"settled"}')}
  ConvertTo-Json -InputObject @($result) -Compress
} finally {
  foreach($file in [IO.Directory]::GetFiles($runtimePath)){[IO.File]::Delete($file)}
  [IO.Directory]::Delete($runtimePath)
}`;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'}).trim());
  for(const row of result.slice(0,-1)){assert.equal(row.blocked,true,row.case);assert.equal(row.lockRetained,true,row.case);}
  assert.deepEqual(result.at(-1),{case:'settled_dead',lockRetained:false,archived:true,journalPreserved:true});
});
