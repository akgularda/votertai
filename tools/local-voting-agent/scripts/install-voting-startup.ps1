$ErrorActionPreference = "Stop"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node.exe).Source
$envFile = Join-Path $workDir ".env"
$supervisor = (Resolve-Path (Join-Path $PSScriptRoot "voting-supervisor.mjs")).Path
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "RadioTEDU Voting Radio.cmd"
$lines = @(
  "@echo off",
  "start `"RadioTEDU Voting Radio`" /min `"$node`" --env-file=`"$envFile`" `"$supervisor`""
)
[IO.File]::WriteAllLines($launcher, $lines, [Text.ASCIIEncoding]::new())

if (Get-ScheduledTask -TaskName "RadioTEDU Voting Radio" -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName "RadioTEDU Voting Radio" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "RadioTEDU Voting Radio" -Confirm:$false -ErrorAction SilentlyContinue
}

$alreadyRunning = Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue
if (-not $alreadyRunning) {
  Start-Process -FilePath $node -ArgumentList @("--env-file=$envFile", $supervisor) -WorkingDirectory $workDir -WindowStyle Hidden
}
Write-Output "Voting radio Startup launcher and crash supervisor are installed."
