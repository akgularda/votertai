param(
  [string]$JukeEnv = "C:\Users\tedu\Desktop\juke-local\media-agent\.env",
  [string]$VotingEnv = (Join-Path $PSScriptRoot "..\.env"),
  [string]$MusicLibrary = "C:\Users\tedu\Downloads\song",
  [switch]$SkipJukeRestart
)

$ErrorActionPreference = "Stop"

function Read-EnvMap([string]$Path) {
  $map = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) { continue }
    $index = $trimmed.IndexOf("=")
    $map[$trimmed.Substring(0, $index).Trim()] = $trimmed.Substring($index + 1).Trim().Trim('"')
  }
  return $map
}

function Set-EnvKey([string[]]$Lines, [string]$Key, [string]$Value) {
  $found = $false
  $updated = foreach ($line in $Lines) {
    if ($line -match "^\s*$([regex]::Escape($Key))=") {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) { $updated += "$Key=$Value" }
  return [string[]]$updated
}

if (-not (Test-Path -LiteralPath $JukeEnv)) { throw "Juke Local environment file was not found." }
$juke = Read-EnvMap $JukeEnv
if (-not $juke.ContainsKey("AI_ICECAST_SOURCE_USER") -or -not $juke.ContainsKey("AI_ICECAST_SOURCE_PASSWORD")) {
  throw "Existing /ai source credentials were not found."
}
$ffmpegPath = if ($juke.ContainsKey("AI_MIRROR_FFMPEG_PATH") -and $juke["AI_MIRROR_FFMPEG_PATH"]) {
  $juke["AI_MIRROR_FFMPEG_PATH"]
} else {
  "ffmpeg"
}
$ffprobePath = if ($ffmpegPath -ne "ffmpeg") {
  Join-Path (Split-Path -Parent $ffmpegPath) "ffprobe.exe"
} else {
  "ffprobe"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -LiteralPath $JukeEnv -Destination "$JukeEnv.before-voting-$stamp.bak" -Force
$jukeLines = [IO.File]::ReadAllLines($JukeEnv)
$jukeLines = Set-EnvKey $jukeLines "AI_MIRROR_ENABLED" "false"
$jukeLines = Set-EnvKey $jukeLines "AI_AUTOPLAY_ENABLED" "false"
[IO.File]::WriteAllLines($JukeEnv, $jukeLines, [Text.UTF8Encoding]::new($false))

if (Test-Path -LiteralPath $VotingEnv) {
  Copy-Item -LiteralPath $VotingEnv -Destination "$VotingEnv.before-ai-claim-$stamp.bak" -Force
}
$votingLines = @(
  "MUSIC_LIBRARY_DIR=$MusicLibrary",
  "MUSIC_LIBRARY_REFRESH_SECONDS=60",
  "JINGLE_LIBRARY_DIR=",
  "ALBUM_ART_CACHE_DIR=var/album-art",
  "CANDIDATE_COUNT=3",
  "VOTING_OPEN_BEFORE_END_SECONDS=86400",
  "VOTING_LOCK_BEFORE_END_SECONDS=10",
  "VOTING_AUTOMATION_TICK_SECONDS=1",
  "VOTING_RECENT_TRACK_LIMIT=8",
  "VOTING_AGENT_PLAYBACK_MODE=live",
  "FFMPEG_PATH=$ffmpegPath",
  "FFPROBE_PATH=$ffprobePath",
  "PORT=4317",
  "ICECAST_STREAM_ENABLED=true",
  "ICECAST_SOURCE_URL=http://stream.radiotedu.com/ai",
  "ICECAST_SOURCE_USERNAME=$($juke['AI_ICECAST_SOURCE_USER'])",
  "ICECAST_SOURCE_PASSWORD=$($juke['AI_ICECAST_SOURCE_PASSWORD'])",
  "ICECAST_BITRATE_KBPS=192",
  "ICECAST_STREAM_NAME=RadioTEDU Voting",
  "ICECAST_STREAM_GENRE=RadioTEDU",
  "ICECAST_STREAM_DESCRIPTION=RadioTEDU listener-controlled radio",
  "BACKEND_SYNC_ENABLED=true",
  "RADIO_AGENT_TRANSPORT=websocket",
  "RADIO_AGENT_CONNECT_URL=wss://radiotedu.com/jukebox/api/v1/next-song-voting/agent/connect",
  "RADIO_AGENT_ID=school-radio-pc",
  "RADIO_AGENT_REQUEST_SECRET=",
  "RADIO_AGENT_RECONNECT_MS=5000"
)
$votingEnvPath = [IO.Path]::GetFullPath($VotingEnv)
[IO.File]::WriteAllLines($votingEnvPath, $votingLines, [Text.UTF8Encoding]::new($false))

if (-not $SkipJukeRestart) {
  try { Stop-ScheduledTask -TaskName "Juke Local Media Agent" -ErrorAction SilentlyContinue } catch {}
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -and
    $_.CommandLine.Contains("juke-local\media-agent") -and $_.CommandLine.Contains("server.js")
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $listener = Get-NetTCPConnection -State Listen -LocalPort 3210 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "node") {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
  Start-ScheduledTask -TaskName "Juke Local Media Agent"
}

Write-Output "The /ai mount is assigned to Voting. Juke Local AI mirror/autoplay is disabled; secrets were not printed."
