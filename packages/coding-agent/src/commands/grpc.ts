/**
 * `nexus grpc` —— 启动 Nexus gRPC server。
 *
 * 把 omp 的 agent runtime 通过 gRPC 双向流协议（nexus.Nexus.Chat）暴露给
 * 外部客户端（Python/Go/Rust/VS Code 扩展等）。底层调用
 * `@nexus-agent/grpc` 的 `runGrpcCli`。
 *
 * 用法：
 *   nexus grpc --port 50051 --host localhost
 *   nexus grpc --confirm-destructive
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runGrpcCli } from "@nexus-agent/grpc";

export default class Grpc extends Command {
	static description = "启动 Nexus gRPC server（双向流 Chat 协议，供外部客户端接入）";

	static flags = {
		port: Flags.integer({ char: "p", description: "监听端口", default: 50051 }),
		host: Flags.string({ char: "h", description: "监听地址", default: "localhost" }),
		"confirm-destructive": Flags.boolean({
			description: "对破坏性工具（bash/write/edit 等）发出 ToolPermission 确认请求",
			default: false,
		}),
	};

	static examples = [
		"nexus grpc --port 50051",
		"nexus grpc --host 0.0.0.0 --port 9090",
		"nexus grpc --confirm-destructive",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Grpc);
		const argv: string[] = [
			"--port",
			String(flags.port),
			"--host",
			flags.host,
		];
		if (flags["confirm-destructive"]) argv.push("--confirm-destructive");
		await runGrpcCli(argv);
	}
}
