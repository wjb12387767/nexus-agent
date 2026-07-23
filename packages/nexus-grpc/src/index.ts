/**
 * @nexus-agent/grpc —— 公共 API 导出。
 *
 * 消费者（如 `packages/coding-agent` 的 `grpc` 子命令）应从此处导入：
 *
 * ```ts
 * import { startNexusGrpcServer } from "@nexus-agent/grpc";
 * const server = await startNexusGrpcServer({ port: 50051 });
 * ```
 */

// gRPC server 启动函数与适配层实现
// startServer 为 startNexusGrpcServer 的别名，对齐 docs/integration-guide.md
// 中 `import { startServer } from "@nexus-agent/grpc"` 的用法。
export {
	startNexusGrpcServer,
	startNexusGrpcServer as startServer,
	resolveModel,
	eventToServerMessage,
	OmpAgentSession,
	DefaultSessionManager,
} from "./server";
// 编程式客户端
export { createClient } from "./client";
export type { NexusClient } from "./client";
// CLI 入口（启动 server / REPL 客户端）
export { runGrpcCli } from "./cli";
export { runGrpcClientRepl } from "./cli-client";
// ActionType 既是值（枚举对象）又是类型
export { ActionType } from "./types";
// 类型定义
export type {
	AbortResponse,
	ActionRequired,
	CancelSignal,
	ChatRequest,
	ClientMessage,
	ErrorResponse,
	FinalResponse,
	NexusGrpcServer,
	NexusGrpcServerOptions,
	NexusSession,
	NexusSessionEvent,
	NexusSessionManager,
	PromptResponse,
	ServerMessage,
	SessionCreateOptions,
	SetModelResponse,
	TextChunk,
	TokenChunk,
	ToolCallResult,
	ToolCallStart,
	UserInput,
} from "./types";
