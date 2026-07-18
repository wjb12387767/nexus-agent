/**
 * Nexus gRPC server CLI 入口。
 *
 * 接受 `--port`（默认 50051）与 `--host`（默认 localhost），启动 gRPC server。
 * 由 `packages/coding-agent` 的 `grpc` 子命令调用（`nexus grpc --port 50051`）。
 */
import { startNexusGrpcServer } from "./server";
import type { NexusGrpcServerOptions } from "./types";

export interface GrpcCliArgs {
	port?: number;
	host?: string;
	/** 可选：开启破坏性工具确认（默认关闭，自动放行所有工具）。 */
	confirmDestructive?: boolean;
}

/** 解析 argv 中的 --port / --host / --confirm-destructive 标志。 */
export function parseGrpcCliArgs(argv: readonly string[]): GrpcCliArgs {
	const args: GrpcCliArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port" || arg === "-p") {
			const next = argv[i + 1];
			if (next) {
				const port = Number.parseInt(next, 10);
				if (Number.isFinite(port) && port > 0 && port < 65536) {
					args.port = port;
					i++;
				}
			}
		} else if (arg.startsWith("--port=")) {
			const port = Number.parseInt(arg.slice("--port=".length), 10);
			if (Number.isFinite(port) && port > 0 && port < 65536) args.port = port;
		} else if (arg === "--host" || arg === "-h") {
			const next = argv[i + 1];
			if (next) {
				args.host = next;
				i++;
			}
		} else if (arg.startsWith("--host=")) {
			args.host = arg.slice("--host=".length);
		} else if (arg === "--confirm-destructive") {
			args.confirmDestructive = true;
		}
	}
	return args;
}

/**
 * 运行 gRPC server CLI。阻塞直到收到 SIGINT/SIGTERM 或 server 关闭。
 * @param argv 命令行参数（不含子命令名本身）
 */
export async function runGrpcCli(argv: readonly string[] = []): Promise<void> {
	const args = parseGrpcCliArgs(argv);
	const options: NexusGrpcServerOptions = {
		port: args.port ?? 50051,
		host: args.host ?? "localhost",
	};

	const server = await startNexusGrpcServer(options);
	process.stdout.write(`Nexus gRPC server listening on ${server.address}\n`);
	process.stdout.write(`  proto: nexus.Nexus / Chat (bidirectional stream)\n`);
	process.stdout.write(`  按 Ctrl+C 优雅关闭\n`);

	// 阻塞直到收到关闭信号
	const { promise: shutdownSignal, resolve: signalShutdown } = Promise.withResolvers<string>();
	const handler = (signal: string): void => signalShutdown(signal);
	process.once("SIGINT", () => handler("SIGINT"));
	process.once("SIGTERM", () => handler("SIGTERM"));

	const signal = await shutdownSignal;
	process.stdout.write(`\n收到 ${signal}，正在关闭 gRPC server...\n`);
	try {
		await server.shutdown();
		process.stdout.write("已关闭\n");
	} catch (err) {
		process.stderr.write(`关闭失败: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}

// 当作为主模块直接运行时启动 server
if (import.meta.main) {
	runGrpcCli(process.argv.slice(2)).catch((err: unknown) => {
		process.stderr.write(`启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}
