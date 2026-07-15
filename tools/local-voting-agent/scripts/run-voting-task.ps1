$ErrorActionPreference = "Stop"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $workDir "runtime-logs"
$logFile = Join-Path $logDir "voting-task.log"
$outLog = Join-Path $logDir "voting-agent.out.log"
$errLog = Join-Path $logDir "voting-agent.err.log"
$node = "C:\Program Files\nodejs\node.exe"
$tsx = Join-Path $workDir "node_modules\tsx\dist\cli.mjs"
$server = Join-Path $workDir "src\server\index.ts"
$envFile = Join-Path $workDir ".env"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = "$machinePath;$userPath"
Set-Location -LiteralPath $workDir

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) { Stop-ProcessTree $child.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

"$(Get-Date -Format o) voting supervisor starting" | Add-Content -LiteralPath $logFile
while ($true) {
  try {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      Start-Sleep -Seconds 10
      continue
    }
    $process = Start-Process -FilePath $node -ArgumentList @(
      "--env-file=$envFile", $tsx, $server
    ) -WorkingDirectory $workDir -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
    $startedAt = Get-Date
    $portSeen = $false
    $portMissingSince = $null
    while (-not $process.HasExited) {
      Start-Sleep -Seconds 2
      $process.Refresh()
      $listener = Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($listener) {
        $portSeen = $true
        $portMissingSince = $null
      } elseif ($portSeen) {
        if (-not $portMissingSince) { $portMissingSince = Get-Date }
        if (((Get-Date) - $portMissingSince).TotalSeconds -ge 15) {
          "$(Get-Date -Format o) voting watchdog lost port 4317; restarting process tree" | Add-Content -LiteralPath $logFile
          Stop-ProcessTree $process.Id
          break
        }
      } elseif (((Get-Date) - $startedAt).TotalSeconds -ge 60) {
        "$(Get-Date -Format o) voting watchdog startup timeout; restarting process tree" | Add-Content -LiteralPath $logFile
        Stop-ProcessTree $process.Id
        break
      }
    }
    $process.WaitForExit()
    "$(Get-Date -Format o) voting agent exited with $($process.ExitCode); restarting" | Add-Content -LiteralPath $logFile
  } catch {
    "$(Get-Date -Format o) voting agent failed: $($_.Exception.Message); restarting" | Add-Content -LiteralPath $logFile
  }
  Start-Sleep -Seconds 5
}
