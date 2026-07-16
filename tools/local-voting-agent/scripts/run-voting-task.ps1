$ErrorActionPreference = "Stop"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = "C:\Program Files\nodejs\node.exe"
$envFile = Join-Path $workDir ".env"
$supervisor = Join-Path $PSScriptRoot "voting-supervisor.mjs"
Set-Location -LiteralPath $workDir
& $node "--env-file=$envFile" $supervisor
exit $LASTEXITCODE
