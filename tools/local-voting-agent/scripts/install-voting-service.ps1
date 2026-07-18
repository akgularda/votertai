param(
  [string]$AgentRoot = "",
  [switch]$KeepStartupFallback
)

$ErrorActionPreference = "Stop"
$serviceName = "RadioTEDUVotingRadio"
$scriptDir = (Resolve-Path $PSScriptRoot).Path
$serviceScript = Join-Path $scriptDir "voting_windows_service.py"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  throw @"
Installing the boot-start Voting service requires an elevated PowerShell window.
Run:
  powershell -ExecutionPolicy Bypass -File "$PSCommandPath" -AgentRoot "<agent-root>"
The existing sign-in launcher was not removed.
"@
}

if (-not $AgentRoot) {
  $AgentRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
  $AgentRoot = (Resolve-Path $AgentRoot).Path
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$python = (Get-Command python.exe -ErrorAction Stop).Source
$envFile = Join-Path $AgentRoot ".env"
$supervisor = Join-Path $AgentRoot "scripts\voting-supervisor.mjs"
$pywin32 = & $python -c "import pathlib, win32serviceutil; print(pathlib.Path(win32serviceutil.__file__).resolve().parents[2])"
if ($LASTEXITCODE -ne 0 -or -not $pywin32) {
  throw "Python pywin32 is required to install the Windows service."
}
$pywin32 = $pywin32.Trim()

foreach ($required in @($serviceScript, $envFile, $supervisor, $node, $python)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required Voting runtime path is missing: $required"
  }
}

$configDir = Join-Path $env:ProgramData "RadioTEDU Voting"
$configPath = Join-Path $configDir "service.json"
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$config = [ordered]@{
  agentRoot = $AgentRoot
  nodeExe = $node
  envFile = $envFile
  supervisorScript = $supervisor
  pywin32SitePackages = $pywin32
}
$configJson = $config | ConvertTo-Json
[IO.File]::WriteAllText($configPath, $configJson, [Text.UTF8Encoding]::new($false))

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
  & $python $serviceScript --startup auto update
} else {
  & $python $serviceScript --startup auto install
}
if ($LASTEXITCODE -ne 0) {
  throw "The Voting Windows service could not be registered."
}

& sc.exe config $serviceName start= auto | Out-Null
& sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
& sc.exe failureflag $serviceName 1 | Out-Null
& sc.exe description $serviceName "Starts and supervises the RadioTEDU Voting player, backend WSS agent, and continuous /ai source." | Out-Null

$serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName"
Set-ItemProperty -Path $serviceKey -Name DelayedAutostart -Type DWord -Value 0

if ($existing -and (Get-Service -Name $serviceName).Status -eq "Running") {
  Restart-Service -Name $serviceName -Force
} elseif ((Get-Service -Name $serviceName).Status -ne "Running") {
  Start-Service -Name $serviceName
}

$deadline = (Get-Date).AddSeconds(45)
do {
  Start-Sleep -Seconds 2
  $service = Get-Service -Name $serviceName
  $healthy = $false
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4317/api/health" -TimeoutSec 4
    $healthy = $health.ok -eq $true -and $health.playbackState -eq "playing"
  } catch {}
} until (($service.Status -eq "Running" -and $healthy) -or (Get-Date) -ge $deadline)

if ($service.Status -ne "Running" -or -not $healthy) {
  throw "The service was registered, but Voting did not become healthy within 45 seconds. Check runtime-logs\voting-windows-service.log."
}

if (-not $KeepStartupFallback) {
  $startupLauncher = Join-Path ([Environment]::GetFolderPath("Startup")) "RadioTEDU Voting Radio.cmd"
  if (Test-Path -LiteralPath $startupLauncher) {
    Remove-Item -LiteralPath $startupLauncher -Force
  }
  if (Get-ScheduledTask -TaskName "RadioTEDU Voting Radio" -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName "RadioTEDU Voting Radio" -Confirm:$false
  }
}

Write-Output "RadioTEDU Voting is installed as an automatic Windows service."
Write-Output "Service: $serviceName"
Write-Output "State: $((Get-Service -Name $serviceName).Status)"
Write-Output "Agent health: playing"
