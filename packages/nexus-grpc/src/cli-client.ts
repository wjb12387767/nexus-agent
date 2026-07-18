/**
 * Nexus gRPC REPL 测试客户端。
 *
 * 连接到运行中的 Nexus gRPC server，提供交互式 REPL：
 * - 读取用户输入，作为 ChatRequest 发送
 * - 接收并显示流式 TextChunk / ToolCallStart / ToolCallResult
 * - 收到 ActionRequired 时提示用户应答，回传 UserInput
 * - 支持 /abort（发送 CancelSignal）、/model <id>、/quit、/session <id>
 *
 * 由 `packages/coding-agent` 的 `grpc-cli` 子命令调用（`nexus grpc-cli --port 50051`）。
 */
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline";
import type { ClientMessage, ServerMessage } from "./types";

const PROTO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "proto", "nexus.proto");

const LOADER_OPTIONS = {
	keepCase: false,
	longs: Number,
	enums: Number,
	defaults: true,
	oneofs: true,
};

export interface GrpcClientReplArgs {
	port?: number;
	host?: string;
	model?: string;
	sessionId?: string;
	cwd?: string;
}

/** 解析 argv 中的客户端标志。 */
export function parseGrpcClientArgs(argv: readonly string[]): GrpcClientReplArgs {
	const args: GrpcClientReplArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port" || arg === "-p") {
			const next = argv[i + 1];
			if (next) {
				const port = Number.parseInt(next, 10);
				if (Number.isFinite(port) && port > 0) {
					args.port = port;
					i++;
				}
			}
		} else if (arg.startsWith("--port=")) {
			const port = Number.parseInt(arg.slice("--port=".length), 10);
			if (Number.isFinite(port) && port > 0) args.port = port;
		} else if (arg === "--host") {
			const next = argv[i + 1];
			if (next) {
				args.host = next;
				i++;
			}
		} else if (arg.startsWith("--host=")) {
			args.host = arg.slice("--host=".length);
		} else if (arg === "--model" || arg === "-m") {
			const next = argv[i + 1];
			if (next) {
				args.model = next;
				i++;
			}
		} else if (arg.startsWith("--model=")) {
			args.model = arg.slice("--model=".length);
		} else if (arg === "--session" || arg === "-s") {
			const next = argv[i + 1];
			if (next) {
				args.sessionId = next;
				i++;
			}
		} else if (arg.startsWith("--session=")) {
			args.sessionId = arg.slice("--session=".length);
		} else if (arg === "--cwd") {
			const next = argv[i + 1];
			if (next) {
				args.cwd = next;
				i++;
			}
		} else if (arg.startsWith("--cwd=")) {
			args.cwd = arg.slice("--cwd=".length);
		}
	}
	return args;
}

interface NexusClient {
	Chat: grpc.ClientDuplexStream<unknown, unknown>;
	close(): void;
}

/** 加载 proto 并建立到 server 的双向流连接。 */
async function connectClient(host: string, port: number): Promise<NexusClient> {
	const packageDefinition = await protoLoader.load(PROTO_PATH, LOADER_OPTIONS);
	const nexusProto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
		nexus: { Nexus: new (address: string, credentials: grpc.ChannelCredentials) => { Chat: () => grpc.ClientDuplexStream<unknown, unknown> } };
	};
	const client = new nexusProto.nexus.Nexus(`${host}:${port}`, grpc.credentials.createInsecure());
	const stream = client.Chat();
	return {
		Chat: stream,
		close: () => client.close(),
	};
}

