/**
 * Nexus Sandbox NAPI bindings — TypeScript type declarations.
 *
 * 镜像 Rust 侧 `crates/nexus-sandbox/src/lib.rs` 中通过 `#[napi]` 暴露的
 * 接口。这些类型由 napi-rs 在构建时自动生成；此文件在尚未运行 `napi build`
 * 时提供手写占位，使 TS 侧可在无 .node 的情况下做类型检查。
 */

/**
 * 沙箱创建选项。
 */
export interface SandboxOptions {
	/**
	 * 工作区路径（沙箱以此为根授予读写）。
	 */
	workspace: string;
	/**
	 * 自定义 profile 配置（仅当 profile="custom" 时使用）。
	 */
	customProfile?: CustomProfileConfig | null;
}

/**
 * 自定义 profile 配置（镜像 Rust 侧 `ProfileConfig`）。
 */
export interface CustomProfileConfig {
	/**
	 * 基础 profile 名（"workspace" | "devbox" | "read-only" | "strict"）。
	 */
	extends?: string | null;
	/**
	 * 是否阻断子进程网络。
	 */
	restrictNetwork?: boolean | null;
	/**
	 * 只读路径列表。
	 */
	readOnly: string[];
	/**
	 * 读写路径列表。
	 */
	readWrite: string[];
	/**
	 * 拒绝路径列表（读 + 写都拒）。
	 */
	deny: string[];
}

/**
 * 沙箱执行结果。
 */
export interface SandboxExecResult {
	/**
	 * 退出码（0 = 成功）。
	 */
	exitCode: number;
	/**
	 * stdout 内容（UTF-8）。
	 */
	stdout: string;
	/**
	 * stderr 内容（UTF-8）。
	 */
	stderr: string;
}

/**
 * 沙箱句柄。包装 Rust 侧的 `SandboxManager`，向 TS 侧暴露 exec/writeFile/readFile。
 */
export class SandboxHandle {
	/**
	 * 应用沙箱（不可逆）。在 Linux 上应用 Landlock，macOS 上应用 Seatbelt，
	 * Windows 上降级为 ISO FS 隔离。
	 */
	apply(): Promise<void>;
	/**
	 * 沙箱是否已应用。
	 */
	readonly isApplied: boolean;
	/**
	 * 当前 profile 名。
	 */
	readonly profileName: string;
	/**
	 * 子进程是否应被阻断网络。
	 */
	readonly restrictChildNetwork: boolean;
	/**
	 * 在沙箱内执行一个命令。
	 *
	 * Linux 上通过 `pre_exec` 安装 seccomp 网络过滤器（当 `restrictChildNetwork` 为 true）。
	 * macOS 上通过 `sandbox-exec -p <profile> -- <cmd>` 执行。
	 * Windows 上直接执行（ISO FS 已隔离工作区）。
	 */
	exec(command: string, args: string[]): Promise<SandboxExecResult>;
	/**
	 * 在沙箱内写入文件（受 profile 限制）。
	 */
	writeFile(path: string, content: string): Promise<void>;
	/**
	 * 在沙箱内读取文件（受 profile 限制）。
	 */
	readFile(path: string): Promise<string>;
}

/**
 * 创建一个沙箱句柄。
 *
 * @param profile - 可选值：`"workspace"` | `"devbox"` | `"read-only"` | `"strict"` | `"off"` | `"custom"`。
 *                  `"custom"` 时从 `opts.customProfile` 读取配置。
 * @param opts - 沙箱创建选项。
 */
export function createSandbox(profile: string, opts: SandboxOptions): SandboxHandle;
