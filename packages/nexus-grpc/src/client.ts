/**
 * Nexus gRPC 编程式客户端。
 *
 * `createClient(address)` 返回一个 `NexusClient`，封装 `nexus.Nexus.Chat`
 * 双向流 RPC，提供面向常用场景的便捷方法：
 *
 * - `chat(messages)`：底层双向流，传入 `ClientMessage` 异步迭代器，产出
 *   `ServerMessage`。需要中途取消 / 应答权限请求时使用此方法。
 * - `prompt(sessionId, text)`：一次性 prompt，阻塞到收到 `done`，返回聚合文本。
 * - `streamTokens(sessionId, text)`：一次性 prompt，按到达顺序产出 `TokenChunk`。
 * - `setModel(sessionId, model)`：记录模型偏好，作用于后续 prompt / streamTokens。
 * - `abort(sessionId)`：向活动流发送 `CancelSignal`（若无活动流返回 `success: false`）。
 *
 * 协议背景：proto 仅暴露一个 `Chat` 双向流 RPC（旧的 Prompt / StreamTokens /
 * SetModel / Abort 等 unary RPC 已收敛，见 docs/integration-guide.md）。因此
 * `prompt` / `streamTokens` / `setModel` / `abort` 均是 `Chat` 流之上的便捷封装，
 * 而非独立 RPC。
 */
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
	AbortResponse,
	ClientMessage,
	PromptResponse,
	ServerMessage,
	SetModelResponse,
	TokenChunk,
} from "./types";

const PROTO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "proto", "nexus.proto");

/** proto-loader 加载选项（与 server 端保持一致）。 */
const LOADER_OPTIONS = {
	keepCase: false,
	longs: Number,
	enums: Number,
	defaults: true,
	oneofs: true,
};

/** 加载 proto 后的 Nexus stub 形状。 */
interface NexusStub {
	Chat: () => grpc.ClientDuplexStream<unknown, unknown>;
	close: () => void;
}

/** 编程式客户端句柄。 */
export interface NexusClient {
	/**
	 * 底层双向流：传入 `ClientMessage` 异步迭代器，产出 `ServerMessage`。
	 *
	 * 需要中途发送 `CancelSignal`、应答 `ActionRequired`（`UserInput`）时使用。
	 */
	chat(messages: AsyncIterable<ClientMessage>): AsyncIterable<ServerMessage>;
	/**
	 * 一次性 prompt：发送一条 `ChatRequest`，阻塞到收到 `done`，返回聚合文本。
	 * @param sessionId 会话 ID（非空时跨流复用会话上下文）
	 * @param text      用户消息
	 * @param model     可选模型（`provider/model`），覆盖 `setModel` 偏好
	 */
	prompt(sessionId: string, text: string, model?: string): Promise<PromptResponse>;
	/**
	 * 一次性 prompt：发送一条 `ChatRequest`，按到达顺序产出 `TokenChunk`，
	 * 收到 `done` / `error` 后结束。
	 */
	streamTokens(sessionId: string, text: string, model?: string): AsyncIterable<TokenChunk>;
	/**
	 * 记录会话级模型偏好，作用于后续 `prompt` / `streamTokens`（若未显式传 model）。
	 * 收敛后的协议不提供独立 SetModel RPC，故仅本地记录。
	 */
	setModel(sessionId: string, model: string): Promise<SetModelResponse>;
	/**
	 * 向该会话当前活动的 `chat` 流发送 `CancelSignal`。
	 * 若无活动流，返回 `success: false`。
	 */
	abort(sessionId: string): Promise<AbortResponse>;
	/** 关闭底层 gRPC channel。 */
	close(): void;
}

/**
 * 创建一个 Nexus gRPC 客户端。
 *
 * channel 懒加载并在内部复用；每个 `chat` / `prompt` / `streamTokens` 调用
 * 各自打开一条 `Chat` 双向流。
 * @param address 形如 `host:port` 的服务器地址
 */
