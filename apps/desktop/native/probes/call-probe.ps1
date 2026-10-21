# Probe: can we tell that the user is in a call (Teams, Zoom, Meet, in an app,
# a browser tab or a web app), even muted with the camera off?
# See docs/design/call-notes.md, "Detection".
#
# Rule (Windows probe): an app holding the microphone for 10 s or more is a call.
# The app is not identified as Teams or Zoom on purpose: the prompt always says
# "Call detected". The real helper will also require that the same process has
# an active audio OUTPUT session (WASAPI session enumeration, native code), as
# macOS does. PowerShell can't see that, so this probe checks the mic only.
#
# Windows records which app is using the microphone (it drives the taskbar
# "X is using your microphone" icon) in the user's own registry:
#   HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
# Packaged apps (e.g. new Teams, MSIX "MSTeams_8wekyb3d8bbwe") are direct
# subkeys; desktop apps (zoom.exe, chrome.exe, ...) are under NonPackaged, named
# by exe path with '#' for '\'. An app is using the mic right now when
# LastUsedTimeStart is set and LastUsedTimeStop is 0.
#
# Reads the registry only: no admin rights, records nothing.
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\native\probes\call-probe.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\native\probes\call-probe.ps1 -Seconds 60

param([int]$Seconds = [int]::MaxValue)

$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore'
$pollSeconds = 3
$confirmSeconds = 10
# Apps that hold the mic but are never a call (add WorkspaceGPT's own dictation helper once it exists on Windows).
$ignored = @()

# Apps using $capability right now: @{ Name; Since }.
function Get-ActiveUsers([string]$capability) {
  $base = Join-Path $root $capability
  if (-not (Test-Path $base)) { return @() }
  $keys = @(Get-ChildItem $base -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -ne 'NonPackaged' })
  $nonPackaged = Join-Path $base 'NonPackaged'
  if (Test-Path $nonPackaged) { $keys += @(Get-ChildItem $nonPackaged -ErrorAction SilentlyContinue) }
  foreach ($key in $keys) {
    $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $p) { continue }
    $start = [int64]($p.LastUsedTimeStart)
    $stop = [int64]($p.LastUsedTimeStop)
    if ($start -ne 0 -and $stop -eq 0) {
      [pscustomobject]@{ Name = ($key.PSChildName -replace '#', '\'); Since = [DateTime]::FromFileTime($start) }
    }
  }
}

$started = Get-Date
Write-Host "Call probe: polling every $pollSeconds s, a call needs $confirmSeconds s. Ctrl-C to stop.`n"

while (((Get-Date) - $started).TotalSeconds -lt $Seconds) {
  $now = Get-Date
  $mic = @(Get-ActiveUsers 'microphone' | Where-Object { $ignored -notcontains (Split-Path $_.Name -Leaf) })
  $confirmed = @($mic | Where-Object { ($now - $_.Since).TotalSeconds -ge $confirmSeconds })
  $verdict = if ($confirmed.Count) { '=> CALL detected (' + (($confirmed | ForEach-Object { Split-Path $_.Name -Leaf }) -join ', ') + ')' }
             elseif ($mic.Count) { '=> possible call, confirming...' }
             else { '=> no call' }
  Write-Host ("{0}  {1}" -f ($now.ToString('HH:mm:ss')), $verdict)
  foreach ($u in $mic) { Write-Host ("      MIC  {0}  (since {1:HH:mm:ss})" -f $u.Name, $u.Since) }
  Start-Sleep -Seconds $pollSeconds
}
