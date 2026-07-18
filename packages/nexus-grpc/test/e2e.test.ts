/**
 * Nexus gRPC 端到端测试。
 *
 * 启动 server（注入 mock 会话工厂，避免真实 LLM 调用）+ gRPC 客户端，
 * 验证双向流 Chat 协议：发送 ChatRequest，接收流式 TextChunk 与 FinalResponse。
 *
 * 由于 Windows 环境无法实际启动带真实 LLM 的 agent，本测试通过 mock
 * `NexusSession` 验证 gRPC 协议栈（proto 加载、双向流、消息转写）的完整性。
 */
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DefaultSessionManager, eventToServerMessage, resolveModel, startNexusGrpcServer } from "../src/server";
import type { NexusSession, NexusSessionEvent, NexusSessionManager, ServerMessage, SessionCreateOptions } from "../src/types";
import { ActionType } from "../src/types";

const PROTO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "proto", "nexus.proto");
const LOADER_OPTIONS = {
	keepCase: false,
	longs: Number,
	enums: Number,
	defaults: true,
	oneofs: true,
};

/**
 * Mock 会话：prompt() 时按预定义 token 序列发出 text_delta 事件，
 * 最后发出 agent_end。用于验证 gRPC 流式协议，不依赖真实 LLM。
 */
class MockSession implements NexusSession {
	readonly id: string;
	readonly cwd: string;
	#listeners = new Set<(event: NexusSessionEvent) => void>();
	#tokens: string[];
	#aborted = false;

	constructor(options: SessionCreateOptions) {
		this.id = options.sessionId || `mock-${Date.now()}`;
		this.cwd = options.workingDirectory || process.cwd();
		this.#tokens = ["Hello", " from", " Nexus", "!"];
	}

