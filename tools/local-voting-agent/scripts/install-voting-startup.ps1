$ErrorActionPreference = "Stop"
$runner = (Resolve-Path (Join-Path $PSScriptRoot "run-voting-task.ps1")).Path
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "RadioTEDU Voting Radio.cmd"
$lines = @(
  "@echo off",
  "start `"RadioTEDU Voting Radio`" /min powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
)
[IO.File]::WriteAllLines($launcher, $lines, [Text.ASCIIEncoding]::new())

if (Get-ScheduledTask -TaskName "RadioTEDU Voting Radio" -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName "RadioTEDU Voting Radio" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "RadioTEDU Voting Radio" -Confirm:$false -ErrorAction SilentlyContinue
}

$alreadyRunning = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "powershell.exe" -and $_.CommandLine -and $_.CommandLine.Contains("run-voting-task.ps1")
}
if (-not $alreadyRunning) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $runner
  ) -WindowStyle Hidden
}
Write-Output "Voting radio Startup launcher and crash supervisor are installed."
