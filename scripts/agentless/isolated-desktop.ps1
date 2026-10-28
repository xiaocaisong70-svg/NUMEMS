param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [ValidateSet('probe','once','run','admin')][string]$Mode = 'probe',
  [ValidateSet('status','observe','prepare-test','release-test','test-reminder','test-expire','enable-live','disable','reconcile','recover-browser','resolve-alert','resume-test-invite','review-test-workspace','review-live-workspace','review-verified-operation')][string]$AdminCommand,
  [string]$RequestId,
  [switch]$RecoverSettledLock,
  [switch]$ReviewRetry
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
. (Join-Path $PSScriptRoot 'pid-identity.ps1')
function Assert-OldPidGoneOrReused([int]$TargetProcessId, $EvidenceAt) {
  try {
    $existing = [Diagnostics.Process]::GetProcessById($TargetProcessId)
    $existing.Dispose()
  } catch [ArgumentException] { return }
  # A current unrelated process is left untouched. Both its image and creation
  # time must prove it cannot be the original Node worker, otherwise hold.
  $identity = Get-NumemsPidIdentity $TargetProcessId
  if (-not (Test-NumemsReusedIdentity $identity $TargetProcessId $EvidenceAt)) {
    throw 'Worker PID is alive or its identity cannot be safely verified; stopped.'
  }
}
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
function Restore-SettledWorkerLock {
  # Caller owns the project host mutex. Preserve the journal and every old lock.
  # This only allows the worker to reach its existing fresh-cloud preflight;
  # it does not clear a cloud fault, resume a claim or repeat an external action.
  $lockPath = Join-Path $runtimePath 'worker.lock'
  if (-not [IO.File]::Exists($lockPath)) { return }
  $original = [IO.File]::ReadAllText($lockPath)
  $lock = $original | ConvertFrom-Json
  if ($lock.pid -isnot [int] -and $lock.pid -isnot [long]) { throw 'Invalid worker lock identity; retained.' }
  if ($lock.pid -le 0 -or $lock.pid -gt [int]::MaxValue -or -not $lock.at) { throw 'Invalid worker lock identity; retained.' }
  Assert-OldPidGoneOrReused ([int]$lock.pid) $lock.at
  $journalPath = Join-Path $runtimePath 'operation.json'
  if ([IO.File]::Exists($journalPath)) {
    $journal = [IO.File]::ReadAllText($journalPath) | ConvertFrom-Json
    if ($journal.phase -cne 'settled' -or $null -ne $journal.lease -or $null -ne $journal.receipt) {
      throw 'Unfinished journal; no automatic lock recovery or member action.'
    }
  }
  if ([IO.File]::ReadAllText($lockPath) -cne $original) { throw 'Lock changed; stopped recovery.' }
  $archivePath = Join-Path $runtimePath ('worker.lock.archived-' + [Guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::Move($lockPath, $archivePath)
  $report['lockRecovery'] = @{ archivedPid=$lock.pid; journalPreserved=$true; cloudPreflightRequired=$true }
}
function Assert-WatchdogStart {
  $ticket = [IO.File]::ReadAllText((Join-Path $runtimePath 'watchdog-start.json')) | ConvertFrom-Json
  $startedAt = [DateTimeOffset]::Parse($ticket.at)
  if ($ticket.version -ne 1 -or $ticket.pid -isnot [int] -or $ticket.pid -le 0 -or
      $startedAt -gt [DateTimeOffset]::UtcNow -or ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds -gt 60) {
    throw 'Watchdog startup evidence is invalid or stale.'
  }
  $supervisor = [Diagnostics.Process]::GetProcessById($ticket.pid)
  $supervisor.Dispose()
  if ($null -ne $ticket.expectedHostPid) {
    $previousHost = [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
    if ($previousHost.processId -ne $ticket.expectedHostPid -or
        $previousHost.checkedAt -cne $ticket.expectedHostCheckedAt) {
      throw 'Previous host evidence changed after watchdog decision; stopped.'
    }
    Assert-OldPidGoneOrReused ([int]$ticket.expectedHostPid) $ticket.expectedHostCheckedAt
  }
  $stopPath = Join-Path $runtimePath 'stop-request.json'
  $digest = 'absent'
  if ([IO.File]::Exists($stopPath)) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($stopPath)))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
  }
  if ($digest -cne $ticket.stopDigest) { throw 'Stop request changed after watchdog decision; stopped before launch.' }
  if ($ReviewRetry -and ($null -eq $ticket.reviewProofDigests -or $null -eq $ticket.reviewProofDigests.retry -or $null -eq $ticket.expectedHostPid -or
      $ticket.reviewProofDigests.intent -cne 'absent' -or [IO.File]::Exists((Join-Path $runtimePath 'verified-review-intent.json')))) {
    throw 'A review retry requires bound prior host and retry evidence.'
  }
  if ($null -ne $ticket.reviewProofDigests) {
    $entries = @(@{key='status'; name='status.json'}, @{key='journal'; name='operation.json'}, @{key='admin'; name='admin-result.json'})
    if ($ReviewRetry) { $entries += @{key='retry'; name='review-retry.json'} }
    else { $entries += @{key='intent'; name='verified-review-intent.json'} }
    foreach ($entry in $entries) {
      $expected = $ticket.reviewProofDigests.($entry.key)
      $file = Join-Path $runtimePath $entry.name
      if ($expected -isnot [string] -or $expected -cnotmatch '\A[0-9a-f]{64}\z' -or -not [IO.File]::Exists($file)) {
        throw 'Review proof is missing or invalid; stopped before launch.'
      }
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actual = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($file)))).Replace('-','').ToLowerInvariant() }
      finally { $sha.Dispose() }
      if ($actual -cne $expected) { throw 'Review proof changed after watchdog decision; stopped before launch.' }
    }
  }
  if ($ReviewRetry) {
    $expectedReview = $ticket.reviewExpected
    $retryState = [IO.File]::ReadAllText((Join-Path $runtimePath 'review-retry.json')) | ConvertFrom-Json
    if ($null -eq $expectedReview -or $expectedReview.failureId -cnotmatch '\A[a-zA-Z0-9_-]{1,160}\z' -or
        $expectedReview.targetId -cnotmatch '\Areq_[a-zA-Z0-9_]{1,160}\z' -or
        $expectedReview.operationId -cnotmatch '\Aop_[a-zA-Z0-9_-]{1,160}\z' -or
        $retryState.failureId -cne $expectedReview.failureId -or $retryState.targetId -cne $expectedReview.targetId -or
        $retryState.operationId -cne $expectedReview.operationId) {
      throw 'Retry target changed after watchdog decision; stopped before launch.'
    }
    $env:NUMEMS_REVIEW_RETRY_EXPECTED = @{failureId=$expectedReview.failureId;targetId=$expectedReview.targetId;operationId=$expectedReview.operationId} | ConvertTo-Json -Compress
    $env:NUMEMS_REVIEW_STOP_DIGEST = $ticket.stopDigest
  }
  # Worker also treats any newer stop request as stopping this supervised start,
  # even if that request targeted the dead lock incarnation being recovered.
  $env:NUMEMS_WATCHDOG_START_AT = $ticket.at
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
  if ($RecoverSettledLock -and $Mode -ne 'run') { throw 'Verified dead-lock recovery is allowed only for the guarded watchdog run.' }
  if ($ReviewRetry -and ($Mode -ne 'admin' -or $AdminCommand -cne 'review-verified-operation' -or $RecoverSettledLock)) {
    throw 'Retry ticket is valid only for the read-only verified-operation review.'
  }
  if (-not $ReviewRetry) { Remove-Item Env:NUMEMS_REVIEW_RETRY_EXPECTED,Env:NUMEMS_REVIEW_STOP_DIGEST -ErrorAction SilentlyContinue }
  $entryName = if ($Mode -eq 'admin') { 'admin.mjs' } elseif ($Mode -eq 'probe') { 'probe.mjs' } else { 'main.mjs' }
  $entryPath = Join-Path $PSScriptRoot $entryName
  if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Worker entry point is unavailable.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $suffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectPath.ToLowerInvariant())))).Replace('-','').Substring(0,24) }
  finally { $sha.Dispose() }
  $mutex = [Threading.Mutex]::new($false, ('Local\NUMEMS-Agentless-Host-' + $suffix))
  try { $hasMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $hasMutex = $true }
  if (-not $hasMutex) { throw 'An isolated host is already running for this project.' }
  if ($RecoverSettledLock -or $ReviewRetry) { Assert-WatchdogStart }
  if ($RecoverSettledLock) { Restore-SettledWorkerLock }
  if ($ReviewRetry -and [IO.File]::Exists((Join-Path $runtimePath 'worker.lock'))) { throw 'Retry requires no worker lock.' }
  Add-Type -LiteralPath (Join-Path $PSScriptRoot 'desktop-native.cs')
  if ($RecoverSettledLock -or $ReviewRetry) { Assert-WatchdogStart }
  if ($ReviewRetry -and [IO.File]::Exists((Join-Path $runtimePath 'worker.lock'))) { throw 'Worker lock appeared during retry setup.' }
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
