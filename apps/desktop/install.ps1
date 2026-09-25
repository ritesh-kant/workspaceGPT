# WorkspaceGPT Desktop installer (Windows).
#
#   irm https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.ps1 | iex
#
# Reads the same latest.json the in-app updater reads and downloads this PC's
# installer. It checks the installer's SHA-256 against the release's
# SHA256SUMS.txt, then runs it silently. The install is per-user, into
# %LOCALAPPDATA%\WorkspaceGPT: no admin prompt.
#
# The app is not code-signed. Invoke-WebRequest doesn't mark the download as
# coming from the internet (no Zone.Identifier), so SmartScreen doesn't stop
# the installer the way it stops a browser-downloaded one. The in-app updater
# downloads the same way afterwards.
#
# Environment: WGPT_MANIFEST_URL overrides the latest.json location (release testing).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell 5.1's progress bar makes downloads crawl
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$manifestUrl = if ($env:WGPT_MANIFEST_URL) { $env:WGPT_MANIFEST_URL } else { 'https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/latest.json' }

# throw, not exit: under `irm | iex` exit would close the user's PowerShell window.
function Fail($msg) { throw "install.ps1: $msg" }

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'this installer is for Windows; see the release page for other platforms' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'a 64-bit Windows is required' }
# Windows on Arm runs the x64 build under emulation.
$platform = 'windows-x86_64'

$manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing
$version = $manifest.version
$entry = $manifest.platforms.$platform
if (-not $entry) { Fail "no $platform build in release $version" }
$url = $entry.url
$file = Split-Path $url -Leaf
$base = $url.Substring(0, $url.LastIndexOf('/'))

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("wgpt-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading WorkspaceGPT $version for Windows..."
  $installer = Join-Path $tmp $file
  Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
  $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $expected = ($sums -split "`n" | ForEach-Object { $p = $_.Trim() -split '\s+'; if ($p.Count -ge 2 -and $p[1].TrimStart('*') -eq $file) { $p[0] } }) | Select-Object -First 1
  if (-not $expected) { Fail "$file is not listed in SHA256SUMS.txt" }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { Fail "checksum mismatch for $file (got $actual, expected $expected)" }

  if (Get-Process -Name 'WorkspaceGPT' -ErrorAction SilentlyContinue) {
    Fail 'WorkspaceGPT is running; quit it and run the installer again'
  }

  Write-Host 'Installing...'
  $p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail "the installer exited with code $($p.ExitCode)" }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$exe = Join-Path $env:LOCALAPPDATA 'WorkspaceGPT\WorkspaceGPT.exe'
if (Test-Path $exe) {
  Write-Host "Installed WorkspaceGPT $version to $(Split-Path $exe)" -ForegroundColor Green
  Write-Host 'Open it from the Start menu, or run:'
  Write-Host "  & `"$exe`""
} else {
  Write-Host "Installed WorkspaceGPT $version. Open it from the Start menu." -ForegroundColor Green
}
