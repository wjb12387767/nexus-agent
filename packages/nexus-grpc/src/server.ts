/**
 * Nexus gRPC server —— 核心实现。
 *
 * 本模块完成两件事：
 * 1. 适配层（`OmpAgentSession` / `DefaultSessionManager`）：将 omp 的
 *    `Agent` 类（来自 `@oh-my-pi/pi-agent-core`）包装为协议中立的
 *    `NexusSession`，并把 omp `AgentEvent` 翻译为 `NexusSessionEvent`。
 *    omp 的 Agent API（prompt/abort/setModel/subscribe）与 OpenClaude 原有
 *    会话模型差异较大，因此必须经过此 adapter 层，而非直接对接。
 * 2. gRPC server（`startNexusGrpcServer`）：用 `@grpc/proto-loader` 动态
 *    加载 `proto/nexus.proto`，注册 `Nexus.Chat` 双向流 RPC，把
 *    `ClientMessage`（ChatRequest/UserInput/CancelSignal）派发给会话，
 *    把 `NexusSessionEvent` 转写为 `ServerMessage`（TextChunk/ToolCallStart/
 *    ToolCallResult/ActionRequired/FinalResponse/ErrorResponse）回传客户端。
 *
 * 协议概念映射（Task 5.6）：
 *   Prompt          -> ChatRequest -> session.prompt()
 *   SetModel        -> ChatRequest.model / 后续 UserInput
 *   Abort           -> CancelSignal -> session.abort()
 *   StreamTokens    -> TextChunk（由 message_update text_delta 投影）
 *   ToolPermission  -> ActionRequired(CONFIRM_COMMAND)（beforeToolCall 拦截）
 *   ActionRequired  -> ActionRequired(REQUEST_INFORMATION)
 */
import protoLoader from "@grpc/proto-loader";
import grpc from "@grpc/grpc-js";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentEvent, BeforeToolCallContext, BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-ai";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
	ActionRequired,
	ChatRequest,
	ClientMessage,
	FinalResponse,
	NexusGrpcServer,
	NexusGrpcServerOptions,
	NexusSession,
	NexusSessionEvent,
	NexusSessionManager,
	ServerMessage,
	SessionCreateOptions,
} from "./types";
import { ActionType } from "./types";

const PROTO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "proto", "nexus.proto");

/** 默认模型标识，当客户端未指定或解析失败时使用。 */
const DEFAULT_MODEL_PROVIDER = "google" as const;
const DEFAULT_MODEL_ID = "gemini-2.5-flash-lite-preview-06-17";

/** 需要确认的破坏性工具名集合（默认空 = 全部自动放行）。 */
const DESTRUCTIVE_TOOL_NAMES = new Set(["bash", "powershell", "write", "edit"]);

// ============================================================
// 模型解析
// ============================================================

/**
 * 将 "provider/model" 字符串解析为 omp `Model` 对象。
 * 解析失败时回退到默认模型，保证 server 始终可启动。
 */
export function resolveModel(modelId?: string): Model {
	// 1. 显式 "provider/model" 形式
	if (modelId && modelId.includes("/")) {
		const slash = modelId.indexOf("/");
		const provider = modelId.slice(0, slash) as Parameters<typeof getBundledModel>[0];
		const id = modelId.slice(slash + 1);
		const m = getBundledModel(provider, id);
		if (m) return m;
	}
	// 2. 仅 model id：跨 provider 搜索
	if (modelId) {
		for (const provider of getBundledProviders()) {
			const models = getBundledModels(provider);
			const hit = models.find(m => m.id === modelId);
			if (hit) return hit;
		}
	}
	// 3. 回退默认
	return getBundledModel(DEFAULT_MODEL_PROVIDER, DEFAULT_MODEL_ID);
}

// ============================================================
// 适配层：OmpAgentSession
// ============================================================

/**
 * omp `Agent` 适配器：实现 `NexusSession`。
 *
 * 负责：
 * - 构造 omp `Agent`（默认模型 / 注入 streamFn / cwd / sessionId）
 * - 持久订阅 omp `AgentEvent`，翻译为 `NexusSessionEvent` 并广播
 * - 维护 pending ActionRequired 提问表，支持 `resolveUserInput`
 * - 通过 `beforeToolCall` 钩子拦截破坏性工具，发出 ToolPermission 请求
 */
