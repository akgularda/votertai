param(
  [string]$TaskName = "RadioTEDU Voting Radio"
)

$ErrorActionPreference = "Stop"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $workDir "runtime-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$node = (Get-Command node.exe).Source
$server = Join-Path $workDir "dist-server\index.mjs"
$envFile = Join-Path $workDir ".env"
$supervisor = Join-Path $PSScriptRoot "voting-supervisor.mjs"
if (-not (Test-Path -LiteralPath $server)) { throw "Run npm run build before installing the task." }
if (-not (Test-Path -LiteralPath $envFile)) { throw "Create .env before installing the task." }
$arguments = "--env-file=`"$envFile`" `"$supervisor`""
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $workDir
$userId = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
$supervisorLock = Join-Path $workDir "var\voting-supervisor.pid"
if (Test-Path -LiteralPath $supervisorLock) {
  $supervisorPid = 0
  if ([int]::TryParse(([IO.File]::ReadAllText($supervisorLock).Trim()), [ref]$supervisorPid) -and $supervisorPid -gt 0) {
    Stop-Process -Id $supervisorPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $supervisorLock -Force -ErrorAction SilentlyContinue
}
$listener = Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq "node") {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Voting radio startup task is installed."
