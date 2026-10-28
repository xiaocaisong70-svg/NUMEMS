$ErrorActionPreference = 'Stop'
$tokenErrors = $null
$source = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\scripts\agentless\isolated-desktop.ps1')),[ref]$null,[ref]$tokenErrors)
if ($tokenErrors.Count) { throw 'Cannot parse native host.' }
$function = $source.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-WatchdogStart'}, $true)
if (-not $function) { throw 'Watchdog gate missing.' }
. ([scriptblock]::Create($function.Extent.Text))
function Assert-OldPidGoneOrReused([int]$TargetProcessId, $EvidenceAt) {
  if ($TargetProcessId -ne 7654321 -or -not $EvidenceAt) { throw 'unexpected fixture host' }
}
$runtimePath = Join-Path ([IO.Path]::GetTempPath()) ('numems-ticket-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($runtimePath) | Out-Null
$reportPath = Join-Path $runtimePath 'host-desktop.json'
$ReviewRetry = $true
function HashFile([string]$name) { return (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runtimePath $name)).Hash.ToLowerInvariant() }
function Save([string]$name,$value) { [IO.File]::WriteAllText((Join-Path $runtimePath $name),($value | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)) }
function MustFail([string]$label) {
  $failed=$false
  try { Assert-WatchdogStart } catch { $failed=$true }
  if (-not $failed) { throw "Expected refusal: $label" }
}
try {
  $checked='2026-10-27T12:04:50Z'
  Save 'host-desktop.json' @{processId=7654321;checkedAt=$checked}
  Save 'status.json' @{state='blocked';failureCode='browser_unavailable'}
  Save 'operation.json' @{phase='settled'}
  Save 'admin-result.json' @{success=$false}
  Save 'review-retry.json' @{version=1;failureId='failure_123';targetId='req_123';operationId='op_123';attempts=1}
  $ticket=@{version=1;pid=$PID;at=[DateTime]::UtcNow.ToString('o');stopDigest='absent';expectedHostPid=7654321;expectedHostCheckedAt=$checked;
    reviewExpected=@{failureId='failure_123';targetId='req_123';operationId='op_123'};
    reviewProofDigests=@{status=(HashFile 'status.json');journal=(HashFile 'operation.json');admin=(HashFile 'admin-result.json');retry=(HashFile 'review-retry.json');intent='absent'}}
  Save 'watchdog-start.json' $ticket
  Assert-WatchdogStart
  $passed=$env:NUMEMS_REVIEW_RETRY_EXPECTED | ConvertFrom-Json
  if ($passed.failureId -cne 'failure_123' -or $passed.targetId -cne 'req_123' -or $passed.operationId -cne 'op_123' -or $env:NUMEMS_REVIEW_STOP_DIGEST -cne 'absent') { throw 'Child binding failed.' }
  $ticket.reviewExpected.operationId='op_other';Save 'watchdog-start.json' $ticket;MustFail 'changed tuple'
  $ticket.reviewExpected.operationId='op_123';Save 'watchdog-start.json' $ticket
  Save 'verified-review-intent.json' @{phase='submitted'};MustFail 'intent appeared';Remove-Item -LiteralPath (Join-Path $runtimePath 'verified-review-intent.json')
  Save 'stop-request.json' @{version=1};MustFail 'stop appeared';Remove-Item -LiteralPath (Join-Path $runtimePath 'stop-request.json')
  Save 'status.json' @{state='other'};MustFail 'status changed'
  'Native ticket safety checks: PASS'
} finally {
  Remove-Item Env:NUMEMS_REVIEW_RETRY_EXPECTED,Env:NUMEMS_REVIEW_STOP_DIGEST,Env:NUMEMS_WATCHDOG_START_AT -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $runtimePath -File | Remove-Item
  Remove-Item -LiteralPath $runtimePath
}
