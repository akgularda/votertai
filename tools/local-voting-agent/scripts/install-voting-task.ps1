param(
  [string]$TaskName = "RadioTEDU Voting Radio"
)

$ErrorActionPreference = "Stop"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $workDir "runtime-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "voting-radio.out.log"
$errLog = Join-Path $logDir "voting-radio.err.log"
$node = (Get-Command node.exe).Source
$tsx = Join-Path $workDir "node_modules\tsx\dist\cli.mjs"
$server = Join-Path $workDir "src\server\index.ts"
$envFile = Join-Path $workDir ".env"
if (-not (Test-Path -LiteralPath $tsx)) { throw "Run npm ci before installing the task." }
if (-not (Test-Path -LiteralPath $envFile)) { throw "Create .env before installing the task." }
$runner = Join-Path $PSScriptRoot "run-voting-task.ps1"
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
$listener = Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq "node") {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
} catch [Microsoft.Management.Infrastructure.CimException] {
  $userId = "$env:USERDOMAIN\$env:USERNAME"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
}
Start-ScheduledTask -TaskName $TaskName
Write-Output "Voting radio startup task is installed."
