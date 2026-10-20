param(
  [Parameter(Mandatory=$true)][string]$CodexCli,
  [string]$ThreadId = '01a1522f-edd9-7b01-9c10-70c0899e3ba8'
)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $projectPath '.sites-runtime\queue-checker'
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $CodexCli -PathType Leaf)) { throw 'Codex CLI not found.' }
if ($ThreadId -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid thread ID.' }
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$configPath = Join-Path $runtimePath 'config.json'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($identity -match 'CodexSandbox') { throw 'Install under the actual signed-in Windows user.' }
$taskName = 'NUMEMS-Seat-Queue'
$runner = Join-Path $projectPath 'scripts\queue-checker.mjs'
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $runner + '"') -WorkingDirectory $projectPath
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(20) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$description = 'Ordinary NUMEMS queue checks without inference. Queues a Codex message only for fresh actionable work. Requires the signed-in user and Codex desktop for browser operations.'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions.Execute -ne $nodePath) { throw 'Existing task has a different executable; review before replacing.' }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null
@{cli=[IO.Path]::GetFullPath($CodexCli); threadId=$ThreadId; projectPath=$projectPath; taskName=$taskName} |
  ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
Start-ScheduledTask -TaskName $taskName
$saved = Get-ScheduledTask -TaskName $taskName
[pscustomobject]@{TaskName=$saved.TaskName; State=$saved.State.ToString(); User=$saved.Principal.UserId; LogonType=$saved.Principal.LogonType.ToString(); Interval=$saved.Triggers.Repetition.Interval; Node=$saved.Actions.Execute; Script=$runner} | ConvertTo-Json
