/**
 * Nexus Sandbox — TS 侧入口。
 *
 * 从 native 加载器 re-export 所有绑定。消费者应从包根导入：
 *
 * ```ts
 * import { createSandbox } from "@oh-my-pi/nexus-sandbox";
 *
 * const sb = createSandbox("workspace", { workspace: process.cwd() });
 * await sb.apply();
 * const result = await sb.exec("ls", ["-la"]);
 * console.log(result.stdout);
 * ```
 *
 * 平台支持：
 * - Linux: Landlock LSM（内核强制）
 * - macOS: Seatbelt（通过 sandbox-exec）
 * - Windows: ISO FS 降级（pi-iso PAL，仅工作区隔离，无内核 deny）
 */

export {
	createSandbox,
	SandboxHandle,
	type SandboxOptions,
	type CustomProfileConfig,
	type SandboxExecResult,
} from "../native/index.js";
