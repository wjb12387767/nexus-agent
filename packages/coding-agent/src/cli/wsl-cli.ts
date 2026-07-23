/**
 * WSL Bridge CLI 命令处理器。
 *
 * 处理 `nexus wsl` 子命令族：
 * - `nexus wsl` / `nexus wsl status` — 显示 WSL2 检测结果
 * - `nexus wsl launch [--distro <name>]` — 在 WSL2 内启动 agent
 * - `nexus wsl install` — 打印 WSL 内安装指引
 *
 * 让 Windows 用户通过 WSL2 获得完整的 Linux 能力（Landlock 沙箱、reflink
 * checkpoint、原生 bash）。
 */
import chalk from "chalk";
import { getDefault, isSettingsInitialized, settings, type SettingPath } from "../config/settings";
import {
	detectWsl,
	launchInWsl,
	WSL_INSTALL_INSTRUCTIONS,
} from "../wsl-bridge";

/** `nexus wsl` 支持的子动作。 */
export type WslAction = "status" | "launch" | "install";

/** `nexus wsl` 命令参数。 */
export interface WslCommandArgs {
	action?: WslAction;
	/** `launch --distro <name>` 指定的发行版 */
	distro?: string;
	/** 传给 WSL 内 nexus 的额外参数 */
	args?: string[];
	/** 是否以 JSON 输出（status 用） */
	json?: boolean;
}

/**
 * 读取一个 WSL 相关配置项；settings 未初始化时回退到 schema 默认值，
 * 避免在独立子命令（未经 `runRootCommand` 初始化 settings）中抛错。
 */
function readWslSetting<P extends SettingPath>(path: P): unknown {
	if (isSettingsInitialized()) return settings.get(path);
	return getDefault(path);
}

/** 将 WSL 检测结果渲染成可读文本。 */
function renderWslStatus(info: Awaited<ReturnType<typeof detectWsl>>): string {
	if (!info.available) {
		return chalk.yellow("WSL2 is not available.") + chalk.dim(" (wsl.exe not found or no distribution installed)");
	}
	const lines: string[] = [chalk.bold("WSL2 detected")];
	lines.push(`  ${chalk.dim("wsl.exe:")} ${info.wslPath ?? "(unknown)"}`);
	lines.push(`  ${chalk.dim("version:")} WSL${info.version ?? "?"}`);
	lines.push(`  ${chalk.dim("default:")} ${info.defaultDistribution ?? "(none)"}`);
	if (info.distributions.length > 0) {
		lines.push(`  ${chalk.dim("distributions:")}`);
		for (const distro of info.distributions) {
			const marker = distro === info.defaultDistribution ? chalk.green("* ") : "  ";
			lines.push(`    ${marker}${distro}`);
		}
	}
	return lines.join("\n");
}

/** 运行 `nexus wsl` 命令族。 */
export async function runWslCommand(cmd: WslCommandArgs): Promise<void> {
	const action = cmd.action ?? "status";

	if (action === "install") {
		process.stdout.write(`${WSL_INSTALL_INSTRUCTIONS}\n`);
		return;
	}

	if (action === "status") {
		const info = await detectWsl();
		if (cmd.json) {
			process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
			return;
		}
		process.stdout.write(`${renderWslStatus(info)}\n`);
		if (info.available && info.version === 2) {
			process.stdout.write(
				chalk.dim(
					`\nTip: run \`nexus wsl launch\` to start inside WSL2 for full capabilities (sandbox, checkpoint, bash AST).\n`,
				) + "\n",
			);
		}
		return;
	}

	if (action === "launch") {
		// 优先用 --distro，其次读 wsl.preferredDistro 配置项。
		const preferredDistro = readWslSetting("wsl.preferredDistro");
		const distribution = cmd.distro ?? (typeof preferredDistro === "string" ? preferredDistro : undefined);
		const projectPath = process.cwd();
		await launchInWsl({
			distribution,
			projectPath,
			args: cmd.args,
		});
		return;
	}

	process.stderr.write(`Unknown wsl action: ${action}\n`);
	process.exitCode = 1;
}
