param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [ValidateSet('probe','once','run','admin')][string]$Mode = 'probe',
  [ValidateSet('status','observe','prepare-test','release-test','test-reminder','test-expire','enable-live','disable','reconcile','recover-browser','resolve-alert','resume-test-invite','review-test-workspace')][string]$AdminCommand,
  [string]$RequestId
)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimePath = Join-Path $projectPath '.sites-runtime\agentless'
$reportPath = Join-Path $runtimePath 'host-desktop.json'
$nodePath = [IO.Path]::GetFullPath($NodeExe)
$session = $null
$mutex = $null
$hasMutex = $false
$resultCode = 1
$report = [ordered]@{ checkedAt=[DateTime]::UtcNow.ToString('o'); mode=$Mode; state='starting'; modelCalls=0; desktop=$null; inputDesktop=$null; processId=$null; audits=0; maxOwnedWindowsOnInputDesktop=0; maxOwnedWindowsOnIsolatedDesktop=0 }
function Save-HostReport {
  [IO.Directory]::CreateDirectory($runtimePath) | Out-Null
  $temporaryPath = $reportPath + '.' + $PID + '.tmp'
  [IO.File]::WriteAllText($temporaryPath, ($report | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($reportPath)) { [IO.File]::Replace($temporaryPath, $reportPath, [System.Management.Automation.Language.NullString]::Value) }
  else { [IO.File]::Move($temporaryPath, $reportPath) }
}
function Assert-DesktopAudit {
  $audit = $session.Audit()
  $report['windowAudit'] = $audit
  $report.audits++
  $report.maxOwnedWindowsOnInputDesktop = [Math]::Max($report.maxOwnedWindowsOnInputDesktop, $audit.ownedWindowsOnInputDesktop)
  $report.maxOwnedWindowsOnIsolatedDesktop = [Math]::Max($report.maxOwnedWindowsOnIsolatedDesktop, $audit.ownedWindowsOnIsolatedDesktop)
  $report.checkedAt = [DateTime]::UtcNow.ToString('o')
  if (-not $audit.isolated) { throw 'Desktop isolation audit failed; stopping only this worker and its descendants.' }
}
try {
  if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -match 'CodexSandbox') {
    throw 'Use the actual Windows user; the sandbox identity cannot own this browser profile.'
  }
  if (-not [IO.Path]::IsPathRooted($NodeExe) -or [IO.Path]::GetFileName($nodePath) -ine 'node.exe' -or
      -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'An absolute installed node.exe path is required.' }
  if ($Mode -eq 'admin') {
    if (-not $AdminCommand) { throw 'AdminCommand is required in admin mode.' }
    $requiresRequestId = $AdminCommand -cin @('release-test','test-reminder','test-expire')
    if ($requiresRequestId -and $RequestId -cnotmatch '\Areq_[a-zA-Z0-9_]+\z') { throw 'This test command requires a registered req_ ID.' }
    if (-not $requiresRequestId -and $PSBoundParameters.ContainsKey('RequestId')) { throw 'RequestId is allowed only for test commands that require an ID.' }
    $report['adminCommand'] = $AdminCommand
  } elseif ($PSBoundParameters.ContainsKey('AdminCommand') -or $PSBoundParameters.ContainsKey('RequestId')) {
    throw 'Admin arguments are allowed only in admin mode.'
  }
  $entryName = if ($Mode -eq 'admin') { 'admin.mjs' } elseif ($Mode -eq 'probe') { 'probe.mjs' } else { 'main.mjs' }
  $entryPath = Join-Path $PSScriptRoot $entryName
  if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Worker entry point is unavailable.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $suffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectPath.ToLowerInvariant())))).Replace('-','').Substring(0,24) }
  finally { $sha.Dispose() }
  $mutex = [Threading.Mutex]::new($false, ('Local\NUMEMS-Agentless-Host-' + $suffix))
  try { $hasMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasMutex = $true }
  if (-not $hasMutex) { throw 'An isolated host is already running for this project.' }
  Add-Type -LiteralPath (Join-Path $PSScriptRoot 'desktop-native.cs')
  $session = [NumemsDesktop.Native]::Start($nodePath, $projectPath, $Mode, $AdminCommand, $RequestId)
  $report.state = 'running'
  $report.desktop = $session.desktopName
  $report.inputDesktop = $session.inputDesktop
  $report.processId = $session.processId
  Assert-DesktopAudit
  Save-HostReport
  $started = [DateTime]::UtcNow
  while (-not $session.Wait(1000)) {
    Assert-DesktopAudit
    if ($report.audits % 5 -eq 0) { Save-HostReport }
    $limitSeconds = if ($Mode -eq 'probe') { 300 } elseif ($Mode -eq 'once' -or $Mode -eq 'admin') { 600 } else { 0 }
    if ($limitSeconds -gt 0 -and ([DateTime]::UtcNow - $started).TotalSeconds -gt $limitSeconds) {
      throw 'Isolated worker timed out; existing action journals must be reconciled before retry.'
    }
  }
  Assert-DesktopAudit
  $resultCode = [int]$session.ExitCode()
  $report.state = if ($resultCode -eq 0) { 'exited' } else { 'blocked' }
  $report['exitCode'] = $resultCode
} catch {
  $report.state = 'blocked'
  $report['error'] = $_.Exception.Message
} finally {
  if ($null -ne $session) { $session.Dispose() }
  $report.checkedAt = [DateTime]::UtcNow.ToString('o')
  if ($hasMutex) {
    try { Save-HostReport } finally { $mutex.ReleaseMutex() }
  }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
$report | ConvertTo-Json -Compress
exit $resultCode
