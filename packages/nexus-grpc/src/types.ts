/**
 * Nexus gRPC 类型定义。
 *
 * 这些类型与 `proto/nexus.proto` 中的消息一一对应，作为 @grpc/proto-loader
 * 动态加载结果在 TS 侧的强类型镜像。同时定义了 omp `Agent` 适配层所需的
 * 会话管理与工厂类型。
 */

// ---------------------------------------------------------
// proto 消息镜像（ClientMessage / 输入侧）
// ---------------------------------------------------------

/** 客户端 -> 服务端：初始对话请求。对应 proto ChatRequest。 */
export interface ChatRequest {
	message: string;
	working_directory: string;
	model?: string;
	session_id: string;
}

/** 客户端 -> 服务端：对 ActionRequired 提问的应答。对应 proto UserInput。 */
export interface UserInput {
	reply: string;
	prompt_id: string;
}

/** 客户端 -> 服务端：中断信号。对应 proto CancelSignal。 */
export interface CancelSignal {
	reason: string;
}

/** 客户端消息 oneof 包装。对应 proto ClientMessage。 */
export interface ClientMessage {
	request?: ChatRequest;
	input?: UserInput;
	cancel?: CancelSignal;
}

// ---------------------------------------------------------
// proto 消息镜像（ServerMessage / 输出侧）
// ---------------------------------------------------------

export interface TextChunk {
	text: string;
}

export interface ToolCallStart {
	tool_name: string;
	arguments_json: string;
	tool_use_id: string;
}

export interface ToolCallResult {
	tool_name: string;
	output: string;
	is_error: boolean;
	tool_use_id: string;
}

