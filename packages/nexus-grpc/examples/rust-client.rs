// Nexus gRPC Rust 客户端示例。
//
// 通过 `Chat` 双向流 RPC 与 Nexus gRPC server 交互：发送一条 prompt，
// 流式接收 text_chunk / tool 事件，并在收到 action_required 时回传 UserInput。
//
// Cargo.toml 依赖：
//   [dependencies]
//   tonic = "0.12"
//   prost = "0.13"
//   tokio = { version = "1", features = ["full"] }
//   tokio-stream = "0.1"
//
// build.rs：
//   fn main() -> Result<(), Box<dyn std::error::Error>> {
//       tonic_build::compile_protos("proto/nexus.proto")?;
//       Ok(())
//   }
//
// 运行：cargo run

use tonic::transport::Channel;
use tonic::Request;
use tokio_stream::{wrappers::ReceiverStream, StreamExt};
use nexus::nexus_client::NexusClient;
use nexus::client_message::Payload;
use nexus::{ChatRequest, ClientMessage};

pub mod nexus {
    tonic::include_proto!("nexus");
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let channel = Channel::from_static("http://localhost:50051").connect().await?;
    let mut client = NexusClient::new(channel);

    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let stream = ReceiverStream::new(rx);

    // 发送首个 ChatRequest
    tx.send(ClientMessage {
        payload: Some(Payload::Request(ChatRequest {
            message: "用 Rust 写一个 TCP echo server".into(),
            working_directory: ".".into(),
            model: Some("anthropic/claude-sonnet-4-5".into()),
            session_id: "rs-demo".into(),
        })),
    })
    .await?;

    let mut response_stream = client.chat(Request::new(stream)).await?.into_inner();

    while let Some(msg) = response_stream.next().await {
        let msg = msg?;
        match msg.event {
            Some(nexus::server_message::Event::TextChunk(chunk)) => {
                print!("{}", chunk.text);
            }
            Some(nexus::server_message::Event::ToolStart(t)) => {
                println!("\n[工具开始] {}", t.tool_name);
            }
            Some(nexus::server_message::Event::ToolResult(r)) => {
                let tag = if r.is_error { "[ERR]" } else { "[OK]" };
                println!("\n[工具结果]{} {}: {}", tag, r.tool_name, r.output);
            }
            Some(nexus::server_message::Event::ActionRequired(a)) => {
                println!("\n[需要操作] {}", a.question);
                tx.send(ClientMessage {
                    payload: Some(Payload::Input(nexus::UserInput {
                        reply: "y".into(),
                        prompt_id: a.prompt_id,
                    })),
                })
                .await?;
            }
            Some(nexus::server_message::Event::Done(d)) => {
                println!(
                    "\n[完成] prompt_tokens={} completion_tokens={}",
                    d.prompt_tokens, d.completion_tokens
                );
                break;
            }
            Some(nexus::server_message::Event::Error(e)) => {
                println!("\n[错误] {}: {}", e.code, e.message);
                break;
            }
            None => {}
        }
    }
    Ok(())
}
