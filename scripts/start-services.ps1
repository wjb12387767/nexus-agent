# 启动 nexus-agent 外部服务（Qdrant + Docling Serve）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\start-services.ps1

$ErrorActionPreference = "Stop"
Write-Host "=== Nexus Agent 外部服务启动器 ===" -ForegroundColor Cyan

# ── 1. Qdrant 向量数据库 ──
Write-Host "`n[1/3] 检查 Qdrant 向量数据库..." -ForegroundColor Yellow
$qdrantRunning = docker ps --filter name=nexus-qdrant --format "{{.Names}}" 2>$null
if ($qdrantRunning -eq "nexus-qdrant") {
    Write-Host "  [OK] Qdrant 已在运行" -ForegroundColor Green
} else {
    Write-Host "  启动 Qdrant Docker..." -ForegroundColor Gray
    docker rm -f nexus-qdrant 2>$null | Out-Null
    docker run -d --name nexus-qdrant -p 6333:6333 -p 6334:6334 -v nexus-qdrant-data:/qdrant/storage qdrant/qdrant:latest 2>&1 | Out-Null
    Start-Sleep 3
    try {
        $h = Invoke-RestMethod "http://localhost:6333/healthz" -Method GET
        Write-Host "  [OK] Qdrant 启动成功: http://localhost:6333" -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Qdrant 健康检查失败，可能仍在启动中" -ForegroundColor Red
    }
}

# ── 2. Docling Serve 文档转换服务 ──
Write-Host "`n[2/3] 检查 Docling Serve..." -ForegroundColor Yellow
$doclingProcess = Get-Process -Name "python" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "docling_serve" 2>$null
}
if ($doclingProcess) {
    Write-Host "  [OK] Docling Serve 已在运行" -ForegroundColor Green
} else {
    Write-Host "  启动 Docling Serve (端口 5001)..." -ForegroundColor Gray
    # 后台启动 docling-serve
    $proc = Start-Process -FilePath "python" -ArgumentList "-m", "docling_serve.run" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:USERPROFILE\.nexus\logs\docling-serve.log" -RedirectStandardError "$env:USERPROFILE\.nexus\logs\docling-serve.err.log"
    # 等待服务就绪
    $ready = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep 2
        try {
            $r = Invoke-RestMethod "http://localhost:5001/health" -Method GET -ErrorAction Stop
            $ready = $true
            break
        } catch {
            Write-Host "  等待就绪... ($($i*2+2)s)" -ForegroundColor DarkGray
        }
    }
    if ($ready) {
        Write-Host "  [OK] Docling Serve 启动成功: http://localhost:5001" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] Docling Serve 可能仍在启动（首次加载模型较慢）" -ForegroundColor Red
        Write-Host "  日志: $env:USERPROFILE\.nexus\logs\docling-serve.log" -ForegroundColor DarkGray
    }
}

# ── 3. 验证 MCP 配置 ──
Write-Host "`n[3/3] 验证 MCP 配置..." -ForegroundColor Yellow
$mcpConfig = "$env:USERPROFILE\.nexus\agent\mcp.json"
if (Test-Path $mcpConfig) {
    $config = Get-Content $mcpConfig -Raw | ConvertFrom-Json
    $servers = $config.mcpServers.PSObject.Properties.Name
    Write-Host "  已配置的 MCP Server:" -ForegroundColor Gray
    foreach ($s in $servers) {
        Write-Host "    - $s" -ForegroundColor Cyan
    }
} else {
    Write-Host "  [WARN] MCP 配置文件不存在: $mcpConfig" -ForegroundColor Red
}

# ── 汇总 ──
Write-Host "`n=== 服务状态汇总 ===" -ForegroundColor Cyan
Write-Host "  Qdrant:       http://localhost:6333  (向量数据库)" -ForegroundColor White
Write-Host "  Docling Serve: http://localhost:5001  (文档转换)" -ForegroundColor White
Write-Host "  MCP Servers:  4 个 (playwright/docling/qdrant/lightrag)" -ForegroundColor White
Write-Host ""
Write-Host "提示: 这些服务需要保持运行，nexus-agent 的 MCP 工具才能正常工作。" -ForegroundColor DarkGray
Write-Host "提示: Docling Serve 首次启动会下载 AI 模型（约 1-2GB），可能需要几分钟。" -ForegroundColor DarkGray
