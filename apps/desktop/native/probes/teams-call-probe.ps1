# Probe: can we tell that the user is in a Teams call, even muted with the camera off?
# See docs/design/call-notes.md, "Validate first".
#
# Windows records which app is using the microphone and camera (it drives the
# taskbar "X is using your microphone" icon) in the user's own registry:
#   HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\<microphone|webcam>
# Packaged apps (new Teams is MSIX "MSTeams_8wekyb3d8bbwe") are direct subkeys;
# desktop apps are under NonPackaged, named by exe path with '#' for '\'.
# An app is using the device right now when LastUsedTimeStart is set and
# LastUsedTimeStop is 0.
#
# Prints every 3 s every app currently using the mic or camera (Teams-family
# marked with *), and whether a Teams process is running. Reads the registry
# only: no admin rights, records nothing.
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\native\probes\teams-call-probe.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\native\probes\teams-call-probe.ps1 -Seconds 60
#
# Test plan: start it, join a Teams call, mute and turn the camera off, wait a
# minute, unmute, leave the call. Lines with "=> CALL" should match the time you
# were in the call, including the muted part. Note which entry holds the mic:
# the MSTeams package, or msedgewebview2.exe under NonPackaged.

param([int]$Seconds = [int]::MaxValue)

$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore'

function Test-Teams([string]$name) {
  return ($name -match '(?i)teams') -or ($name -match '(?i)msedgewebview2')
}

# Apps using $capability right now: @{ Name; Teams }.
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
      $name = $key.PSChildName -replace '#', '\'
      [pscustomobject]@{ Name = $name; Teams = (Test-Teams $name); Since = [DateTime]::FromFileTime($start) }
    }
  }
}

$teamsProcessNames = @('ms-teams', 'MSTeams', 'Teams')
$started = Get-Date
Write-Host "Teams call probe: polling every 3 s. Ctrl-C to stop.`n"

while (((Get-Date) - $started).TotalSeconds -lt $Seconds) {
  $teamsRunning = [bool](Get-Process -Name $teamsProcessNames -ErrorAction SilentlyContinue)
  $mic = @(Get-ActiveUsers 'microphone')
  $cam = @(Get-ActiveUsers 'webcam')
  $teamsMic = [bool]($mic | Where-Object { $_.Teams -and $_.Name -match '(?i)teams' })
  $webviewMic = [bool]($mic | Where-Object { $_.Name -match '(?i)msedgewebview2' })
  $verdict = if ($teamsMic) { '=> CALL (Teams holds the mic)' }
             elseif ($teamsRunning -and $webviewMic) { '=> maybe (a WebView2 process holds the mic while Teams runs)' }
             else { '=> no call' }

  Write-Host ("{0}  teams running: {1}  {2}" -f (Get-Date -Format 'HH:mm:ss'), ($(if ($teamsRunning) { 'yes' } else { 'no' })), $verdict)
  foreach ($u in $mic) { Write-Host ("    {0} MIC  {1}  (since {2:HH:mm:ss})" -f ($(if ($u.Teams) { '*' } else { ' ' })), $u.Name, $u.Since) }
  foreach ($u in $cam) { Write-Host ("    {0} CAM  {1}  (since {2:HH:mm:ss})" -f ($(if ($u.Teams) { '*' } else { ' ' })), $u.Name, $u.Since) }
  Start-Sleep -Seconds 3
}
