#Requires -Version 5.0
<#
.SYNOPSIS
    Nexus Agent one-click launcher.
.DESCRIPTION
    Detects and installs Bun / Rust toolchain, compiles native modules, then launches dev server.
#>

param(
    [switch]$SkipBuild,
    [switch]$CheckOnly
)

# 强制 UTF-8 输出,避免中文在 PowerShell 5.1 里乱码
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Write-Step($msg) { Write-Host ""; Write-Host "========================================" -ForegroundColor DarkGray; Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "  [XX] $msg" -ForegroundColor Red }
function Write-Info2($msg){ Write-Host "  ..  $msg" -ForegroundColor DarkGray }

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
    $cargoBin = "$env:USERPROFILE\.cargo\bin"
    if (($env:Path -notlike "*$cargoBin*") -and (Test-Path $cargoBin)) {
        $env:Path += ";$cargoBin"
    }
    $bunHome = "$env:USERPROFILE\.bun\bin"
    if (($env:Path -notlike "*$bunHome*") -and (Test-Path $bunHome)) {
        $env:Path += ";$bunHome"
    }
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# 运行原生命令(bun/cargo 等),正确处理 stderr:
# PowerShell 5.1 在 $ErrorActionPreference="Stop" 下会把原生命令的 stderr 输出
# 当作终止性错误抛出,导致 bun install 写 "Resolving dependencies" 时脚本崩溃。
# 此函数临时切到 "Continue",让 stderr 正常流入管道显示。
function Invoke-Native {
    param([Parameter(Mandatory)][scriptblock]$ScriptBlock)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $ScriptBlock 2>&1 | ForEach-Object { Write-Info2 $_ }
    } finally {
        $ErrorActionPreference = $prev
    }
}

# 启动时立即刷新 PATH(从注册表读最新值 + 补全 cargo/bun 常见路径)
# 解决:用户已装 Rust/Bun 但当前 shell 的 PATH 还没更新的情况
Refresh-Path

Write-Host "  _   _                  _ " -ForegroundColor DarkCyan
Write-Host " | \ | | __ _ _ __   __| | __ _" -ForegroundColor DarkCyan
Write-Host " |  \| |/ _' | '_ \ / _' |/ _' |" -ForegroundColor DarkCyan
Write-Host " | |\  | (_| | | | | (_| | (_| |" -ForegroundColor DarkCyan
Write-Host " |_| \_|\__,_|_| |_|\__,_|\__,_|" -ForegroundColor DarkCyan
Write-Host "                                  Agent - One-Click Launcher" -ForegroundColor DarkCyan

# ===== Step 1: Bun =====
Write-Step "Step 1/5  Detect Bun runtime"

$bunOk = $false
if (Test-Command "bun") {
    $bunVer = (bun --version 2>$null)
    if ($bunVer) {
        Write-Ok "Bun v$bunVer installed"
        $bunOk = $true
    }
}

if (-not $bunOk) {
    Write-Warn2 "Bun not found, auto-installing..."
    Write-Info2 "Using official installer bun.sh/install.ps1"
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
        Refresh-Path
        Start-Sleep -Seconds 1
        $bunVer = (bun --version 2>$null)
        if ($bunVer) {
            Write-Ok "Bun v$bunVer installed successfully"
        } else {
            throw "install script finished but bun command still unavailable"
        }
    } catch {
        Write-Err2 "Bun auto-install failed: $_"
        Write-Host ""
        Write-Host "  Please install Bun manually:" -ForegroundColor Yellow
        Write-Host "    PowerShell:  irm bun.sh/install.ps1 | iex" -ForegroundColor White
        Write-Host "    Or visit:     https://bun.sh/docs/installation" -ForegroundColor White
        Write-Host ""
        exit 1
    }
}

# ===== Step 2: Rust =====
Write-Step "Step 2/5  Detect Rust toolchain (cargo)"

$cargoOk = $false
if (Test-Command "cargo") {
    $cargoVer = (cargo --version 2>$null)
    if ($cargoVer) {
        Write-Ok $cargoVer
        $cargoOk = $true
    }
}

if (-not $cargoOk) {
    Write-Warn2 "Rust not found, auto-installing..."
    Write-Host ""
    Write-Host "  >>> IMPORTANT <<<" -ForegroundColor Yellow
    Write-Host "  Rust on Windows requires Visual Studio C++ Build Tools." -ForegroundColor Yellow
    Write-Host "  If compilation fails later, install Build Tools first:" -ForegroundColor Yellow
    Write-Host "    https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor White
    Write-Host "  (Check 'Desktop development with C++' workload)" -ForegroundColor DarkGray
    Write-Host ""

    $rustupInit = "$env:TEMP\rustup-init.exe"
    Write-Info2 "Downloading rustup-init.exe ..."
    try {
        Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustupInit -UseBasicParsing
        Write-Info2 "Running rustup-init (stable toolchain, default profile)..."
        & $rustupInit -y --default-toolchain stable --profile default 2>&1 | ForEach-Object { Write-Info2 $_ }
        Refresh-Path
        Start-Sleep -Seconds 1
        $cargoVer = (cargo --version 2>$null)
        if ($cargoVer) {
            Write-Ok $cargoVer
        } else {
            throw "rustup finished but cargo command still unavailable"
        }
    } catch {
        Write-Err2 "Rust auto-install failed: $_"
        Write-Host ""
        Write-Host "  Please install Rust manually:" -ForegroundColor Yellow
        Write-Host "    Visit: https://rustup.rs/" -ForegroundColor White
        Write-Host ""
        exit 1
    }
}