/** ActionRequired.action_type 枚举。 */
export const ActionType = {
	CONFIRM_COMMAND: 0,
	REQUEST_INFORMATION: 1,
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

export interface ActionRequired {
	prompt_id: string;
	question: string;
	type: ActionType;
}

export interface FinalResponse {
	full_text: string;
	prompt_tokens: number;
	completion_tokens: number;
}

export interface ErrorResponse {
	message: string;
	code: string;
}

/** 服务端消息 oneof 包装。对应 proto ServerMessage。 */
export interface ServerMessage {
	text_chunk?: TextChunk;
	tool_start?: ToolCallStart;
	tool_result?: ToolCallResult;
	action_required?: ActionRequired;
	done?: FinalResponse;
	error?: ErrorResponse;
}

// ---------------------------------------------------------
// 适配层类型
// ---------------------------------------------------------

/**
 * 会话工厂选项：构造一个 omp `Agent` 会话所需的全部入参。
 * gRPC server 通过 `SessionManager.create(options)` 创建会话；
 * 默认实现使用 omp `Agent`，测试可注入 mock 工厂。
 */
export interface SessionCreateOptions {
	/** 用户消息文本。 */
	message: string;
	/** 工作目录。 */
	workingDirectory: string;
	/** 可选模型标识（如 "anthropic/claude-sonnet-4-5"），留空使用默认。 */
	model?: string;
	/** 跨流会话 ID。非空时复用既有会话。 */
	sessionId?: string;
}

/**
 * 已创建的 Nexus 会话句柄。封装 omp `Agent` 并暴露 gRPC 协议所需的最小接口。
 * 适配层（`src/server.ts` 中的 `OmpAgentSession`）实现此接口。
 */
export interface NexusSession {
	/** 会话 ID。 */
	readonly id: string;
	/** 当前工作目录。 */
	readonly cwd: string;
	/** 发送一条 prompt，返回流式事件迭代器（omp AgentEvent）。 */
	prompt(message: string): Promise<void>;
	/** 中止当前生成。 */
	abort(): void;
	/** 切换模型。 */
	setModel(modelId: string): void;
	/** 订阅 agent 事件，返回取消订阅函数。 */
	subscribe(listener: (event: NexusSessionEvent) => void): () => void;
	/**
	 * 应答一个 pending 的 ActionRequired 提问。
	 * @returns true 若 promptId 匹配且已应答；false 若无此 pending 提问。
	 */
	resolveUserInput(promptId: string, reply: string): boolean;
	/** 销毁会话，释放底层资源。 */
	dispose(): void;
}

/**
 * 会话事件：omp `AgentEvent` 的协议中立投影。
 * 适配层将 omp 的 `AgentEvent` 翻译为这一统一形状，便于 gRPC server 转换为
 * `ServerMessage`。覆盖 Prompt/StreamTokens/ToolPermission/ActionRequired 概念。
 */
export type NexusSessionEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_start"; toolName: string; args: unknown; toolUseId: string }
	| { type: "tool_end"; toolName: string; result: unknown; isError: boolean; toolUseId: string }
	| { type: "action_required"; action: ActionRequired }
	| { type: "turn_end"; fullText: string; promptTokens: number; completionTokens: number }
	| { type: "agent_end"; fullText: string; promptTokens: number; completionTokens: number }
	| { type: "error"; message: string; code?: string };

/**
 * 会话管理器：维护 sessionId -> NexusSession 映射，负责创建/复用/销毁。
 * gRPC server 持有一个管理器实例；每个 gRPC 双向流对应一次 `getOrCreate`。
 */
export interface NexusSessionManager {
	/** 按 sessionId 复用既有会话，或创建新会话。 */
	getOrCreate(options: SessionCreateOptions): NexusSession;
	/** 按 id 获取既有会话。 */
	get(sessionId: string): NexusSession | undefined;
	/** 销毁指定会话。 */
	dispose(sessionId: string): void;
	/** 销毁全部会话。 */
	disposeAll(): void;
}

/** gRPC server 启动选项。 */
export interface NexusGrpcServerOptions {
	/** 监听地址，默认 "localhost"。 */
	host?: string;
	/** 监听端口，默认 50051。 */
	port?: number;
	/** 可选的会话管理器工厂，用于注入测试桩。 */
	sessionManagerFactory?: () => NexusSessionManager;
	/** 可选的会话工厂，用于注入测试桩（覆盖默认 omp Agent 适配）。 */
	sessionFactory?: (options: SessionCreateOptions) => NexusSession;
}

/** gRPC server 句柄。 */
export interface NexusGrpcServer {
	/** 实际监听地址（启动后填充）。 */
	readonly address: string;
	/** 优雅关闭。 */
	shutdown(): Promise<void>;
}

// ---------------------------------------------------------
// 编程式客户端类型（src/client.ts）
// ---------------------------------------------------------

/**
 * `streamTokens` 产生的 token 块。
 *
 * 注：proto 中流式文本通过 `ServerMessage.text_chunk` 投影；此处 `TokenChunk`
 * 是编程式客户端为 `streamTokens` 便捷方法提供的带序号视图。
 */
export interface TokenChunk {
	/** token 文本。 */
	text: string;
	/** 该块在流中的序号（从 0 起）。 */
	index: number;
}

/**
 * `prompt` 便捷方法的响应：聚合完整文本与完成轮数。
 *
 * 对应 proto 中一次 Chat 流收齐后的汇总结果。
 */
export interface PromptResponse {
	/** 聚合后的完整文本。 */
	text: string;
	/** 会话 ID。 */
	sessionId: string;
	/** 完成的 agent 轮数。 */
	turnsCompleted: number;
}

/**
 * `setModel` 便捷方法的响应。
 *
 * 在收敛后的协议中模型由 `ChatRequest.model` 指定，故 `setModel` 仅在客户端
 * 记录偏好、作用于后续 `prompt` / `streamTokens` 调用，不发起独立 RPC。
 */
export interface SetModelResponse {
	/** 是否设置成功。 */
	success: boolean;
	/** 失败时的错误描述。 */
	error: string;
}

/**
 * `abort` 便捷方法的响应。
 *
 * 在收敛后的协议中，中止通过在活动的 Chat 流上发送 `CancelSignal` 完成；
 * 若无活动流则返回 `success: false`。
 */
export interface AbortResponse {
	/** 是否成功发送中止信号。 */
	success: boolean;
}
