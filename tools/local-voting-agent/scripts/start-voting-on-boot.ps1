$ErrorActionPreference = "Stop"
$runner = (Resolve-Path (Join-Path $PSScriptRoot "run-voting-task.ps1")).Path

$alreadyRunning = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "powershell.exe" -and $_.CommandLine -and $_.CommandLine.Contains("run-voting-task.ps1")
}

if (-not $alreadyRunning) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $runner
  ) -WindowStyle Hidden
}
