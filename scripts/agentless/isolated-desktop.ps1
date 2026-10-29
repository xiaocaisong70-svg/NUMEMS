param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [ValidateSet('probe','once','run','admin')][string]$Mode = 'probe',
  [ValidateSet('status','observe','prepare-test','release-test','test-reminder','test-expire','enable-live','disable','reconcile','recover-browser','resolve-alert','resume-test-invite','review-test-workspace','review-live-workspace','review-verified-operation','rollback-status','prepare-v11-rollback','prepare-v13-rollback','prepare-fault-rescue','finish-fault-rescue')][string]$AdminCommand,
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
function Test-FaultRescueTerminalProof($Proof, $Rescue) {
  # Native restart independently checks the same persisted data-only contract
  # as fault-rescue-proof.mjs; interrupted/failed without a completion timestamp
  # is never treated as an ended desktop model turn.
  if ($null -eq $Proof -or $Proof.kind -cne 'codex_turn_state' -or $Proof.source -cne 'app_server_thread_read' -or
      $Proof.confirmed -isnot [bool] -or $Proof.stopped -isnot [bool] -or $Proof.confirmed -ne $true -or $Proof.stopped -ne $true -or $Proof.terminalEvidence -cne 'status_and_completed_at' -or
      $Proof.threadId -cne $Rescue.threadId -or $Proof.clientUserMessageId -cne $Rescue.clientId -or
      ($Rescue.queuedId -and $Proof.queuedId -cne $Rescue.queuedId) -or
      $Proof.turnId -isnot [string] -or $Proof.linkedTurnId -isnot [string] -or
      $Proof.turnId -cnotmatch '\A[a-zA-Z0-9:_-]{1,240}\z' -or $Proof.linkedTurnId -cnotmatch '\A[a-zA-Z0-9:_-]{1,240}\z' -or
      $Proof.terminalChain -isnot [Array] -or $Proof.terminalFamily -isnot [Array] -or
      ($Proof.readMethod -ceq 'thread/turns/list' -and ($Proof.headRevalidated -isnot [bool] -or $Proof.headRevalidated -ne $true))) { return $false }
  $observed = [DateTimeOffset]::MinValue
  if ($Proof.observedAt -isnot [string] -or -not [DateTimeOffset]::TryParse($Proof.observedAt, [ref]$observed) -or $observed -gt [DateTimeOffset]::UtcNow) { return $false }
  $chain = @($Proof.terminalChain); $family = @($Proof.terminalFamily)
  if ($chain.Count -lt 1 -or $chain.Count -gt 9 -or $family.Count -lt $chain.Count -or $family.Count -gt 1000 -or
      $chain[0].turnId -cne $Proof.linkedTurnId -or $chain[-1].turnId -cne $Proof.turnId) { return $false }
  $familyById = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  foreach ($node in $family) {
    $started = [DateTimeOffset]::MinValue; $completed = [DateTimeOffset]::MinValue
    if ($null -eq $node -or $node.turnId -isnot [string] -or $node.turnId -cnotmatch '\A[a-zA-Z0-9:_-]{1,240}\z' -or $familyById.ContainsKey($node.turnId) -or
        $node.ended -isnot [bool] -or $node.ended -ne $true -or @('completed','failed','interrupted') -cnotcontains $node.status -or
        $node.startedAt -isnot [string] -or $node.completedAt -isnot [string] -or
        -not [DateTimeOffset]::TryParse($node.startedAt,[ref]$started) -or -not [DateTimeOffset]::TryParse($node.completedAt,[ref]$completed) -or
        $completed -lt $started -or $completed -gt $observed) { return $false }
    $familyById.Add($node.turnId,$node)
  }
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($node in $chain) {
    if ($null -eq $node -or $node.turnId -isnot [string] -or $node.ended -isnot [bool] -or
        -not $seen.Add([string]$node.turnId) -or -not $familyById.ContainsKey([string]$node.turnId)) { return $false }
    $matched = $familyById[[string]$node.turnId]
    foreach ($name in @('status','startedAt','completedAt','ended')) { if ($node.$name -cne $matched.$name) { return $false } }
  }
  $last = $chain[-1]
  return $Proof.status -ceq $last.status -and $Proof.startedAt -ceq $last.startedAt -and $Proof.completedAt -ceq $last.completedAt
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
    if ($journal.phase -cne 'settled' -or $null -ne $journal.lease -or $null -ne $journal.receipt -or $null -ne $journal.submission) {
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
  if ($ticket.reason -ceq 'fault_rescue_verified_start_candidate') {
    $expectedRescue = $ticket.faultRescueExpected
    if ($Mode -cne 'run' -or $null -eq $ticket.expectedHostPid -or $null -eq $expectedRescue -or
        $expectedRescue.rescueId -cnotmatch '\Arescue_[a-zA-Z0-9_-]{16,100}\z' -or
        $expectedRescue.failureId -cnotmatch '\A[a-zA-Z0-9:_-]{1,240}\z') {
      throw 'Fault rescue start requires the exact previous isolated host and ticket.'
    }
    $entries = @(@{key='rescue'; name='fault-rescue.json'}, @{key='status'; name='status.json'},
      @{key='journal'; name='operation.json'}, @{key='admin'; name='admin-result.json'})
    foreach ($entry in $entries) {
      $expected = $ticket.faultRescueProofDigests.($entry.key)
      $file = Join-Path $runtimePath $entry.name
      if ($expected -isnot [string] -or $expected -cnotmatch '\A[0-9a-f]{64}\z' -or -not [IO.File]::Exists($file)) {
        throw 'Fault rescue proof missing; stopped before launch.'
      }
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actual = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($file)))).Replace('-','').ToLowerInvariant() }
      finally { $sha.Dispose() }
      if ($actual -cne $expected) { throw 'Fault rescue proof changed; stopped before launch.' }
    }
    $rescue = [IO.File]::ReadAllText((Join-Path $runtimePath 'fault-rescue.json')) | ConvertFrom-Json
    $status = [IO.File]::ReadAllText((Join-Path $runtimePath 'status.json')) | ConvertFrom-Json
    $journal = [IO.File]::ReadAllText((Join-Path $runtimePath 'operation.json')) | ConvertFrom-Json
    $admin = [IO.File]::ReadAllText((Join-Path $runtimePath 'admin-result.json')) | ConvertFrom-Json
    $terminalProof = $rescue.agentProof
    if ($rescue.PSObject.Properties.Name -ccontains 'terminalRevalidationProof') { $terminalProof = $rescue.terminalRevalidationProof }
    if ($rescue.phase -cne 'finished' -or $rescue.outcome -cne 'recovered' -or $rescue.agentStopped -ne $true -or
        $rescue.ticket.id -cne $expectedRescue.rescueId -or $rescue.failureId -cne $expectedRescue.failureId -or
        -not (Test-FaultRescueTerminalProof $terminalProof $rescue) -or
        $journal.phase -cne 'settled' -or $null -ne $journal.lease -or $null -ne $journal.receipt -or $null -ne $journal.submission -or
        $admin.command -cne 'finish-fault-rescue' -or $admin.requestId -cne $expectedRescue.rescueId -or $admin.success -ne $true -or
        $status.faultRescueEvidence.rescueId -cne $expectedRescue.rescueId -or
        $status.faultRescueEvidence.failureId -cne $expectedRescue.failureId -or $status.mode -cne 'idle' -or
        $status.state -ceq 'blocked' -or $status.error -or $status.failureCode) {
      throw 'Fault rescue result does not authorize a worker restart.'
    }
  } elseif ($null -ne $ticket.faultRescueProofDigests -or $null -ne $ticket.faultRescueExpected) {
    throw 'Fault rescue proof cannot be used for another startup reason.'
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
    $requiresRequestId = $AdminCommand -cin @('release-test','test-reminder','test-expire','prepare-v11-rollback','prepare-v13-rollback','finish-fault-rescue')
    if ($AdminCommand -cin @('prepare-v11-rollback','prepare-v13-rollback')) {
      if ($RequestId -cnotmatch '\A\d{1,15}\z') { throw 'Rollback requires a current numeric D1 revision.' }
    } elseif ($AdminCommand -ceq 'finish-fault-rescue') {
      if ($RequestId -cnotmatch '\Arescue_[a-zA-Z0-9_-]{16,100}\z') { throw 'An existing rescue ticket ID is required.' }
    } elseif ($requiresRequestId -and $RequestId -cnotmatch '\Areq_[a-zA-Z0-9_]+\z') { throw 'This test command requires a registered req_ ID.' }
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
