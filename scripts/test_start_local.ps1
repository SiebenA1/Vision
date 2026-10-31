# Exercise reuse of existing installations with fresh stamps; forbid any installer call.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$testScript = Join-Path $PSScriptRoot "tmp-start-local-$PID.ps1"
$stamps = @(
    (Join-Path $projectRoot "node_modules\.vision-launcher-test-$PID.sha256"),
    (Join-Path $projectRoot ".python313\.vision-native-test-$PID.sha256"),
    (Join-Path $projectRoot ".python313\.vision-core-test-$PID.sha256")
)
try {
    $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'start-local.ps1') -Raw
    $source = $source.Replace('    & $Program @Arguments', @'
    if ($Arguments -contains 'ci' -or $Arguments -contains 'install' -or $Arguments -contains 'scripts/setup_native.py') { throw 'UNEXPECTED_INSTALL' }
    & $Program @Arguments
'@)
    $source = $source.Replace('.vision-setup.sha256', ".vision-launcher-test-$PID.sha256").Replace('.vision-native-setup.sha256', ".vision-native-test-$PID.sha256").Replace('.vision-core-setup.sha256', ".vision-core-test-$PID.sha256")
    # Keep the check focused on dependency reuse, without creating a real .env.
    $source = $source.Replace("if (-not (Test-Path .env)) { Copy-Item -LiteralPath .env.example -Destination .env }", '')
    Set-Content -LiteralPath $testScript -Value $source -Encoding utf8
    foreach ($pass in 1..2) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $testScript -SetupOnly
        if ($LASTEXITCODE -ne 0) { throw "Reuse test failed on pass $pass" }
        foreach ($stamp in $stamps) { if (-not (Test-Path -LiteralPath $stamp)) { throw "Missing stamp: $stamp" } }
    }
    Write-Host 'PASS existing environment without stamps, and repeated launch: no installer invoked.'
} finally {
    foreach ($path in @($testScript) + $stamps) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
}
