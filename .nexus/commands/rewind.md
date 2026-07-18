# Rewind Command

文件级回滚：将工作区文件还原到先前由 Nexus checkpoint 系统捕获的状态。

与 omp 内置的会话级 `checkpoint`/`rewind`（仅截断对话历史）互补，本命令
通过 `@nexus-agent/checkpoint` 的 native addon 真正还原磁盘文件内容。

## Arguments

- `$ARGUMENTS` — 必填。三种形式：
  - `/rewind list` — 列出当前 session 的所有 checkpoint 元数据
  - `/rewind <id>` — 回滚到指定 id 的 checkpoint（`id` 即 `prompt_index`）
  - `/rewind diff <id>` — 显示 checkpoint `<id>` 与当前磁盘状态的差异

## Steps

### 1. 解析参数

读取 `$ARGUMENTS`：

- 若为 `list` → 走 [步骤 2a](#2a-list-列出所有-checkpoint)
- 若为 `diff <id>` → 走 [步骤 2b](#2b-diff-显示差异)
- 若为纯数字 `<id>` → 走 [步骤 2c](#2c-rewind-回滚到指定-checkpoint)
- 否则 → 打印用法并退出

### 2a. list：列出所有 checkpoint

调用 `getFileCheckpointStore(session)` 获取当前 session 的 `CheckpointStoreHandle`，
然后 `await store.list()` 获取元数据列表。

输出格式：

```
 ID | Label              | Created At           | Files | Size
----|--------------------|----------------------|-------|--------
  0 | before-refactor    | 2026-07-17T10:00:00Z |     5 | 12.3 KB
  1 | before-test-fix    | 2026-07-17T10:15:00Z |     2 |  4.1 KB
```

若无 checkpoint，打印：

```
（无 checkpoint。使用 bash/edit/write 工具前会自动创建，或显式调用
 `nexus checkpoint create <label>` 创建一个。）
```

### 2b. diff：显示差异

调用 `await store.diff(id, id + 1)`（若 `id + 1` 存在）或与当前磁盘状态对比。

输出格式：

```
Checkpoint #<id> ↔ 当前状态：
  + 新增：src/new_file.rs
  ~ 修改：src/main.rs
  - 删除：src/old_file.rs
```

若 `id` 不存在，打印错误并建议先运行 `/rewind list`。

### 2c. rewind：回滚到指定 checkpoint

1. 调用 `await store.restore(id)` 执行回滚
2. 检查返回的 `RestoreResultDto`：
   - 若 `success === true`：打印还原的文件列表
   - 若 `success === false`：打印错误 + 冲突列表
3. 回滚后，所有 `>= id` 的 checkpoint 会被自动截断（由 store 内部完成）

输出格式（成功）：

```
✓ 已回滚到 checkpoint #<id>（<label>）
  还原文件：<list>
  干净文件（无需还原）：<list>
```

输出格式（失败）：

```
✗ 回滚失败：<error>
  冲突文件：
    <path> (<conflict_type>)
  已还原文件：<list>
```

## Rules

- **MUST** 使用 `@nexus-agent/checkpoint` 的 `CheckpointStoreHandle`，不直接操作磁盘
- **MUST NOT** 在 `checkpoint.autoEnabled = false` 时静默失败 — 应提示用户开启
- **MUST** 在回滚前显示 checkpoint 的 label 和创建时刻，让用户确认
- **MUST NOT** 回滚 `.nexus/rewind-checkpoints/` 目录本身（store 自我保护）
- 若 native addon 未构建，打印构建提示并退出（不抛异常）
