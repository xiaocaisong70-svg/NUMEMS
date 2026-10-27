param([int]$ProcessId = 0)

# Query read-only OS metadata. Missing/inaccessible data is never proof of death.
function Get-NumemsPidIdentity([int]$TargetProcessId) {
  if ($TargetProcessId -le 0) { return $null }
  try {
    $record = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $TargetProcessId" -ErrorAction Stop
    if ($null -eq $record -or $record.ProcessId -ne $TargetProcessId -or
        $record.Name -isnot [string] -or -not $record.CreationDate) { return $null }
    return @{ pid=[int]$record.ProcessId; imageName=$record.Name;
      createdAt=([DateTimeOffset]$record.CreationDate).ToUniversalTime().ToString('o') }
  } catch { return $null }
}

function Test-NumemsReusedIdentity($Identity, [int]$TargetProcessId, $EvidenceAt) {
  $expectedTime = [DateTimeOffset]::MinValue
  $createdTime = [DateTimeOffset]::MinValue
  if ($null -eq $Identity -or $Identity.pid -ne $TargetProcessId -or
      $Identity.imageName -isnot [string] -or $Identity.imageName -notmatch '^[a-zA-Z0-9_.-]+\.exe$' -or
      $Identity.imageName -ieq 'node.exe' -or $EvidenceAt -isnot [string] -or
      $EvidenceAt -notmatch '(Z|[+-]\d{2}:\d{2})$' -or
      -not [DateTimeOffset]::TryParse($EvidenceAt, [ref]$expectedTime) -or
      $Identity.createdAt -isnot [string] -or
      $Identity.createdAt -notmatch '(Z|[+-]\d{2}:\d{2})$' -or
      -not [DateTimeOffset]::TryParse($Identity.createdAt, [ref]$createdTime)) { return $false }
  # A margin protects against coarse timestamp rounding; same-image processes stay held.
  return $createdTime -gt $expectedTime.AddSeconds(2) -and $createdTime -le [DateTimeOffset]::UtcNow
}

if ($PSBoundParameters.ContainsKey('ProcessId')) {
  $identity = Get-NumemsPidIdentity $ProcessId
  if ($null -eq $identity) { 'null' } else { $identity | ConvertTo-Json -Compress }
}
