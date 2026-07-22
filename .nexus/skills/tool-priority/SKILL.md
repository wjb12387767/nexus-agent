---
name: tool-priority
description: 工具选择优先级约定。Use when choosing between overlapping tools — PDF/Office parsing (read vs Docling MCP), web interaction (Playwright MCP vs native browser vs fetch), vector search (Qdrant vs mnemopi recall), or knowledge queries (LightRAG vs Qdrant). Read this before selecting a tool for document, web, or memory operations.
---

# 工具选择优先级

Nexus 有多组功能重叠的工具。按场景选择最合适的工具，而非固定优先级。

## 文档解析

| 场景 | 首选工具 | 原因 |
|---|---|---|
| 读取本地 PDF/Word/PPT/Excel | `read`（自动走 Docling Serve） | markit.ts 透明接管，无需显式调 MCP |
| 需要更精细的文档分析（表格、OCR） | `mcp__docling__convert` | MCP 工具暴露完整 Docling 选项 |
| 读取纯文本/代码文件 | `read` | 直接读取，无需转换 |
| 抓取网页内容 | `fetch` 或 `web_search` | 无需启动文档解析 |

**关键规则**：`read file.pdf` 已透明走 Docling，不要对本地文件额外调用 `mcp__docling__convert`。仅在需要 Docling 高级选项（如 OCR 语言、表格格式）时才显式调用 MCP 工具。

## Web 交互

| 场景 | 首选工具 | 原因 |
|---|---|---|
| 表单填写、登录、多步交互 | `mcp__playwright__browser_*` | accessibility snapshot 精准、auto-wait |
| 截图对比、CDP 调试、网络拦截 | 内建 `browser` | Puppeteer/CDP 控制更细 |
| 简单页面抓取/搜索 | `web_search` + `fetch` | 最轻量，无需启动浏览器 |
| 需要页面结构化快照 | `mcp__playwright__browser_snapshot` | ARIA 树比截图更适合 LLM |
| 下载文件 | `mcp__playwright__browser_click` 或内建 `browser` | 均可，看上下文 |

**关键规则**：
1. 如果只是获取网页信息（不交互），优先 `web_search` + `fetch`，不要启动浏览器
2. 如果需要点击/输入/导航，优先 Playwright MCP（accessibility 模式比截图更精准）
3. 如果 Playwright MCP 不可用或需要 CDP 级控制，回退到内建 `browser`
4. 两个浏览器工具可以共存，按场景选择，不要固定用一个

## 记忆/知识检索

| 场景 | 首选工具 | 原因 |
|---|---|---|
| 回忆当前会话内容 | `recall`（mnemopi，自动触发） | 会话级工作记忆 |
| 查找项目文档/代码片段 | `mcp__qdrant__qdrant_find` | 向量相似度搜索 |
| 查询实体关系/架构依赖 | `mcp__lightrag__lightrag_query` | 知识图谱多跳推理 |
| 不确定用哪个 | 先 `recall`，再 `mcp__qdrant__qdrant_find`，最后 `mcp__lightrag__lightrag_query` | 逐级扩大范围 |

详细分工见 `skill://memory-routing`。

## 代码搜索

| 场景 | 首选工具 | 原因 |
|---|---|---|
| 按文件名/路径查找 | `glob` | 最快 |
| 按内容正则搜索 | `grep` | ripgrep 高性能 |
| 按语义搜索（"怎么做 X"） | `ast_grep` | AST 结构化匹配 |
| 跨文件理解调用关系 | `read` + `grep` 组合 | 先定位再读取 |

## 决策原则

1. **轻量优先**：能用 `fetch` 不开浏览器，能用 `grep` 不用 `ast_grep`
2. **场景匹配**：按任务类型选工具，不按工具"等级"选
3. **回退链**：首选工具失败时，按表格中的顺序回退
4. **不重复**：一个任务只用一个工具，不要同时调多个重叠工具
