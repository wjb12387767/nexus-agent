/**
 * WSL2 桥接命令 —— 检测 WSL2、在 WSL2 内启动 agent、查看状态或打印安装指引。
 *
 * 子命令：
 * - `nexus wsl` / `nexus wsl status` — 显示 WSL2 检测结果
 * - `nexus wsl launch [--distro <name>]` — 在 WSL2 内启动 agent
 * - `nexus wsl install` — 打印 WSL 内安装指引
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type WslAction, type WslCommandArgs, runWslCommand } from "../cli/wsl-cli";

const ACTIONS: WslAction[] = ["status", "launch", "install"];

export default class Wsl extends Command {
	static description = "Bridge to WSL2 for full Linux capabilities (sandbox, checkpoint, bash AST)";

	static args = {
		action: Args.string({
			description: "WSL action (default: status)",
			required: false,
			options: ACTIONS,
		}),
		args: Args.string({
			description: "Extra args passed to nexus inside WSL (launch only)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		distro: Flags.string({
			description: "WSL distribution to use (launch only; defaults to wsl.preferredDistro or WSL default)",
		}),
		json: Flags.boolean({ description: "Output JSON (status only)" }),
	};

	static strict = false;

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Wsl);
		const action = (args.action ?? "status") as WslAction;
		const extraArgs = Array.isArray(args.args) ? args.args : args.args ? [args.args] : [];

		const cmd: WslCommandArgs = {
			action,
			distro: flags.distro,
			args: extraArgs,
			json: flags.json,
		};

		await runWslCommand(cmd);
	}
}