	async prompt(_message: string): Promise<void> {
		// 模拟流式 token 输出
		for (const token of this.#tokens) {
			if (this.#aborted) return;
			await Bun.sleep(1);
			this.#emit({ type: "text_delta", text: token });
		}
		const fullText = this.#tokens.join("");
		this.#emit({ type: "agent_end", fullText, promptTokens: 10, completionTokens: 4 });
	}

	abort(): void {
		this.#aborted = true;
	}

	setModel(_modelId: string): void {
		// mock: no-op
	}

	subscribe(listener: (event: NexusSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	resolveUserInput(_promptId: string, _reply: string): boolean {
		return false;
	}

	dispose(): void {
		this.#listeners.clear();
	}

	#emit(event: NexusSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

/** 创建使用 MockSession 的会话管理器。 */
function createMockManager(): NexusSessionManager {
	return new DefaultSessionManager((opts) => new MockSession(opts));
}

/** 加载 proto 并返回 Nexus 客户端构造器。 */
async function loadNexusClient(): Promise<
	new (address: string, credentials: grpc.ChannelCredentials) => {
		Chat: () => grpc.ClientDuplexStream<unknown, unknown>;
		close: () => void;
	}
> {
	const packageDefinition = await protoLoader.load(PROTO_PATH, LOADER_OPTIONS);
	const nexusProto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
		nexus: {
			Nexus: new (address: string, credentials: grpc.ChannelCredentials) => {
				Chat: () => grpc.ClientDuplexStream<unknown, unknown>;
				close: () => void;
			};
		};
	};
	return nexusProto.nexus.Nexus;
}

/** 收集流上的所有 ServerMessage，直到收到 done/error 或超时。 */
function collectStream(
	stream: grpc.ClientDuplexStream<unknown, unknown>,
	timeoutMs = 5000,
): Promise<ServerMessage[]> {
	return new Promise((resolve, reject) => {
		const messages: ServerMessage[] = [];
		const timer = setTimeout(() => {
			reject(new Error(`收集超时（${timeoutMs}ms），已收到 ${messages.length} 条消息`));
		}, timeoutMs);

		stream.on("data", (msg: ServerMessage) => {
			messages.push(msg);
			if (msg.done || msg.error) {
				clearTimeout(timer);
				resolve(messages);
			}
		});
		stream.on("error", (err: Error) => {
			clearTimeout(timer);
			reject(err);
		});
		stream.on("end", () => {
			clearTimeout(timer);
			resolve(messages);
		});
	});
}

describe("eventToServerMessage", () => {
	test("text_delta 转写为 text_chunk", () => {
		const msg = eventToServerMessage({ type: "text_delta", text: "hi" });
		expect(msg).toEqual({ text_chunk: { text: "hi" } });
	});

	test("tool_start 转写为 tool_start", () => {
		const msg = eventToServerMessage({
			type: "tool_start",
			toolName: "bash",
			args: { cmd: "ls" },
			toolUseId: "t1",
		});
		expect(msg?.tool_start).toEqual({
			tool_name: "bash",
			arguments_json: JSON.stringify({ cmd: "ls" }),
			tool_use_id: "t1",
		});
	});

	test("action_required 转写为 action_required", () => {
		const msg = eventToServerMessage({
			type: "action_required",
			action: { prompt_id: "p1", question: "确认?", type: ActionType.CONFIRM_COMMAND },
		});
		expect(msg?.action_required).toEqual({
			prompt_id: "p1",
			question: "确认?",
			type: 0,
		});
	});

	test("agent_end 转写为 done", () => {
		const msg = eventToServerMessage({
			type: "agent_end",
			fullText: "done",
			promptTokens: 5,
			completionTokens: 3,
		});
		expect(msg?.done).toEqual({ full_text: "done", prompt_tokens: 5, completion_tokens: 3 });
	});

	test("turn_end 不产生对外消息", () => {
		const msg = eventToServerMessage({
			type: "turn_end",
			fullText: "",
			promptTokens: 0,
			completionTokens: 0,
		});
		expect(msg).toBeNull();
	});
});

describe("resolveModel", () => {
	test("未指定模型时回退到默认模型", () => {
		const model = resolveModel();
		expect(model).toBeDefined();
		expect(typeof model.id).toBe("string");
	});

	test("无效模型标识也回退到默认（不抛异常）", () => {
		const model = resolveModel("nonexistent/fake-model");
		expect(model).toBeDefined();
	});
});

describe("Nexus gRPC 端到端", () => {
	let serverHandle: { address: string; shutdown: () => Promise<void> } | undefined;

	beforeEach(() => {
		serverHandle = undefined;
	});

	afterEach(async () => {
		if (serverHandle) await serverHandle.shutdown();
	});

	test("ChatRequest -> 流式 TextChunk -> FinalResponse", async () => {
		// 选取随机空闲端口启动 server
		serverHandle = await startNexusGrpcServer({
			host: "127.0.0.1",
			port: 0,
			sessionManagerFactory: createMockManager,
		});

		const NexusClient = await loadNexusClient();
		const client = new NexusClient(serverHandle.address, grpc.credentials.createInsecure());
		try {
			const stream = client.Chat();
			const collectPromise = collectStream(stream);

			// 发送 ChatRequest
			stream.write({
				request: {
					message: "ping",
					working_directory: process.cwd(),
					session_id: "e2e-test",
				},
			});

			const messages = await collectPromise;

			// 验证收到流式 text_chunk
			const textChunks = messages.filter((m) => m.text_chunk).map((m) => m.text_chunk!.text);
			expect(textChunks.join("")).toBe("Hello from Nexus!");

			// 验证收到 done
			const done = messages.find((m) => m.done);
			expect(done).toBeDefined();
			expect(done?.done?.full_text).toBe("Hello from Nexus!");
			expect(done?.done?.completion_tokens).toBe(4);
		} finally {
			client.close();
		}
	}, 10000);

	test("CancelSignal 中止生成", async () => {
		serverHandle = await startNexusGrpcServer({
			host: "127.0.0.1",
			port: 0,
			sessionManagerFactory: createMockManager,
		});

		const NexusClient = await loadNexusClient();
		const client = new NexusClient(serverHandle.address, grpc.credentials.createInsecure());
		try {
			const stream = client.Chat();
			// 发送请求后立即取消
			stream.write({
				request: {
					message: "long running task",
					working_directory: process.cwd(),
					session_id: "cancel-test",
				},
			});
			stream.write({ cancel: { reason: "用户取消" } });

			// 等待流结束（取消后 mock 不再发 token，流应正常结束或收到部分消息）
			const messages = await collectStream(stream, 3000).catch(() => [] as ServerMessage[]);
			// 取消后不应收到完整 done（或只收到部分 token）
			const done = messages.find((m) => m.done);
			// mock 在 abort 后立即返回，不会发 agent_end，所以 done 应为 undefined
			expect(done).toBeUndefined();
		} finally {
			client.close();
		}
	}, 10000);
});