export function createClient(address: string): NexusClient {
	let stubHolder: { stub: NexusStub } | undefined;
	const stubPromise = loadStub(address).then((holder) => {
		stubHolder = holder;
		return holder;
	});

	/** 会话级模型偏好（由 setModel 写入，prompt/streamTokens 读取）。 */
	const modelPrefs = new Map<string, string>();
	/** 会话 -> 当前活动的 Chat 流，供 abort 发送 CancelSignal。 */
	const activeStreams = new Map<string, grpc.ClientDuplexStream<unknown, unknown>>();

	async function getStub(): Promise<NexusStub> {
		const { stub } = await stubPromise;
		return stub;
	}

	/** 解析某会话应使用的模型：显式入参优先，否则取 setModel 偏好。 */
	function resolveModel(sessionId: string, model?: string): string | undefined {
		return model ?? modelPrefs.get(sessionId);
	}

	/** 构造一条仅含初始 ChatRequest 的 ClientMessage 异步迭代器。 */
	function singleRequest(sessionId: string, text: string, model?: string): AsyncIterable<ClientMessage> {
		return (async function* () {
			yield {
				request: {
					message: text,
					working_directory: process.cwd(),
					model,
					session_id: sessionId,
				},
			} as ClientMessage;
		})();
	}

	/**
	 * 底层双向流。为支持 abort，在写入首条 ChatRequest 时按其 session_id
	 * 登记活动流，流结束后注销。多路并发同会话不保证精确匹配（尽力而为）。
	 */
	async function* chat(messages: AsyncIterable<ClientMessage>): AsyncIterable<ServerMessage> {
		const stub = await getStub();
		const stream = stub.Chat();
		let trackedSession: string | undefined;
		// 写入侧：消费入参迭代器，逐条写入流，结束后 half-close。
		const writing = (async () => {
			try {
				for await (const msg of messages) {
					if (trackedSession === undefined && msg.request?.session_id) {
						trackedSession = msg.request.session_id;
						activeStreams.set(trackedSession, stream);
					}
					stream.write(msg);
				}
			} finally {
				stream.end();
			}
		})();
		try {
			for await (const msg of streamToAsyncIterable<ServerMessage>(stream)) {
				yield msg;
			}
		} finally {
			if (trackedSession !== undefined) activeStreams.delete(trackedSession);
			// 确保写入侧异常不会成为未处理的 rejection。
			await writing.catch(() => {});
		}
	}

	async function prompt(sessionId: string, text: string, model?: string): Promise<PromptResponse> {
		const reqModel = resolveModel(sessionId, model);
		let aggregated = "";
		let turnsCompleted = 0;
		for await (const msg of chat(singleRequest(sessionId, text, reqModel))) {
			if (msg.text_chunk) aggregated += msg.text_chunk.text;
			if (msg.done) {
				turnsCompleted = 1;
				break;
			}
			if (msg.error) {
				throw new Error(`${msg.error.code}: ${msg.error.message}`);
			}
		}
		return { text: aggregated, sessionId, turnsCompleted };
	}

	async function* streamTokens(sessionId: string, text: string, model?: string): AsyncIterable<TokenChunk> {
		const reqModel = resolveModel(sessionId, model);
		let index = 0;
		for await (const msg of chat(singleRequest(sessionId, text, reqModel))) {
			if (msg.text_chunk) {
				yield { text: msg.text_chunk.text, index };
				index += 1;
			}
			if (msg.done) break;
			if (msg.error) {
				throw new Error(`${msg.error.code}: ${msg.error.message}`);
			}
		}
	}

	async function setModel(sessionId: string, model: string): Promise<SetModelResponse> {
		modelPrefs.set(sessionId, model);
		return { success: true, error: "" };
	}

	async function abort(sessionId: string): Promise<AbortResponse> {
		const stream = activeStreams.get(sessionId);
		if (!stream) return { success: false };
		try {
			stream.write({ cancel: { reason: "client abort" } } as ClientMessage);
			return { success: true };
		} catch {
			return { success: false };
		}
	}

	function close(): void {
		stubHolder?.stub.close();
	}

	return {
		chat,
		prompt,
		streamTokens,
		setModel,
		abort,
		close,
	};
}

// ============================================================
// 内部：gRPC 双向流 -> AsyncIterable
// ============================================================

/** 异步加载 proto 并构造 Nexus stub。 */
async function loadStub(address: string): Promise<{ stub: NexusStub }> {
	const packageDefinition = await protoLoader.load(PROTO_PATH, LOADER_OPTIONS);
	const nexusProto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
		nexus: { Nexus: new (address: string, credentials: grpc.ChannelCredentials) => NexusStub };
	};
	const stub = new nexusProto.nexus.Nexus(address, grpc.credentials.createInsecure());
	return { stub };
}

/**
 * 将 gRPC `ClientDuplexStream` 的 `data` / `end` / `error` 事件转换为
 * `AsyncIterable<T>`，供 `for await ... of` 消费。
 */
function streamToAsyncIterable<T>(stream: grpc.ClientDuplexStream<unknown, unknown>): AsyncIterable<T> {
	const queue: T[] = [];
	let resolveNext: ((value: IteratorResult<T>) => void) | undefined;
	let finished = false;
	let streamError: Error | undefined;

	const settle = (value: IteratorResult<T>): void => {
		if (resolveNext) {
			const resolve = resolveNext;
			resolveNext = undefined;
			resolve(value);
		}
	};

	stream.on("data", (msg: T) => {
		if (resolveNext) {
			settle({ value: msg, done: false });
		} else {
			queue.push(msg);
		}
	});
	stream.on("error", (err: Error) => {
		streamError = err;
		finished = true;
		settle({ value: undefined, done: true });
	});
	stream.on("end", () => {
		finished = true;
		settle({ value: undefined, done: true });
	});

	return {
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<T>> {
					if (queue.length > 0) {
						return Promise.resolve({ value: queue.shift() as T, done: false });
					}
					if (finished) {
						if (streamError) return Promise.reject(streamError);
						return Promise.resolve({ value: undefined, done: true });
					}
					return new Promise<IteratorResult<T>>((resolve) => {
						resolveNext = resolve;
					});
				},
			};
		},
	};
}
