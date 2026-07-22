---
name: memory-routing
description: 三后端记忆分工约定。Use when deciding where to store or retrieve information — mnemopi for session working memory, Qdrant for long-term document/code snippets, LightRAG for entity-relationship knowledge graphs. Read this before calling retain, mcp__qdrant__qdrant_store, or mcp__lightrag__lightrag_index.
---

# 记忆写入分工约定

Nexus 有三个记忆/知识后端，各有明确定位。写入前必须判断内容类型，选择正确后端。

## 后端定位

| 后端 | 定位 | 写入方式 | 检索方式 |
|---|---|---|---|
| **mnemopi** | 会话级工作记忆 | 自动 retain（agent_end 事件触发） | recall（agent_start 自动 + 手动） |
| **Qdrant** | 长期文档向量库 | 显式 `mcp__qdrant__qdrant_store` | `mcp__qdrant__qdrant_find` |
| **LightRAG** | 知识图谱（实体+关系） | 显式 `mcp__lightrag__lightrag_index` | `mcp__lightrag__lightrag_query` |

## 写入决策规则

### 写入 mnemopi（自动，无需手动操作）

mnemopi 在 agent_end 时自动 retain 以下内容，**不要手动调用 retain** 除非有特殊需求：

- 对话上下文和决策理由
- 用户偏好和纠正
- 当前会话的临时事实
- 任务完成状态和待办事项

### 写入 Qdrant（显式调用 `mcp__qdrant__qdrant_store`）

当出现以下内容时，**主动**存入 Qdrant：

- **项目文档片段**：API 文档、设计文档、README 中的重要段落
- **代码片段**：关键算法实现、配置模板、常用代码模式
- **技术笔记**：踩坑记录、解决方案、性能调优经验
- **外部知识**：从网页抓取的技术文章、教程摘要
- **用户明确要求记住的参考材料**

存储时应附带 metadata（source、type、date）以便后续过滤。

### 写入 LightRAG（显式调用 `mcp__lightrag__lightrag_index`）

当出现以下内容时，**主动**存入 LightRAG：

- **架构关系**：模块依赖、服务调用链、数据流向
- **实体定义**：类/接口/服务的职责定义和属性
- **跨文档关联**：多个文档/代码文件间的依赖关系
- **因果链**：决策原因链、事件触发链
- **分类体系**：技术栈分类、组件层次结构

LightRAG 会自动抽取实体和关系，构建知识图谱，支持多跳推理查询。

## 检索决策规则

| 需求 | 选择 | 原因 |
|---|---|---|
| 回忆刚才讨论的内容 | mnemopi（自动） | 会话内上下文 |
| 查找项目文档/代码片段 | `mcp__qdrant__qdrant_find` | 向量相似度搜索 |
| 查询"A 依赖什么"、"X 如何影响 Y" | `mcp__lightrag__lightrag_query` (mode=local) | 图谱多跳推理 |
| 查询全局架构概览 | `mcp__lightrag__lightrag_query` (mode=global) | 图谱全局视图 |
| 综合检索（不确定用哪个） | `mcp__lightrag__lightrag_query` (mode=hybrid) | 混合模式 |

## 冲突避免

- **不重复存储**：mnemopi 自动管理的内容不要手动存入 Qdrant/LightRAG
- **Qdrant vs LightRAG 不重叠**：Qdrant 存"是什么"（文档/片段），LightRAG 存"关系是什么"（实体/依赖）
- **先检索后写入**：写入前先检索，避免重复条目
