#!/usr/bin/env python3
"""Nexus gRPC Python 客户端示例。

通过 `Chat` 双向流 RPC 与 Nexus gRPC server 交互：发送一条 prompt，
流式接收 text_chunk / tool 事件，并在收到 action_required 时回传 UserInput。

依赖：pip install grpcio grpcio-tools

生成 stub（将 proto/nexus.proto 拷贝到本目录后执行）：
    python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. nexus.proto

用法：
    python python-client.py "用 Python 写一个快速排序"
"""
import queue
import sys

import grpc

import nexus_pb2
import nexus_pb2_grpc


def chat(address: str, message: str, model: str = "", session_id: str = "py-demo") -> None:
    with grpc.insecure_channel(address) as channel:
        stub = nexus_pb2_grpc.NexusStub(channel)

        # 用队列驱动请求迭代器：主循环把 ClientMessage 推入队列，
        # gRPC 在独立线程消费该迭代器；None 作为结束哨兵。
        q: "queue.Queue[object]" = queue.Queue()
        q.put(
            nexus_pb2.ClientMessage(
                request=nexus_pb2.ChatRequest(
                    message=message,
                    working_directory=".",
                    model=model,
                    session_id=session_id,
                )
            )
        )

        def request_iter():
            while True:
                item = q.get()
                if item is None:
                    return
                yield item

        stream = stub.Chat(request_iter())
        try:
            for response in stream:
                kind = response.WhichOneof("event")
                if kind == "text_chunk":
                    print(response.text_chunk.text, end="", flush=True)
                elif kind == "tool_start":
                    print(f"\n[工具开始] {response.tool_start.tool_name}")
                elif kind == "tool_result":
                    tag = "[ERR]" if response.tool_result.is_error else "[OK]"
                    print(f"\n[工具结果]{tag} {response.tool_result.tool_name}: {response.tool_result.output}")
                elif kind == "action_required":
                    a = response.action_required
                    print(f"\n[需要操作] ({a.type}) {a.question}")
                    # 危险命令拒绝，其它放行
                    allow = "rm -rf" not in a.question
                    q.put(
                        nexus_pb2.ClientMessage(
                            input=nexus_pb2.UserInput(
                                reply="y" if allow else "n",
                                prompt_id=a.prompt_id,
                            )
                        )
                    )
                elif kind == "done":
                    print(
                        f"\n[完成] prompt_tokens={response.done.prompt_tokens} "
                        f"completion_tokens={response.done.completion_tokens}"
                    )
                    break
                elif kind == "error":
                    print(f"\n[错误] {response.error.code}: {response.error.message}")
                    break
        finally:
            q.put(None)  # 结束请求迭代器


if __name__ == "__main__":
    msg = sys.argv[1] if len(sys.argv) > 1 else "你好"
    chat("localhost:50051", msg, model="anthropic/claude-sonnet-4-5")
