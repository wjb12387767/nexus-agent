import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Nexus Checkpoint native addon loader.
 *
 * 加载平台特定的 `nexus_checkpoint.<platform>-<arch>.node` 二进制（由
 * `napi build` 生成）。镜像 `@oh-my-pi/nexus-sandbox/native/index.js` 的加载
 * 模式：无版本哨兵、无内嵌 addon 提取、无 Windows staging 缓存。
 *
 * 在不支持 reflink 的平台（例如 Windows）上，native addon 仍会加载；
 * 平台分发在 Rust crate 内通过 `pi_iso::backend_kind()` + `cfg(target_os)` 完成。
 */

const SUPPORTED_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
];

function loadNative() {
	const platformTag = `${process.platform}-${process.arch}`;
	if (!SUPPORTED_PLATFORMS.includes(platformTag)) {
		throw new Error(
			`Unsupported platform: ${platformTag}\n` +
				`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}`,
		);
	}

	const filename = `nexus-checkpoint.${platformTag}.node`;
	const require_ = createRequire(import.meta.url);
	const nativeDir = path.join(import.meta.dir);

	const candidates = [
		path.join(nativeDir, filename),
		path.join(nativeDir, "..", "build", "Release", filename),
		path.join(nativeDir, "..", "build", "Debug", filename),
	];

	const errors = [];
	for (const candidate of candidates) {
		try {
			return require_(candidate);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${candidate}: ${message}`);
		}
	}

	// Fallback: scan for ABI-suffixed filename (napi --platform emits
	// e.g. nexus-checkpoint.win32-x64-msvc.node, but the canonical name
	// above omits the ABI suffix). Try any file matching the platform-arch prefix.
	try {
		const files = fs.readdirSync(nativeDir);
		for (const f of files) {
			if (f.startsWith(`nexus-checkpoint.${platformTag}-`) && f.endsWith(".node")) {
				const candidate = path.join(nativeDir, f);
				try {
					return require_(candidate);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push(`${candidate}: ${message}`);
				}
			}
		}
	} catch {}

	const details = errors.map((error) => `- ${error}`).join("\n");
	throw new Error(
		`Failed to load nexus-checkpoint native addon for ${platformTag}.\n\n` +
			`Tried:\n${details}\n\n` +
			"If developing locally, build with: bun --cwd=packages/nexus-checkpoint run build",
	);
}

const nativeBindings = loadNative();

export const createCheckpointStore = nativeBindings.createCheckpointStore;
export const CheckpointStoreHandle = nativeBindings.CheckpointStoreHandle;
