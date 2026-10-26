param([Parameter(Mandatory=$true)][string]$NodeExe, [switch]$UpgradeWatchdog)
$ErrorActionPreference='Stop'

# PowerShell 7.5+ otherwise converts ISO JSON strings into DateTime values.
# Preserve the evidence exactly as JSON strings; Windows PowerShell 5 already does so.
function Read-JsonStringDates {
  param([Parameter(Mandatory=$true)][string]$Path)
  $arguments = @{ InputObject = (Get-Content -LiteralPath $Path -Raw -Encoding UTF8) }
  if ((Get-Command ConvertFrom-Json -CommandType Cmdlet).Parameters.ContainsKey('DateKind')) {
    $arguments.DateKind = 'String'
  }
  return ConvertFrom-Json @arguments
}

# Pure validation: tests evaluate this function only, never the task installation below.
function Assert-IsolatedProbe {
  param($Config, $Probe, $HostReport, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
  function Test-JsonInteger($Value) {
    return (($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -and
      -not [double]::IsNaN([double]$Value) -and -not [double]::IsInfinity([double]$Value) -and
      [Math]::Floor([double]$Value) -eq [double]$Value)
  }
  function Read-ProbeTime($Value) {
    $parsed = [DateTimeOffset]::MinValue
    if ($Value -isnot [string] -or $Value -notmatch '(Z|[+-]\d{2}:\d{2})$' -or
        -not [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::None, [ref]$parsed)) {
      throw 'Isolation evidence contains an invalid timestamp.'
    }
    if ($parsed -gt $Now -or ($Now - $parsed).TotalMinutes -gt 15) {
      throw 'A successful isolation probe from the last 15 minutes is required.'
    }
    return $parsed
  }
  if ($Config.liveActions -isnot [bool] -or $Config.liveActions -ne $true -or
      $Config.legacyCheckerDisabled -isnot [bool] -or $Config.legacyCheckerDisabled -ne $true) {
    throw 'Live cutover is not configured.'
  }
  if ($Config.browserMode -cne 'isolated_desktop' -or
      $Config.headless -isnot [bool] -or $Config.headless -ne $false) {
    throw 'Scheduled execution requires the verified isolated desktop browser mode.'
  }
  if ($Probe.mode -cne 'isolated_desktop' -or
      $Probe.passed -isnot [bool] -or $Probe.passed -ne $true -or
      $Probe.officialVerified -isnot [bool] -or $Probe.officialVerified -ne $true -or
      $Probe.portalVerified -isnot [bool] -or $Probe.portalVerified -ne $true -or
      $null -ne $Probe.failure -or $null -ne $Probe.officialFailure -or $null -ne $Probe.portalFailure) {
    throw 'Both the official workspace and portal must pass the read-only isolation probe.'
  }
  foreach ($field in @('modelCalls','realInvitesSent','realMembersRemoved','realMailSent')) {
    if (-not (Test-JsonInteger $Probe.$field) -or $Probe.$field -ne 0) {
      throw 'The prerequisite probe must be read-only and make no model calls.'
    }
  }
  $proof = $Probe.desktop
  if ($proof.desktop -isnot [string] -or $proof.desktop -cnotmatch '^NUMEMS-Agentless-[a-zA-Z0-9-]+$' -or
      $proof.isolated -isnot [bool] -or $proof.isolated -ne $true -or
      $proof.windowStation -ine 'WinSta0' -or [string]::IsNullOrWhiteSpace($proof.inputDesktop) -or
      $proof.inputDesktop -ieq $proof.desktop) {
    throw 'The probe did not prove isolation from the input desktop.'
  }
  if ($HostReport.mode -cne 'probe' -or $HostReport.state -cne 'exited' -or
      -not (Test-JsonInteger $HostReport.exitCode) -or $HostReport.exitCode -ne 0 -or
      $HostReport.desktop -cne $proof.desktop -or
      -not (Test-JsonInteger $HostReport.audits) -or $HostReport.audits -le 0 -or
      -not (Test-JsonInteger $HostReport.maxOwnedWindowsOnInputDesktop) -or
      $HostReport.maxOwnedWindowsOnInputDesktop -ne 0 -or $null -ne $HostReport.error) {
    throw 'A completed successful host audit for the same isolated desktop is required.'
  }
  $audit = $HostReport.windowAudit
  if ($audit.isolated -isnot [bool] -or $audit.isolated -ne $true -or
      $audit.desktop -cne $proof.desktop -or [string]::IsNullOrWhiteSpace($audit.inputDesktop) -or
      $audit.inputDesktop -ieq $audit.desktop -or
      -not (Test-JsonInteger $audit.ownedWindowsOnInputDesktop) -or $audit.ownedWindowsOnInputDesktop -ne 0) {
    throw 'The final host window audit did not verify desktop isolation.'
  }
  $started = Read-ProbeTime $Probe.checkedAt
  $finished = Read-ProbeTime $Probe.finishedAt
  $audited = Read-ProbeTime $HostReport.checkedAt
  if ($started -gt $finished -or $finished -gt $audited) {
    throw 'Probe and host evidence timestamps are inconsistent.'
  }
}

$projectPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimePath=Join-Path $projectPath '.sites-runtime\agentless'
$config=Read-JsonStringDates -Path (Join-Path $runtimePath 'config.json')
$probe=Read-JsonStringDates -Path (Join-Path $runtimePath 'isolated-probe.json')
$hostReport=Read-JsonStringDates -Path (Join-Path $runtimePath 'host-desktop.json')
Assert-IsolatedProbe -Config $config -Probe $probe -HostReport $hostReport
$others=@(Get-ScheduledTask | Where-Object {$_.TaskName -like 'NUMEMS*' -and $_.State -ne 'Disabled' -and
  (-not $UpgradeWatchdog -or $_.TaskName -ne 'NUMEMS-Agentless')})
if($others.Count){throw 'Another NUMEMS task is enabled. Review cutover first.'}
$nodePath=[IO.Path]::GetFullPath($NodeExe)
if(-not [IO.Path]::IsPathRooted($NodeExe) -or [IO.Path]::GetFileName($nodePath) -ine 'node.exe' -or
    -not (Test-Path -LiteralPath $nodePath -PathType Leaf)){throw 'An absolute installed node.exe is required.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
if($identity -match 'CodexSandbox'){throw 'Install as the actual Windows user.'}
$taskName='NUMEMS-Agentless'
$existingTask=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existingTask -and -not $UpgradeWatchdog){throw 'Task already exists; not overwritten.'}
if($UpgradeWatchdog) {
  if(-not $existingTask -or $existingTask.State -ne 'Ready') { throw 'Upgrade requires the existing stopped/Ready task.' }
  $expectedArgument='//B //NoLogo "'+(Join-Path $PSScriptRoot 'run-hidden.vbs')+'" "'+$nodePath+'"'
  if(@($existingTask.Actions).Count -ne 1 -or
      $existingTask.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32\wscript.exe') -or
      $existingTask.Actions[0].Arguments -cne $expectedArgument -or
      $existingTask.Actions[0].WorkingDirectory -ine $projectPath -or
      $existingTask.Principal.LogonType -ne 'Interactive') { throw 'Existing task identity/action mismatch; not overwritten.' }
  $principalId=$existingTask.Principal.UserId
  $principalSid = if ($principalId -match '^S-1-') {
    ([Security.Principal.SecurityIdentifier]::new($principalId)).Value
  } else {
    ([Security.Principal.NTAccount]::new($principalId)).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  if($principalSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    throw 'Existing task belongs to another user; not overwritten.'
  }
  if(Test-Path -LiteralPath (Join-Path $runtimePath 'worker.lock')) { throw 'Worker lock still present; finish/reconcile first.' }
  $backupPath=Join-Path $runtimePath ('task-before-watchdog-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')+'.xml')
  Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $backupPath -Encoding UTF8
}
$hostPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher=Join-Path $PSScriptRoot 'watchdog-hidden.vbs'
$action=New-ScheduledTaskAction -Execute $hostPath -Argument ('//B //NoLogo "'+$launcher+'" "'+$nodePath+'"') -WorkingDirectory $projectPath
$trigger=@((New-ScheduledTaskTrigger -AtLogOn -User $identity),
  (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval ([TimeSpan]::FromMinutes(1))))
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
# Periodic checks run the classifier, never restart an uncertain member action.
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'NUMEMS deterministic executor with guarded local watchdog. No Agent calls.' -Force:$UpgradeWatchdog | Out-Null
Start-ScheduledTask -TaskName $taskName
