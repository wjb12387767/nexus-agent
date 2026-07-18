/**
 * `nexus grpc-cli` —— 启动 Nexus gRPC REPL 测试客户端。
 *
 * 连接到运行中的 Nexus gRPC server，提供交互式 REPL：发送 prompt、
 * 接收流式 token、应答工具权限请求。底层调用
 * `@nexus-agent/grpc` 的 `runGrpcClientRepl`。
 *
 * 用法：
 *   nexus grpc-cli --port 50051
 *   nexus grpc-cli --model anthropic/claude-sonnet-4-5 --session my-sess
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runGrpcClientRepl } from "@nexus-agent/grpc";

export default class GrpcCli extends Command {
	static description = "启动 Nexus gRPC REPL 测试客户端（连接到运行中的 nexus grpc server）";

	static flags = {
		port: Flags.integer({ char: "p", description: "目标 server 端口", default: 50051 }),
		host: Flags.string({ char: "h", description: "目标 server 地址", default: "localhost" }),
		model: Flags.string({ char: "m", description: "初始模型（provider/model 形式）" }),
		session: Flags.string({ char: "s", description: "会话 ID（跨流持久化）" }),
		cwd: Flags.string({ description: "工作目录（默认当前目录）" }),
	};

	static examples = [
		"nexus grpc-cli --port 50051",
		"nexus grpc-cli --model anthropic/claude-sonnet-4-5",
		'nexus grpc-cli --session my-session --cwd "/path/to/project"',
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(GrpcCli);
		const argv: string[] = [
			"--port",
			String(flags.port),
			"--host",
			flags.host,
		];
		if (flags.model) {
			argv.push("--model", flags.model);
		}
		if (flags.session) {
			argv.push("--session", flags.session);
		}
		if (flags.cwd) {
			argv.push("--cwd", flags.cwd);
		}
		await runGrpcClientRepl(argv);
	}
}
