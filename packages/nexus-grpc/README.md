# @nexus-agent/grpc

Nexus Agent 的 gRPC server，从 [OpenClaude](https://github.com/) 的 `openclaude.proto` 移植而来。

把 nexus（Nexus Agent）的 agent runtime 通过 gRPC 双向流协议暴露给外部客户端（Python / Go / Rust / VS Code 扩展等），实现跨语言、跨进程的 agent 接入。

## 协议

- **proto 文件**：[`proto/nexus.proto`](./proto/nexus.proto)
- **package**：`nexus`
- **service**：`Nexus`
- **RPC**：`Chat(stream ClientMessage) returns (stream ServerMessage)` —— 双向流

### 消息流

```
客户端                                服务端
  │  ClientMessage{request}            │
  │ ─────────────────────────────────► │  建立会话 + 发起 prompt
  │  ServerMessage{text_chunk}         │
  │ ◄───────────────────────────────── │  流式 token
  │  ServerMessage{tool_start}         │
  │ ◄───────────────────────────────── │  工具开始
  │  ServerMessage{action_required}    │
  │ ◄───────────────────────────────── │  请求权限确认
  │  ClientMessage{input}              │
  │ ─────────────────────────────────► │  应答权限
  │  ServerMessage{tool_result}        │
  │ ◄───────────────────────────────── │  工具结果
  │  ServerMessage{done}               │
  │ ◄───────────────────────────────── │  完成
  │  ClientMessage{cancel}             │
  │ ─────────────────────────────────► │  中止生成
```

### 协议概念映射（Task 5.6）

| 概念            | proto 消息                          | 说明                          |
| --------------- | ----------------------------------- | ----------------------------- |
| `Prompt`        | `ChatRequest`                       | 发起对话                      |
| `SetModel`      | `ChatRequest.model`                 | 指定模型（`provider/model`）  |
| `Abort`         | `CancelSignal`                      | 中止当前生成                  |
| `StreamTokens`  | `ServerMessage.text_chunk`          | 流式文本 token                |
| `ToolPermission`| `ServerMessage.action_required`     | 工具执行前确认（CONFIRM_COMMAND）|
| `ActionRequired`| `ServerMessage.action_required`     | 请求用户信息（REQUEST_INFORMATION）|

## 启动

### 通过 Nexus CLI

```bash
# 默认 localhost:50051
nexus grpc

# 指定端口与地址
nexus grpc --port 50051 --host 0.0.0.0

# 开启破坏性工具确认（bash/write/edit 执行前弹窗确认）
nexus grpc --confirm-destructive
```

### REPL 测试客户端

```bash
# 连接到本地 server，交互式发送 prompt
nexus grpc-cli --port 50051

# 指定模型与会话
nexus grpc-cli --model anthropic/claude-sonnet-4-5 --session my-session
```

REPL 内置命令：
- 直接输入文本 → 发送 `ChatRequest`
- `/abort` → 发送 `CancelSignal`
- `/model <provider/model>` → 切换模型
- `/session <id>` → 切换会话
- `/quit` → 退出

### 编程式启动

```ts
import { startNexusGrpcServer } from "@nexus-agent/grpc";

const server = await startNexusGrpcServer({
  host: "localhost",
  port: 50051,
});
console.log(`listening on ${server.address}`);

// 优雅关闭
await server.shutdown();
```

## 架构

```
┌─────────────────────────────────────────────────────┐
│ gRPC Client (Python/Go/Rust/...)                    │
└───────────────────────┬─────────────────────────────┘
                        │ Chat (bidirectional stream)
┌───────────────────────▼─────────────────────────────┐
│ nexus.Nexus gRPC server (src/server.ts)             │
│  • proto-loader 动态加载 nexus.proto                │
│  • Chat handler: ClientMessage -> NexusSession      │
│  • eventToServerMessage: NexusSessionEvent -> msg   │
└───────────────────────┬─────────────────────────────┘
                        │ adapter 层
┌───────────────────────▼─────────────────────────────┐
│ OmpAgentSession / DefaultSessionManager (adapter)   │
│  • 包装 nexus Agent (prompt/abort/setModel/subscribe) │
│  • AgentEvent -> NexusSessionEvent 翻译             │
│  • beforeToolCall -> ActionRequired 权限拦截        │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ nexus Agent (@oh-my-pi/pi-agent-core)                 │
│  • agentLoop / streamSimple                         │
│  • LLM 调用 + 工具执行                              │
└─────────────────────────────────────────────────────┘
```

nexus 的 `Agent` API（`prompt`/`abort`/`setModel`/`subscribe`）与 OpenClaude 原有会话模型差异较大，因此 `OmpAgentSession` 充当 adapter 层，将 nexus `AgentEvent` 翻译为协议中立的 `NexusSessionEvent`，再由 server 转写为 proto `ServerMessage`。

## 客户端示例

### grpcurl（快速调试）

```bash
# 列出服务
grpcurl -plaintext localhost:50051 list

# 描述 Nexus 服务
grpcurl -plaintext localhost:50051 nexus.Nexus

# 发送 prompt（需要双向流，grpcurl 用 -d 起流）
grpcurl -plaintext -d '{"request":{"message":"hello","working_directory":"."}}' \
  localhost:50051 nexus.Nexus/Chat
```

### Python

依赖：`pip install grpcio grpcio-tools`

```python
import grpc
from concurrent import futures
import nexus_pb2
import nexus_pb2_grpc

# 生成 stub：python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. nexus.proto

def chat(address: str, message: str, model: str | None = None):
    with grpc.insecure_channel(address) as channel:
        stub = nexus_pb2_grpc.NexusStub(channel)

        def request_iter():
            yield nexus_pb2.ClientMessage(
                request=nexus_pb2.ChatRequest(
                    message=message,
                    working_directory=".",
                    model=model or "",
                    session_id="",
                )
            )

        for response in stub.Chat(request_iter()):
            which = response.WhichOneof("event")
            if which == "text_chunk":
                print(response.text_chunk.text, end="", flush=True)
            elif which == "tool_start":
                print(f"\n[工具] {response.tool_start.tool_name}")
            elif which == "action_required":
                reply = input(f"\n{response.action_required.question} (y/n): ")
                yield nexus_pb2.ClientMessage(
                    input=nexus_pb2.UserInput(
                        reply=reply,
                        prompt_id=response.action_required.prompt_id,
                    )
                )
            elif which == "done":
                print(f"\n[完成] tokens: {response.done.completion_tokens}")
            elif which == "error":
                print(f"\n[错误] {response.error.message}")

if __name__ == "__main__":
    chat("localhost:50051", "用 Python 写一个快速排序", "anthropic/claude-sonnet-4-5")
```

### Go

依赖：`go get google.golang.org/grpc` + protoc-gen-go / protoc-gen-go-grpc

```go
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	pb "yourmod/nexus" // 由 protoc --go_out=. --go-grpc_out=. nexus.proto 生成
)

func main() {
	conn, err := grpc.NewClient("localhost:50051",
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	defer conn.Close()

	client := pb.NewNexusClient(conn)
	stream, err := client.Chat(context.Background())
	if err != nil {
		panic(err)
	}

	// 发送首个 ChatRequest
	if err := stream.Send(&pb.ClientMessage{
		Payload: &pb.ClientMessage_Request{
			Request: &pb.ChatRequest{
				Message:          "用 Go 写一个 HTTP server",
				WorkingDirectory: ".",
				Model:            strPtr("anthropic/claude-sonnet-4-5"),
				SessionId:        "",
			},
		},
	}); err != nil {
		panic(err)
	}

	reader := bufio.NewReader(os.Stdin)
	for {
		resp, err := stream.Recv()
		if err != nil {
			break
		}
		switch e := resp.Event.(type) {
		case *pb.ServerMessage_TextChunk:
			fmt.Print(e.TextChunk.Text)
		case *pb.ServerMessage_ToolStart:
			fmt.Printf("\n[工具] %s\n", e.ToolStart.ToolName)
		case *pb.ServerMessage_ActionRequired:
			fmt.Printf("\n%s (y/n): ", e.ActionRequired.Question)
			reply, _ := reader.ReadString('\n')
			stream.Send(&pb.ClientMessage{
				Payload: &pb.ClientMessage_Input{
					Input: &pb.UserInput{
						Reply:   reply,
						PromptId: e.ActionRequired.PromptId,
					},
				},
			})
		case *pb.ServerMessage_Done:
			fmt.Printf("\n[完成] completion_tokens=%d\n", e.Done.CompletionTokens)
			return
		case *pb.ServerMessage_Error:
			fmt.Printf("\n[错误] %s\n", e.Error.Message)
			return
		}
	}
}

func strPtr(s string) *string { return &s }
```

### Rust

依赖：`Cargo.toml`

```toml
[dependencies]
tonic = "0.12"
prost = "0.13"
tokio = { version = "1", features = ["full"] }
tokio-stream = "0.1"
```

由 `tonic-build` 从 `nexus.proto` 生成 stub（`build.rs`）：

```rust
// build.rs
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::compile_protos("proto/nexus.proto")?;
    Ok(())
}
```

```rust
use tonic::transport::Channel;
use tonic::Request;
use tokio_stream::{wrappers::ReceiverStream, StreamExt};
use nexus::nexus_client::NexusClient;
use nexus::client_message::Payload;
use nexus::{ClientMessage, ChatRequest};

pub mod nexus {
    tonic::include_proto!("nexus");
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let channel = Channel::from_static("http://localhost:50051")
        .connect()
        .await?;
    let mut client = NexusClient::new(channel);

    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let stream = ReceiverStream::new(rx);

    // 发送首个 ChatRequest
    tx.send(ClientMessage {
        payload: Some(Payload::Request(ChatRequest {
            message: "用 Rust 写一个 TCP echo server".into(),
            working_directory: ".".into(),
            model: Some("anthropic/claude-sonnet-4-5".into()),
            session_id: "".into(),
        })),
    }).await?;

    let mut response_stream = client.chat(Request::new(stream)).await?.into_inner();

    while let Some(msg) = response_stream.next().await {
        let msg = msg?;
        match msg.event {
            Some(nexus::server_message::Event::TextChunk(chunk)) => {
                print!("{}", chunk.text);
            }
            Some(nexus::server_message::Event::ToolStart(t)) => {
                println!("\n[工具] {}", t.tool_name);
            }
            Some(nexus::server_message::Event::ActionRequired(a)) => {
                println!("\n{}", a.question);
                tx.send(ClientMessage {
                    payload: Some(Payload::Input(nexus::UserInput {
                        reply: "y".into(),
                        prompt_id: a.prompt_id,
                    })),
                }).await?;
            }
            Some(nexus::server_message::Event::Done(d)) => {
                println!("\n[完成] tokens={}", d.completion_tokens);
                break;
            }
            Some(nexus::server_message::Event::Error(e)) => {
                println!("\n[错误] {}", e.message);
                break;
            }
            _ => {}
        }
    }
    Ok(())
}
```

## 测试

```bash
# 运行端到端测试（mock 会话，不依赖真实 LLM）
cd packages/nexus-grpc
bun test
```

测试覆盖：
- `eventToServerMessage` 单元测试（所有事件类型转写）
- `resolveModel` 模型解析回退
- gRPC 端到端：启动 server + 客户端发 ChatRequest，验证流式 TextChunk + FinalResponse
- CancelSignal 中止生成

## 配置

| 选项                    | 说明                                        | 默认值       |
| ----------------------- | ------------------------------------------- | ------------ |
| `--port` / `-p`         | 监听端口                                    | `50051`      |
| `--host` / `-h`         | 监听地址                                    | `localhost`  |
| `--confirm-destructive` | 破坏性工具执行前发 ActionRequired 确认      | 关闭         |

## 依赖

- `@grpc/grpc-js` —— gRPC Node.js 实现
- `@grpc/proto-loader` —— 运行时动态 proto 加载（无需预生成 stub）
- `@oh-my-pi/pi-agent-core` —— nexus Agent runtime（adapter 层对接目标）
- `@oh-my-pi/pi-catalog` —— 模型注册表（解析 `provider/model` 字符串）
