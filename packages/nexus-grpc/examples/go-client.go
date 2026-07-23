// Nexus gRPC Go 客户端示例。
//
// 通过 `Chat` 双向流 RPC 与 Nexus gRPC server 交互：发送一条 prompt，
// 流式接收 text_chunk / tool 事件，并在收到 action_required 时回传 UserInput。
//
// 依赖：
//   go get google.golang.org/grpc
//   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
//   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
//
// 生成 stub（将 proto/nexus.proto 拷贝到本目录后执行）：
//   protoc --go_out=. --go-grpc_out=. nexus.proto
//
// 运行：
//   go run go-client.go
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "yourmod/nexus" // 由 protoc 生成，按实际 module 路径替换
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
				SessionId:        "go-demo",
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
			fmt.Printf("\n[工具开始] %s\n", e.ToolStart.ToolName)
		case *pb.ServerMessage_ToolResult:
			tag := "[OK]"
			if e.ToolResult.IsError {
				tag = "[ERR]"
			}
			fmt.Printf("\n[工具结果]%s %s: %s\n", tag, e.ToolResult.ToolName, e.ToolResult.Output)
		case *pb.ServerMessage_ActionRequired:
			fmt.Printf("\n[需要操作] %s (y/n): ", e.ActionRequired.Question)
			reply, _ := reader.ReadString('\n')
			if err := stream.Send(&pb.ClientMessage{
				Payload: &pb.ClientMessage_Input{
					Input: &pb.UserInput{
						Reply:   reply,
						PromptId: e.ActionRequired.PromptId,
					},
				},
			}); err != nil {
				fmt.Fprintf(os.Stderr, "发送应答失败: %v\n", err)
			}
		case *pb.ServerMessage_Done:
			fmt.Printf("\n[完成] prompt_tokens=%d completion_tokens=%d\n",
				e.Done.PromptTokens, e.Done.CompletionTokens)
			return
		case *pb.ServerMessage_Error:
			fmt.Printf("\n[错误] %s: %s\n", e.Error.Code, e.Error.Message)
			return
		}
	}
}

func strPtr(s string) *string { return &s }
