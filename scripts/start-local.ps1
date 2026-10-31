# Run from any directory: powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1
[CmdletBinding()]
param(
    [switch]$SetupOnly,
    [switch]$CheckOnly,
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Program $($Arguments -join ' ')" }
}

function Test-Installed {
    param([string]$Program, [string[]]$Arguments)
    if (-not (Get-Command $Program -ErrorAction SilentlyContinue)) { return $false }
    & $Program @Arguments *> $null
    return $LASTEXITCODE -eq 0
}

Push-Location -LiteralPath $projectRoot
try {
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows x64.' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js >= 20.19 (including npm), reopen your terminal, then run this script again.'
    }
    $nodeVersion = [version]((& node --version).Trim().TrimStart('v'))
    if ($nodeVersion -lt [version]'20.19.0') { throw 'Node.js >= 20.19 is required.' }

    $cadPython = Join-Path $projectRoot '.python312\python.exe'
    $corePython = Join-Path $projectRoot '.python313\python.exe'
    $npmStamp = Join-Path $projectRoot 'node_modules\.vision-setup.sha256'
    $nativeStamp = Join-Path $projectRoot '.python313\.vision-native-setup.sha256'
    $coreStamp = Join-Path $projectRoot '.python313\.vision-core-setup.sha256'
    $npmHash = (Get-FileHash package-lock.json).Hash + (Get-FileHash package.json).Hash
    $nativeHash = (Get-FileHash scripts/setup_native.py).Hash + (Get-FileHash server/requirements.txt).Hash + (Get-FileHash server/requirements-usd-brep.txt).Hash
    $coreHash = (Get-FileHash backend/requirements.txt).Hash

    if (-not $CheckOnly) {
        $frontendReady = (Test-Path node_modules/.bin/vite.cmd) -and (Test-Installed 'node' @('--input-type=module', '-e', "await import('vite'); await import('react'); await import('three'); await import('typescript'); await import('vitest/node');"))
        $nativeReady = (Test-Installed $cadPython @('-I', '-c', 'import usd_brep')) -and (Test-Installed $corePython @('-I', '-c', 'import numpy, scipy, skfem, tetgen'))
        if ($Reinstall -or -not $frontendReady -or ((Test-Path $npmStamp) -and (Get-Content $npmStamp -Raw).Trim() -ne $npmHash)) {
            Write-Host 'Installing frontend dependencies...'
            Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund')
        } else {
            Write-Host 'Reusing installed frontend dependencies.'
        }
        Set-Content -LiteralPath $npmStamp -Value $npmHash -Encoding ascii
        if ($Reinstall -or -not $nativeReady -or ((Test-Path $nativeStamp) -and (Get-Content $nativeStamp -Raw).Trim() -ne $nativeHash)) {
            Write-Host 'Configuring project-local Python 3.12 CAD and Python 3.13 FEA runtimes...'
            if (Test-Path $corePython) { Invoke-Checked $corePython @('scripts/setup_native.py', '--fea') }
            elseif (Test-Path $cadPython) { Invoke-Checked $cadPython @('scripts/setup_native.py', '--fea') }
            elseif (Get-Command python -ErrorAction SilentlyContinue) { Invoke-Checked 'python' @('scripts/setup_native.py', '--fea') }
            elseif (Get-Command py -ErrorAction SilentlyContinue) { Invoke-Checked 'py' @('-3', 'scripts/setup_native.py', '--fea') }
            else { throw 'Install Python 3 with the Python launcher or add python to PATH for initial setup.' }
        } else {
            Write-Host 'Reusing installed CAD/FEA runtimes.'
        }
        Set-Content -LiteralPath $nativeStamp -Value $nativeHash -Encoding ascii
        $coreReady = Test-Installed $corePython @('-c', 'import fastapi, uvicorn, httpx; from backend.vision.api import create_app')
        if ($Reinstall -or -not $coreReady -or ((Test-Path $coreStamp) -and (Get-Content $coreStamp -Raw).Trim() -ne $coreHash)) {
            Write-Host 'Installing v2 core dependencies...'
            Invoke-Checked $corePython @('-m', 'pip', '--disable-pip-version-check', 'install', '-r', 'backend/requirements.txt')
        } else {
            Write-Host 'Reusing installed v2 core dependencies.'
        }
        Set-Content -LiteralPath $coreStamp -Value $coreHash -Encoding ascii
        if (-not (Test-Path .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
    }

    Write-Host 'Checking frontend, CAD, FEA and v2 core imports...'
    Invoke-Checked 'node' @('--input-type=module', '-e', "await import('vite'); await import('react'); await import('three');")
    Invoke-Checked $cadPython @('-I', '-c', 'import usd_brep')
    Invoke-Checked $corePython @('-c', 'import fastapi, uvicorn, httpx, numpy, scipy, skfem, tetgen; from backend.vision.api import create_app')
    Write-Host 'Environment ready. DeepSeek is optional: set DEEPSEEK_API_KEY in .env for AI conversation.'
    if (-not $SetupOnly -and -not $CheckOnly) {
        Write-Host 'Starting VISION at http://127.0.0.1:4173/ (v2 core starts automatically). Ctrl+C stops the development server.'
        Invoke-Checked 'npm.cmd' @('run', 'dev')
    }
} finally {
    Pop-Location
}
