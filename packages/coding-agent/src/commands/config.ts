/**
 * Manage configuration settings.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type ConfigAction, type ConfigCommandArgs, runConfigCommand } from "../cli/config-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg", "routing"];

export default class Config extends Command {
	static description = "Manage configuration settings";

	static args = {
		action: Args.string({
			description: "Config action",
			required: false,
			options: ACTIONS,
		}),
		key: Args.string({
			description: "Setting key (or routing subcommand when action=routing)",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset); for action=routing, the remaining subcommand args",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		// routing 子命令专属 flag：必须在此声明，否则 oclif strict 模式
		// 会把 `--model` / `--header` 当未知 flag 拒绝。仅 action=routing 使用。
		model: Flags.string({
			description: "Real model name (routing add-model only)",
		}),
		header: Flags.string({
			description: "Extra header 'Key:Value' (routing add-model only, repeatable)",
			multiple: true,
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Config);
		const action = (args.action ?? "list") as ConfigAction;
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;

		const cmd: ConfigCommandArgs = {
			action,
			key: args.key,
			value,
			flags: {
				json: flags.json,
			},
		};

		// routing action 把 routing-cli.ts 自解析所需的全部 token 透传到 rest：
		//   - args.key：routing 子命令（如 `add-model`）
		//   - args.value：剩余位置参数（如 `<routeKey> <baseUrl> <apiKey>`）
		//   - flags.model / flags.header：重新拼回 `--model X` / `--header K:V` 形式，
		//     让 routing-cli.ts 的解析器原样识别
		//   - flags.json：透传给 list/show
		if (action === "routing") {
			const rest: string[] = [];
			if (typeof args.key === "string" && args.key.length > 0) rest.push(args.key);
			if (Array.isArray(args.value)) rest.push(...args.value);
			if (flags.json) rest.push("--json");
			if (flags.model) {
				rest.push("--model", flags.model);
			}
			if (flags.header && flags.header.length > 0) {
				for (const h of flags.header) rest.push("--header", h);
			}
			cmd.rest = rest;
		}

		await initTheme();
		await runConfigCommand(cmd);
	}
}