if ($CheckOnly) {
    Write-Step "Environment check complete (-CheckOnly mode, not launching)"
    exit 0
}

# ===== Step 3: bun install =====
Write-Step "Step 3/5  Install project dependencies (bun install)"

# 检查 node_modules 是否真正存在且完整(bun.lock 是 git 跟踪文件,会随仓库分发,
# 不能仅凭 bun.lock 存在就认为依赖已安装)
$nativesNodeModules = "$Root\node_modules\@napi-rs\cli"
if ((Test-Path "$Root\node_modules") -and (Test-Path $nativesNodeModules)) {
    Write-Ok "Dependencies already installed (node_modules present)"
    Write-Info2 "To reinstall, delete node_modules, then run again"
} else {
    if (-not (Test-Path "$Root\node_modules")) {
        Write-Info2 "First run (node_modules missing), installing dependencies..."
    } else {
        Write-Warn2 "node_modules incomplete (missing @napi-rs/cli), reinstalling..."
    }
    Write-Info2 "This may take 1-3 minutes on first run"
    try {
        Invoke-Native { bun install }
        if ($LASTEXITCODE -ne 0) { throw "bun install exit code $LASTEXITCODE" }
        Write-Ok "Dependencies installed"
    } catch {
        Write-Err2 "bun install failed: $_"
        Write-Host "  Try deleting bun.lock and retry, or check network" -ForegroundColor Yellow
        exit 1
    }
}

# ===== Step 4: Build native modules =====
if (-not $SkipBuild) {
    Write-Step "Step 4/5  Detect and compile native modules"

    $nativesNode = Get-ChildItem -Path "$Root\packages\natives\native" -Filter "pi_natives.*.node" -ErrorAction SilentlyContinue
    $needNatives = -not $nativesNode -or $nativesNode.Count -eq 0

    $checkpointNode = Get-ChildItem -Path "$Root\packages\nexus-checkpoint\native" -Filter "nexus-checkpoint.*.node" -ErrorAction SilentlyContinue
    $needCheckpoint = -not $checkpointNode -or $checkpointNode.Count -eq 0

    if ($needNatives) {
        Write-Warn2 "pi-natives missing .node binary, compiling..."
        Write-Info2 "First compile may take 3-10 minutes (Rust release + LTO)"
        try {
            Invoke-Native { bun run build:native }
            if ($LASTEXITCODE -ne 0) { throw "pi-natives build exit code $LASTEXITCODE" }
            Write-Ok "pi-natives compiled"
        } catch {
            Write-Err2 "pi-natives compile failed: $_"
            Write-Host ""
            Write-Host "  Common causes:" -ForegroundColor Yellow
            Write-Host "  1. Missing Visual Studio C++ Build Tools" -ForegroundColor White
            Write-Host "     Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor White
            Write-Host "     Check 'Desktop development with C++'" -ForegroundColor DarkGray
            Write-Host "  2. Incomplete Rust toolchain -> run: rustup install stable" -ForegroundColor White
            Write-Host ""
            exit 1
        }
    } else {
        Write-Ok "pi-natives already compiled ($($nativesNode[0].Name))"
    }

    if ($needCheckpoint) {
        Write-Warn2 "nexus-checkpoint missing .node binary, compiling..."
        try {
            Invoke-Native { bun --cwd=packages/nexus-checkpoint run build }
            if ($LASTEXITCODE -ne 0) { throw "nexus-checkpoint build exit code $LASTEXITCODE" }
            Write-Ok "nexus-checkpoint compiled"
        } catch {
            Write-Err2 "nexus-checkpoint compile failed: $_"
            Write-Host "  Check Rust toolchain and VS Build Tools" -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Ok "nexus-checkpoint already compiled ($($checkpointNode[0].Name))"
    }
} else {
    Write-Step "Step 4/5  Skipping build (-SkipBuild)"
}

# ===== Step 5: Launch =====
Write-Step "Step 5/5  Launch Nexus Agent"
Write-Host ""
Write-Host "  >>> Starting dev server <<<" -ForegroundColor Green
Write-Host "  First launch loads native modules, may take a few seconds" -ForegroundColor DarkGray
Write-Host ""

try {
    & bun run dev
} catch {
    Write-Err2 "Launch failed: $_"
    Write-Host ""
    Write-Host "  Troubleshooting:" -ForegroundColor Yellow
    Write-Host "  1. Check API Key config (see docs/environment-variables.md)" -ForegroundColor White
    Write-Host "  2. Try recompiling: .\start.ps1" -ForegroundColor White
    Write-Host "  3. Review full log and seek help" -ForegroundColor White
    exit 1
}
