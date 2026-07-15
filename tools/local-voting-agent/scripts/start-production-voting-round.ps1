[CmdletBinding()]
param(
  [ValidateRange(2, 3)]
  [int]$CandidateCount = 3,
  [ValidateRange(30, 600)]
  [int]$StartupTimeoutSeconds = 180,
  [switch]$RestartAgent,
  [string]$TaskName = 'RadioTEDU Voting Radio',
  [string]$AgentBaseUrl = 'http://127.0.0.1:4317',
  [string]$ProductionVotingBaseUrl = 'https://radiotedu.com/jukebox/api/v1/next-song-voting'
)

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VotingGet {
  param([Parameter(Mandatory = $true)][string]$Uri)
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 20
    } catch {
      if ($attempt -eq 4) { throw }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

function Get-ProductionRound {
  $response = Invoke-VotingGet -Uri "$ProductionVotingBaseUrl/rounds/active"
  $response.data.round
}

function Write-Summary {
  param(
    [Parameter(Mandatory = $true)][string]$Result,
    [Parameter(Mandatory = $true)]$Round,
    [Parameter(Mandatory = $true)][bool]$AgentConnected,
    [Parameter(Mandatory = $true)][string]$PlaybackState
  )
  [pscustomobject]@{
    result = $Result
    roundId = $Round.id
    roundStatus = $Round.status
    candidateCount = @($Round.candidates).Count
    lockAt = $Round.lockAt
    agentConnected = $AgentConnected
    playbackState = $PlaybackState
    votePage = 'https://radiotedu.com/vote/'
  } | ConvertTo-Json -Depth 5
}

if ($RestartAgent) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($agentRoot) -and
    ($_.Name -eq 'node.exe' -or $_.Name -eq 'powershell.exe')
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$existingRound = Get-ProductionRound
if ($existingRound -and $existingRound.status -eq 'open') {
  $status = Invoke-VotingGet -Uri "$ProductionVotingBaseUrl/status"
  if (-not $RestartAgent -and $status.data.agent.connected -eq $true) {
    try {
      $existingHealth = Invoke-VotingGet -Uri "$AgentBaseUrl/api/health"
      if ($existingHealth.backendConnection -eq 'connected' -and $existingHealth.playbackState -eq 'playing') {
        Write-Summary -Result 'already_running' -Round $existingRound -AgentConnected $true -PlaybackState $existingHealth.playbackState
        exit 0
      }
    } catch {}
  }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { throw "Scheduled task '$TaskName' is missing. Run scripts/install-voting-startup.ps1 first." }
if ($RestartAgent -or $task.State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName }

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$health = $null
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-VotingGet -Uri "$AgentBaseUrl/api/health"
    if ($health.backendConnection -eq 'connected' -and $health.playbackState -eq 'playing') { break }
  } catch { $health = $null }
  Start-Sleep -Seconds 3
}
if (-not $health -or $health.backendConnection -ne 'connected' -or $health.playbackState -ne 'playing') {
  $backend = if ($health) { $health.backendConnection } else { 'unreachable' }
  $playback = if ($health) { $health.playbackState } else { 'unreachable' }
  throw "Voting agent did not become ready: backend=$backend playback=$playback"
}

if ($existingRound -and $existingRound.status -eq 'open') {
  $recoveryDeadline = (Get-Date).AddSeconds(60)
  $confirmedRound = $null
  $confirmedStatus = $null
  while ((Get-Date) -lt $recoveryDeadline) {
    try {
      $confirmedRound = Get-ProductionRound
      $confirmedStatus = Invoke-VotingGet -Uri "$ProductionVotingBaseUrl/status"
      if ($confirmedRound -and $confirmedRound.id -eq $existingRound.id -and $confirmedStatus.data.agent.connected -eq $true) { break }
    } catch {}
    Start-Sleep -Seconds 3
  }
  if (-not $confirmedRound -or $confirmedRound.id -ne $existingRound.id -or $confirmedStatus.data.agent.connected -ne $true) {
    throw "Existing production round $($existingRound.id) could not be recovered with a connected agent."
  }
  Write-Summary -Result 'recovered_existing' -Round $confirmedRound -AgentConnected $true -PlaybackState $health.playbackState
  exit 0
}

$created = $null
for ($startAttempt = 1; $startAttempt -le 3; $startAttempt++) {
  $created = Invoke-RestMethod -Uri "$AgentBaseUrl/api/rounds/start" -Method Post -ContentType 'application/json' `
    -Body (@{ candidateCount = $CandidateCount } | ConvertTo-Json -Compress) -TimeoutSec 35
  if ($created.round -and $created.round.status -eq 'open') { break }
  Start-Sleep -Seconds 2
}
if ($created.backendSyncError) { throw "Backend rejected the round: $($created.backendSyncError)" }
if (-not $created.round -or $created.round.status -ne 'open') { throw 'The local agent did not create an open voting round.' }

$verificationDeadline = (Get-Date).AddSeconds(45)
$productionRound = $null
while ((Get-Date) -lt $verificationDeadline) {
  $productionRound = Get-ProductionRound
  if ($productionRound -and $productionRound.id -eq $created.round.id -and $productionRound.status -eq 'open') { break }
  Start-Sleep -Seconds 2
}
if (-not $productionRound -or $productionRound.id -ne $created.round.id -or $productionRound.status -ne 'open') {
  throw "Production did not expose round $($created.round.id)."
}
Write-Summary -Result 'started' -Round $productionRound -AgentConnected $true -PlaybackState $health.playbackState
