param(
  [Parameter(Mandatory=$true)][string]$NodeExe
)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimePath = Join-Path $projectPath '.sites-runtime\seat-executor'
$configPath = Join-Path $runtimePath 'config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Executor config is missing.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.liveActions -ne $true -or $config.legacyCheckerDisabled -ne $true) {
  throw 'Live cutover has not been explicitly configured and verified.'
}
$old = Get-ScheduledTask -TaskName 'NUMEMS-Seat-Queue' -ErrorAction SilentlyContinue
if ($old -and $old.State -ne 'Disabled') { throw 'The original queue checker is still enabled.' }
$nodePath = [IO.Path]::GetFullPath($NodeExe)
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Node executable not found.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($identity -match 'CodexSandbox') { throw 'Install under the actual signed-in Windows user.' }
$taskName = 'NUMEMS-Seat-Executor'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  throw 'An executor task already exists; review it before replacing.'
}
$windowlessHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $PSScriptRoot 'run-hidden.vbs'
$arguments = '//B //NoLogo "' + $launcher + '" "' + $nodePath + '"'
$action = New-ScheduledTaskAction -Execute $windowlessHost -Argument $arguments -WorkingDirectory $projectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'NUMEMS deterministic seat executor; only one signed-in owner profile; no model in routine processing.' | Out-Null
Start-ScheduledTask -TaskName $taskName
[pscustomobject]@{ TaskName=$taskName; State=(Get-ScheduledTask -TaskName $taskName).State.ToString();
  User=$identity; Node=$nodePath; Script=(Join-Path $PSScriptRoot 'main.mjs') } | ConvertTo-Json
