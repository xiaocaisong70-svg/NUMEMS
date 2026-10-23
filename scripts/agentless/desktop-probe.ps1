$ErrorActionPreference = 'Stop'
try {
  if (-not ('NumemsDesktop.Native' -as [type])) {
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'desktop-native.cs')
  }
  [NumemsDesktop.Native]::Probe() | ConvertTo-Json -Compress
} catch {
  # The caller must reject failure before launching any headed browser.
  [pscustomobject]@{ desktop=$null; inputDesktop=$null; windowStation=$null; isolated=$false; error='desktop_isolation_unverified' } | ConvertTo-Json -Compress
  exit 1
}
