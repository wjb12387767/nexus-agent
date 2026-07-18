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
export { startNexusGrpcServer, resolveModel, eventToServerMessage, OmpAgentSession, DefaultSessionManager } from "./server";
// CLI 入口（启动 server / REPL 客户端）
export { runGrpcCli } from "./cli";
export { runGrpcClientRepl } from "./cli-client";
// ActionType 既是值（枚举对象）又是类型
export { ActionType } from "./types";
// 类型定义
export type {
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
	ServerMessage,
	SessionCreateOptions,
	TextChunk,
	ToolCallResult,
	ToolCallStart,
	UserInput,
} from "./types";
