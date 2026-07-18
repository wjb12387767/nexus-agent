# Nexus Agent 集成指南

> 面向集成开发者：gRPC 客户端、VS Code 扩展、per-agent 路由、沙箱配置。

Nexus Agent 提供多种集成方式：通过 gRPC 从外部程序驱动 Agent、通过 VS Code 扩展在编辑器内交互、通过 per-agent 路由让不同子任务使用不同模型。本文档详细说明每种集成方式的接入步骤。

---

## 目录

- [gRPC 服务](#grpc-服务)
- [VS Code 扩展](#vs-code-扩展)
- [模型路由](#模型路由)
- [沙箱配置](#沙箱配置)
- [编程式嵌入](#编程式嵌入)

---

## gRPC 服务

### 启动 gRPC server

```sh
nexus grpc --port 50051
```

server 监听 `127.0.0.1:50051`（默认仅本机访问，可用 `--bind 0.0.0.0` 暴露到网络）。

协议定义见 `packages/nexus-grpc/proto/nexus.proto`，关键 RPC：

| RPC | 类型 | 说明 |
|---|---|---|
| `Prompt` | unary | 同步发送 prompt，等待完整回复 |
| `StreamTokens` | server stream | 流式返回 token（适用于长回复） |
| `SetModel` | unary | 切换当前会话的模型 |
| `Abort` | unary | 中止当前生成 |
| `ToolPermission` | unary | 授权/拒绝某个工具调用 |
| `ActionRequired` | server stream | 监听需要用户授权的事件 |

### Python 客户端

依赖：`grpcio`、`grpcio-tools`。

```python
import grpc
from nexus_pb2 import PromptRequest, SetModelRequest
from nexus_pb2_grpc import NexusStub

# 生成 stub：
#   python -m grpc_tools.protoc -I . --python_out=. --grpc_python_out=. nexus.proto

channel = grpc.insecure_channel("127.0.0.1:50051")
client = NexusStub(channel)

# 切换模型
client.SetModel(SetModelRequest(model="claude-3-5-sonnet-20241022"))

# 同步 prompt
resp = client.Prompt(PromptRequest(text="解释这段代码：def fib(n): ..."))
print(resp.text)

# 流式 prompt
for chunk in client.StreamTokens(PromptRequest(text="写一个二分查找")):
    print(chunk.token, end="", flush=True)
```

### Go 客户端

```go
package main

import (
	"context"
	"fmt"
	"google.golang.org/grpc"
	pb "path/to/nexus/proto"  // 用 protoc-gen-go 生成
)

func main() {
	conn, _ := grpc.Dial("127.0.0.1:50051", grpc.WithInsecure())
	defer conn.Close()
	client := pb.NewNexusClient(conn)

	// 流式 prompt
	stream, _ := client.StreamTokens(context.Background(),
		&pb.PromptRequest{Text: "写一个二分查找"})
	for {
		chunk, err := stream.Recv()
		if err != nil { break }
		fmt.Print(chunk.Token)
	}
}
```

### Rust 客户端

依赖 `tonic`、`prost`：

```rust
use nexus_proto::nexus_client::NexusClient;
use nexus_proto::PromptRequest;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = NexusClient::connect("http://127.0.0.1:50051").await?;
    let mut stream = client.stream_tokens(
        tonic::Request::new(PromptRequest { text: "写一个二分查找".into() })
    ).await?.into_inner();
    while let Some(chunk) = stream.message().await? {
        print!("{}", chunk.token);
    }
    Ok(())
}
```

### 权限交互

当 Agent 需要执行工具调用（如运行 bash 命令）时，会通过 `ActionRequired` 流推送一个授权请求。客户端需要决定是否授权，并通过 `ToolPermission` 回复：

```python
# 监听授权请求
def listen_actions():
    for action in client.ActionRequired(google.protobuf.empty_pb2.Empty()):
        if action.tool == "bash" and "rm -rf" in action.args.get("command", ""):
            client.ToolPermission(ToolPermissionRequest(
                action_id=action.id, allow=False))
        else:
            client.ToolPermission(ToolPermissionRequest(
                action_id=action.id, allow=True))

# 在单独线程跑
import threading
threading.Thread(target=listen_actions, daemon=True).start()
```

### 完整示例

`packages/nexus-grpc/examples/` 下有完整的 Python / Go / Rust 客户端示例。

---

## VS Code 扩展

### 安装

1. 在 VS Code 扩展市场搜索 "Nexus Agent"
2. 点击 Install
3. 重启 VS Code

或手动安装 vsix：

```sh
code --install-extension nexus-vscode-1.0.0-beta.vsix
```

### 使用

1. 打开命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`）
2. 输入 `Nexus: Start` 启动会话
3. 在侧栏的 Nexus 面板中输入 prompt
4. 流式输出会渲染在面板顶部
5. 当 Agent 请求工具授权时，弹出确认框

### 配置

VS Code 设置（`settings.json`）：

```json
{
  "nexus.transport": "stdio",          // "stdio"（默认）或 "grpc"
  "nexus.grpcEndpoint": "127.0.0.1:50051",  // transport=grpc 时使用
  "nexus.model": "claude-3-5-sonnet-20241022",
  "nexus.theme": "nexus-dark"
}
```

#### stdio vs gRPC

- **stdio**（默认）：扩展 spawn 一个 `nexus` 子进程，通过 stdin/stdout 通信。无需额外启动 server。
- **gRPC**：扩展连接到 `nexus grpc --port 50051` 启动的 server。适合多个客户端共享同一个 Agent 会话。

### 主题

Nexus 提供专属主题：`Nexus Dark`、`Nexus Light`、`Nexus Midnight`。在 `Cmd+K Cmd+T` 中切换。

---

## 模型路由

### 概念

Nexus 的 per-agent 路由允许为不同的子任务指定不同模型。路由优先级：

```
explicit（命令行 / RPC 显式指定）
  > routing（config.json 的 agentModels 配置）
  > global（config.json 的 model 字段）
```

### 配置

```json
{
  "routing": {
    "defaultModel": "claude-3-5-sonnet-20241022",
    "agentModels": {
      "code-reviewer": "deepseek/deepseek-coder",
      "doc-writer": "gpt-4o",
      "searcher": "gpt-4o-mini",
      "translator": "qwen/qwen-max"
    },
    "agentRouting": [
      {
        "match": { "task": "code-review" },
        "model": "deepseek/deepseek-coder",
        "fallback": "claude-3-5-sonnet-20241022"
      }
    ]
  }
}
```

### 交互式配置

```sh
nexus config routing
```

会引导你为每个内置 agent 类型选择模型。配置完成后写入 `~/.nexus/config.json`。

### 在 gRPC 中切换模型

通过 `SetModel` RPC 在运行时切换当前会话的模型：

```python
client.SetModel(SetModelRequest(model="deepseek/deepseek-coder"))
```

### subagent 调度

当 Agent 通过 `task` 工具调用 subagent 时，路由会根据 subagent 的 label 匹配 `agentModels`。例如：

```
task(label="code-reviewer", prompt="审查 src/auth.ts")
```

会使用 `deepseek/deepseek-coder` 模型。

---

## 沙箱配置

### Profile

| Profile | 文件系统 | 网络 | 子进程 |
|---|---|---|---|
| `Workspace` | 工作区内读写、工作区外拒绝 | 拒绝（仅允许白名单） | 拒绝工作区外 |
| `Custom` | 工作区 + customPaths | 拒绝（仅允许白名单） | 同 Workspace |

### Linux Landlock

Landlock 是 Linux 5.13+ 的内核特性。Nexus 使用 Landlock 限制：
- `read_file`、`write_file`、`remove_file`、`make_dir`、`remove_dir` 等 syscall
- 网络通过 seccomp 过滤（仅允许白名单主机）

如需允许特定 syscall（罕见情况），在 `config.json`：

```json
{
  "sandbox": {
    "profile": "Custom",
    "customPaths": ["/tmp/nexus-shared"],
    "allowNetwork": ["api.anthropic.com", "api.openai.com"]
  }
}
```

### macOS Seatbelt

Seatbelt 是 macOS 的沙箱机制（基于 `sandbox-exec`）。Nexus 生成 `.sb` profile 限制文件系统访问。等价于 Landlock 的功能。

### Windows ISO FS

Windows 没有 Landlock/Seatbelt 等价机制。Nexus 使用 Projected FS（ISO FS）实现降级隔离：
- 创建一个 ISO 文件作为虚拟工作区
- Agent 的所有文件操作重定向到 ISO 内
- 写操作通过 overlay 落到宿主磁盘（隔离区）

**限制**：
- 无法限制网络
- 无法限制子进程访问宿主文件系统（仅隔离 Agent 自身的 IO）
- 需要管理员权限（首次创建 ISO 时）

### 沙箱违规处理

当 Agent 尝试违规操作时，根据 `violationPolicy`：

- `deny`（默认）：拒绝操作，记入 violation 日志
- `warn`：执行但记入日志（不推荐）

violation 日志位置：`~/.nexus/logs/violations.log`

---

## 编程式嵌入

Nexus 的所有 TS 包都是独立可发布的，可以在你的项目中直接 import：

```ts
import { createSandbox } from "@nexus-agent/sandbox";
import { CheckpointStore } from "@nexus-agent/checkpoint";
import { interCompaction, intraCompaction } from "@nexus-agent/compaction";
import { RoutingRegistry } from "@nexus-agent/routing";
import { startServer } from "@nexus-agent/grpc";
```

### 示例：自定义 Agent 嵌入沙箱

```ts
import { createSandbox } from "@nexus-agent/sandbox";

const sandbox = await createSandbox({
  profile: "Workspace",
  workspaceRoot: process.cwd(),
  violationPolicy: "deny",
});

// 写文件（自动受沙箱限制）
await sandbox.writeFile("src/foo.ts", "export const x = 1;");

// 执行 bash 命令（自动受沙箱限制）
const result = await sandbox.exec("ls -la");
console.log(result.stdout);

// 释放沙箱
await sandbox.dispose();
```

### 示例：用 compaction 优化长会话

```ts
import { interCompaction, codeCompaction } from "@nexus-agent/compaction";

const compacted = interCompaction({
  turns: longConversationTurns,
  strategy: "nexus",  // 使用 Grok 移植的算法
  preserveRecent: 5,  // 保留最近 5 轮
});

const withCodeCompacted = codeCompaction(compacted, {
  preserveSignatures: true,
  preserveComments: false,
});

console.log(`Token 节省：${1 - withCodeCompacted.tokens / original.tokens}%`);
```

---

## 下一步

- [用户指南](./user-guide.md) — 给最终用户的基础使用说明
- [迁移指南](./migration-guide.md) — 从 omp 迁移到 Nexus
- [DESIGN.md](../DESIGN.md) — 架构设计与能力映射
- [gRPC proto 定义](../packages/nexus-grpc/proto/nexus.proto) — 协议详情