export class OmpAgentSession implements NexusSession {
	readonly id: string;
	readonly cwd: string;
	#agent: Agent;
	#listeners = new Set<(event: NexusSessionEvent) => void>();
	#pendingPrompts = new Map<string, (reply: string) => void>();
	#fullText = "";
	#promptTokens = 0;
	#completionTokens = 0;
	#confirmDestructive: boolean;
	#streamFn?: Agent["streamFn"];

	constructor(options: SessionCreateOptions & {
		confirmDestructive?: boolean;
		streamFn?: Agent["streamFn"];
	}) {
		this.id = options.sessionId || `nexus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.cwd = options.workingDirectory || process.cwd();
		this.#confirmDestructive = options.confirmDestructive ?? false;
		this.#streamFn = options.streamFn;
		const model = resolveModel(options.model);
		const agentOpts: ConstructorParameters<typeof Agent>[0] = {
			initialState: { model, tools: [], messages: [], systemPrompt: [] },
			cwd: this.cwd,
			sessionId: this.id,
			beforeToolCall: this.#beforeToolCall.bind(this),
		};
		if (this.#streamFn) agentOpts.streamFn = this.#streamFn;
		this.#agent = new Agent(agentOpts);
		// 持久订阅 omp 事件，翻译并广播给会话监听者
		this.#agent.subscribe(event => this.#translateAndEmit(event));
	}

	/** 发送一条 prompt。 */
	async prompt(message: string): Promise<void> {
		// 每轮重置累计文本与 token 计数
		this.#fullText = "";
		this.#promptTokens = 0;
		this.#completionTokens = 0;
		await this.#agent.prompt(message);
	}

	/** 中止当前生成。 */
	abort(): void {
		this.#agent.abort();
	}

	/** 切换模型。 */
	setModel(modelId: string): void {
		const model = resolveModel(modelId);
		this.#agent.setModel(model);
	}

	/** 订阅会话事件。 */
	subscribe(listener: (event: NexusSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** 应答 pending 的 ActionRequired。 */
	resolveUserInput(promptId: string, reply: string): boolean {
		const resolver = this.#pendingPrompts.get(promptId);
		if (resolver) {
			this.#pendingPrompts.delete(promptId);
			resolver(reply);
			return true;
		}
		return false;
	}

	/** 销毁会话。 */
	dispose(): void {
		this.#listeners.clear();
		for (const [, resolver] of this.#pendingPrompts) resolver("");
		this.#pendingPrompts.clear();
		this.#agent.reset();
	}

	#emit(event: NexusSessionEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// 监听者异常不应影响其它监听者
			}
		}
	}

	/**
	 * beforeToolCall 钩子：对破坏性工具发出 ToolPermission（CONFIRM_COMMAND）请求，
	 * 阻塞等待客户端 UserInput 应答。确认通过则放行（返回 undefined），
	 * 否则返回 { block: true } 阻止该工具执行。
	 */
	async #beforeToolCall(ctx: BeforeToolCallContext, _signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
		if (!this.#confirmDestructive) return undefined;
		const toolName = ctx?.toolCall?.name;
		if (typeof toolName !== "string" || !DESTRUCTIVE_TOOL_NAMES.has(toolName)) return undefined;
		const promptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const argsPreview = ctx?.args ? safeStringify(ctx.args).slice(0, 200) : "";
		const question = `确认执行工具 "${toolName}"? ${argsPreview}`.trim();
		const action: ActionRequired = {
			prompt_id: promptId,
			question,
			type: ActionType.CONFIRM_COMMAND,
		};
		this.#emit({ type: "action_required", action });
		const reply = await new Promise<string>(resolve => {
			this.#pendingPrompts.set(promptId, resolve);
		});
		const approved = reply.trim().toLowerCase() === "y" || reply.trim().toLowerCase() === "yes";
		if (!approved) {
			return { block: true, reason: `工具 "${toolName}" 被用户拒绝` };
		}
		return undefined;
	}

	/**
	 * 将 omp `AgentEvent` 翻译为 `NexusSessionEvent` 并累计 token / 全文。
	 */
	#translateAndEmit(event: AgentEvent): void {
		switch (event.type) {
			case "message_update": {
				const ame = event.assistantMessageEvent;
				if (ame.type === "text_delta" && typeof ame.delta === "string") {
					this.#fullText += ame.delta;
					this.#emit({ type: "text_delta", text: ame.delta });
				}
				if (ame.type === "toolcall_end" && ame.toolCall) {
					this.#emit({
						type: "tool_start",
						toolName: ame.toolCall.name,
						args: ame.toolCall.arguments,
						toolUseId: ame.toolCall.id,
					});
				}
				break;
			}
			case "tool_execution_start":
				this.#emit({
					type: "tool_start",
					toolName: event.toolName,
					args: event.args,
					toolUseId: event.toolCallId,
				});
				break;
			case "tool_execution_end":
				this.#emit({
					type: "tool_end",
					toolName: event.toolName,
					result: event.result,
					isError: event.isError === true,
					toolUseId: event.toolCallId,
				});
				break;
			case "message_end": {
				const msg = event.message as { role?: string; usage?: { input?: number; output?: number } };
				if (msg?.role === "assistant" && msg.usage) {
					this.#promptTokens += msg.usage.input ?? 0;
					this.#completionTokens += msg.usage.output ?? 0;
				}
				break;
			}
			case "turn_end": {
				this.#emit({
					type: "turn_end",
					fullText: this.#fullText,
					promptTokens: this.#promptTokens,
					completionTokens: this.#completionTokens,
				});
				break;
			}
			case "agent_end":
				this.#emit({
					type: "agent_end",
					fullText: this.#fullText,
					promptTokens: this.#promptTokens,
					completionTokens: this.#completionTokens,
				});
				break;
		}
	}
}

// ============================================================
// 适配层：DefaultSessionManager
// ============================================================

/**
 * 默认会话管理器：维护 sessionId -> NexusSession 映射。
 * 支持跨流会话持久化（非空 session_id 复用既有会话）。
 */
export class DefaultSessionManager implements NexusSessionManager {
	#sessions = new Map<string, NexusSession>();
	#sessionFactory: (options: SessionCreateOptions) => NexusSession;

	constructor(sessionFactory?: (options: SessionCreateOptions) => NexusSession) {
		this.#sessionFactory = sessionFactory ?? ((opts) => new OmpAgentSession(opts));
	}

	getOrCreate(options: SessionCreateOptions): NexusSession {
		const id = options.sessionId;
		if (id) {
			const existing = this.#sessions.get(id);
			if (existing) {
				if (options.model) existing.setModel(options.model);
				return existing;
			}
		}
		const session = this.#sessionFactory(options);
		this.#sessions.set(session.id, session);
		return session;
	}

	get(sessionId: string): NexusSession | undefined {
		return this.#sessions.get(sessionId);
	}

	dispose(sessionId: string): void {
		const session = this.#sessions.get(sessionId);
		if (session) {
			session.dispose();
			this.#sessions.delete(sessionId);
		}
	}

	disposeAll(): void {
		for (const [, session] of this.#sessions) session.dispose();
		this.#sessions.clear();
	}
}

// ============================================================
// 事件 -> ServerMessage 转写
// ============================================================

/**
 * 将 `NexusSessionEvent` 转写为 proto `ServerMessage`。
 * 返回 null 表示该事件不产生对外消息（如 turn_end 在流式协议中不单独发送）。
 */
export function eventToServerMessage(event: NexusSessionEvent): ServerMessage | null {
	switch (event.type) {
		case "text_delta":
			return { text_chunk: { text: event.text } };
		case "tool_start":
			return {
				tool_start: {
					tool_name: event.toolName,
					arguments_json: safeStringify(event.args),
					tool_use_id: event.toolUseId,
				},
			};
		case "tool_end":
			return {
				tool_result: {
					tool_name: event.toolName,
					output: safeStringify(event.result),
					is_error: event.isError,
					tool_use_id: event.toolUseId,
				},
			};
		case "action_required":
			return { action_required: event.action };
		case "agent_end":
			return {
				done: {
					full_text: event.fullText,
					prompt_tokens: event.promptTokens,
					completion_tokens: event.completionTokens,
				} satisfies FinalResponse,
			};
		case "error":
			return { error: { message: event.message, code: event.code ?? "INTERNAL" } };
		case "turn_end":
			// 流式协议中 turn_end 不单独发送，由 agent_end 终结
			return null;
	}
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// ============================================================
// gRPC server
// ============================================================

/** proto-loader 加载选项。 */
const LOADER_OPTIONS = {
	keepCase: false, // proto 字段转 camelCase（message -> message, working_directory -> workingDirectory）
	longs: Number,
	enums: Number,
	defaults: true,
	oneofs: true,
};

/**
 * 启动 Nexus gRPC server。
 *
 * @returns server 句柄，可调用 `shutdown()` 优雅关闭。
 */
export async function startNexusGrpcServer(options: NexusGrpcServerOptions = {}): Promise<NexusGrpcServer> {
	const host = options.host ?? "localhost";
	const port = options.port ?? 50051;

	const packageDefinition = await protoLoader.load(PROTO_PATH, LOADER_OPTIONS);
	const nexusProto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
		nexus: { Nexus: { service: grpc.ServiceDefinition<unknown> } };
	};

	const manager: NexusSessionManager = options.sessionManagerFactory
		? options.sessionManagerFactory()
		: new DefaultSessionManager(
				options.sessionFactory
					? (opts) => options.sessionFactory!(opts)
					: undefined,
			);

	/**
	 * Chat 双向流处理器。
	 * 每个 gRPC 流对应一个客户端会话；首个 ChatRequest 建立会话，
	 * 后续 CancelSignal/UserInput 派发给该会话。
	 */
	const chat = (call: grpc.ServerDuplexStream<unknown, unknown>): void => {
		let session: NexusSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let streamEnded = false;

		const cleanup = (): void => {
			if (streamEnded) return;
			streamEnded = true;
			unsubscribe?.();
			unsubscribe = undefined;
			if (session) {
				manager.dispose(session.id);
				session = undefined;
			}
		};

		call.on("error", (err: Error) => {
			cleanup();
		});
		call.on("end", () => {
			cleanup();
			call.end();
		});

		call.on("data", (clientMessage: ClientMessage) => {
			void handleClientMessage(clientMessage).catch((err: Error) => {
				writeError(call, err, "INTERNAL");
			});
		});

		async function handleClientMessage(clientMessage: ClientMessage): Promise<void> {
			// ChatRequest —— 建立或复用会话并发起 prompt
			if (clientMessage.request) {
				const req = clientMessage.request as ChatRequest;
				const createOpts: SessionCreateOptions = {
					message: req.message,
					workingDirectory: req.working_directory,
					model: req.model,
					sessionId: req.session_id,
				};
				session = manager.getOrCreate(createOpts);
				// 订阅会话事件并转写为 ServerMessage 回传
				unsubscribe?.();
				unsubscribe = session.subscribe(event => {
					const msg = eventToServerMessage(event);
					if (msg) writeMessage(call, msg);
				});
				try {
					await session.prompt(req.message);
				} catch (err) {
					writeError(call, err instanceof Error ? err : new Error(String(err)), "PROMPT_FAILED");
				}
				return;
			}

			// CancelSignal —— 中止当前生成
			if (clientMessage.cancel) {
				session?.abort();
				return;
			}

			// UserInput —— 应答 pending ActionRequired
			if (clientMessage.input && session) {
				const ok = session.resolveUserInput(clientMessage.input.prompt_id, clientMessage.input.reply);
				if (!ok) {
					writeError(call, new Error(`未找到 prompt_id: ${clientMessage.input.prompt_id}`), "UNKNOWN_PROMPT");
				}
				return;
			}
		}
	};

	const server = new grpc.Server();
	server.addService(nexusProto.nexus.Nexus.service, { Chat: chat });

	return new Promise<NexusGrpcServer>((resolve, reject) => {
		server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
			if (err) {
				reject(err);
				return;
			}
			resolve({
				address: `${host}:${boundPort}`,
				shutdown: () =>
					new Promise<void>((res, rej) => {
						manager.disposeAll();
						server.tryShutdown((shutdownErr) => {
							if (shutdownErr) rej(shutdownErr);
							else res();
						});
					}),
			});
		});
	});
}

// ============================================================
// gRPC 写入辅助
// ============================================================

function writeMessage(call: grpc.ServerDuplexStream<unknown, unknown>, message: ServerMessage): void {
	try {
		call.write(message);
	} catch {
		// 流已关闭，忽略写入错误
	}
}

function writeError(call: grpc.ServerDuplexStream<unknown, unknown>, err: Error, code: string): void {
	writeMessage(call, { error: { message: err.message, code } });
}
