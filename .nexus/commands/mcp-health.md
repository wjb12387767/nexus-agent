---
description: MCP 服务就绪检查 — 检测 4 个 MCP 后端的端口、容器、bridge 进程是否存活
---

# MCP 健康检查

对全部已配置的 MCP server 执行三层就绪检查：Docker 容器状态 → 端口可达性 → MCP 协议握手。

## 参数

- `$ARGUMENTS` — 可选。指定要检查的 server 名（如 `qdrant`、`docling`、`playwright`、`lightrag`）。省略则检查全部。

## 执行步骤

### 1. 解析参数

读取 `$ARGUMENTS`：
- 为空 → 检查全部 4 个 MCP server
- 非空 → 只检查指定 server

### 2. 检查 Qdrant（Docker + 端口）

执行以下检查并报告结果：

```bash
# 检查 Docker 容器状态
docker ps --filter name=nexus-qdrant --format "{{.Names}} {{.Status}}"

# 检查端口可达性
curl -s -o /dev/null -w "%{http_code}" http://localhost:6333/healthz
```

报告：
- 容器是否运行（Running / Stopped / Not Found）
- HTTP 健康检查状态码（200 = 健康）
- 如果失败，给出修复建议：`docker run -d --name nexus-qdrant -p 6333:6333 -p 6334:6334 -v nexus-qdrant-data:/qdrant/storage qdrant/qdrant:latest`

### 3. 检查 Docling Serve（进程 + 端口）

```bash
# 检查端口可达性
curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/health

# 检查进程是否存在（Windows）
tasklist /FI "IMAGENAME eq python.exe" /V 2>NUL | findstr docling_serve
# 或（Linux/macOS）
pgrep -f docling_serve
```

报告：
- 端口是否可达（200 = 健康）
- 进程是否存在
- 如果失败，给出修复建议：`python -m docling_serve.run`（首次启动需下载模型，可能较慢）

### 4. 检查 Playwright MCP（命令可用性）

```bash
# 检查 npx 和 @playwright/mcp 是否可用
npx @playwright/mcp@latest --help
```

报告：
- 命令是否可用（exit code 0 = 可用）
- Playwright 浏览器是否已安装
- 如果失败，给出修复建议：`npx playwright install chromium`

### 5. 检查 LightRAG Bridge（脚本 + 语法）

```bash
# 检查 bridge 脚本是否存在且语法正确（跨平台路径）
python -c "import ast, os; p=os.path.expanduser('~/.nexus/externals/lightrag-mcp-bridge/server.py'); ast.parse(open(p).read()); print('Syntax OK')"
```

报告：
- 脚本是否存在
- 语法是否正确
- lightrag-hku 包是否已安装：`python -c "import lightrag; print('OK')"`

### 6. 检查 MCP 协议层（通过 /mcp list）

运行 `/mcp list` 获取已配置的 MCP server 列表，确认 4 个 server 都在配置中：
- playwright
- docling
- qdrant
- lightrag

### 7. 汇总报告

输出汇总表格：

```
MCP Server Health Report
=========================
Server      | Container/Process | Port      | Protocol | Status
------------|-------------------|-----------|----------|--------
Qdrant      | Docker: Running   | 6333 ✓    | ✓        | HEALTHY
Docling     | Process: Running  | 5001 ✓    | ✓        | HEALTHY
Playwright  | N/A (on-demand)   | N/A       | ✓        | HEALTHY
LightRAG    | Script: OK        | N/A       | ✓        | HEALTHY

Summary: 4/4 healthy
```

对于不健康的 server，给出具体修复命令。