/** 格式化 ServerMessage 为可读字符串。 */
function formatServerMessage(msg: ServerMessage): string {
	if (msg.text_chunk) {
		return msg.text_chunk.text;
	}
	if (msg.tool_start) {
		return `\n[工具开始] ${msg.tool_start.tool_name} (id=${msg.tool_start.tool_use_id})\n  参数: ${msg.tool_start.arguments_json}\n`;
	}
	if (msg.tool_result) {
		const status = msg.tool_result.is_error ? "错误" : "完成";
		return `\n[工具${status}] ${msg.tool_result.tool_name} (id=${msg.tool_result.tool_use_id})\n  输出: ${msg.tool_result.output}\n`;
	}
	if (msg.action_required) {
		const typeStr = msg.action_required.type === 0 ? "确认命令" : "请求信息";
		return `\n[需要操作] (${typeStr}) prompt_id=${msg.action_required.prompt_id}\n  ${msg.action_required.question}\n`;
	}
	if (msg.done) {
		return `\n[完成] prompt_tokens=${msg.done.prompt_tokens} completion_tokens=${msg.done.completion_tokens}\n`;
	}
	if (msg.error) {
		return `\n[错误] ${msg.error.code}: ${msg.error.message}\n`;
	}
	return "";
}

/**
 * 运行 gRPC REPL 客户端。
 * @param argv 命令行参数
 */
export async function runGrpcClientRepl(argv: readonly string[] = []): Promise<void> {
	const args = parseGrpcClientArgs(argv);
	const host = args.host ?? "localhost";
	const port = args.port ?? 50051;
	const cwd = args.cwd ?? process.cwd();
	let model = args.model;
	let sessionId = args.sessionId ?? "";

	process.stdout.write(`连接到 Nexus gRPC server ${host}:${port} ...\n`);
	const client = await connectClient(host, port);
	const stream = client.Chat;
	process.stdout.write("已连接。输入消息发送 prompt，/quit 退出。\n");
	process.stdout.write(`  会话: ${sessionId || "(新建)"}  模型: ${model || "(默认)"}  cwd: ${cwd}\n\n`);

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "nexus> ",
	});
	rl.prompt();

	// 接收 server 消息
	stream.on("data", (msg: ServerMessage) => {
		const text = formatServerMessage(msg);
		if (text) {
			process.stdout.write(text);
			// ActionRequired 时提示用户应答
			if (msg.action_required) {
				rl.question(`应答 [${msg.action_required.prompt_id}]> `, (reply) => {
					const userInput: ClientMessage = {
						input: { reply, prompt_id: msg.action_required!.prompt_id },
					};
					stream.write(userInput);
					rl.prompt();
				});
				return;
			}
		}
		rl.prompt();
	});

	stream.on("error", (err: Error) => {
		process.stderr.write(`\n[流错误] ${err.message}\n`);
		rl.close();
		client.close();
		process.exit(1);
	});

	stream.on("end", () => {
		process.stdout.write("\n[server 关闭了流]\n");
		rl.close();
		client.close();
	});

	// 处理用户输入
	rl.on("line", (line: string) => {
		const input = line.trim();
		if (!input) {
			rl.prompt();
			return;
		}
		if (input === "/quit" || input === "/exit") {
			stream.end();
			rl.close();
			client.close();
			process.exit(0);
			return;
		}
		if (input === "/abort") {
			const cancel: ClientMessage = { cancel: { reason: "用户请求中止" } };
			stream.write(cancel);
			rl.prompt();
			return;
		}
		if (input.startsWith("/model ")) {
			model = input.slice("/model ".length).trim();
			process.stdout.write(`  模型已切换为: ${model}\n`);
			rl.prompt();
			return;
		}
		if (input.startsWith("/session ")) {
			sessionId = input.slice("/session ".length).trim();
			process.stdout.write(`  会话已切换为: ${sessionId}\n`);
			rl.prompt();
			return;
		}
		// 普通消息 -> ChatRequest
		const clientMessage: ClientMessage = {
			request: {
				message: input,
				working_directory: cwd,
				model,
				session_id: sessionId,
			},
		};
		stream.write(clientMessage);
	});

	rl.on("close", () => {
		stream.end();
		client.close();
		process.exit(0);
	});
}

// 当作为主模块直接运行时启动 REPL
if (import.meta.main) {
	runGrpcClientRepl(process.argv.slice(2)).catch((err: unknown) => {
		process.stderr.write(`客户端启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}
