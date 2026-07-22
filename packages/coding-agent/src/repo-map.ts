import * as path from "node:path";
import { buildRepoMap as buildRepoMapNative } from "@oh-my-pi/pi-natives";

/**
 * Defaults for the repo-map block shown in the system prompt. Tuned to
 * coexist with the workspace-tree block without busting the prompt cache.
 */
const REPO_MAP_DEFAULTS = {
	maxLines: 200,
	maxFiles: 2000,
	maxSymbolsPerFile: 40,
	timeoutMs: 5000,
} as const;

/** Result of a repo-map build pass. Mirrors the native `RepoMapResult`. */
export interface RepoMap {
	/** Absolute repository root that was scanned. */
	rootPath: string;
	/** Rendered text block, empty when nothing was extracted or `includeRepoMap` is off. */
	rendered: string;
	/** True when output or scan was truncated by a budget. */
	truncated: boolean;
	/** Number of rendered lines (0 when empty). */
	totalLines: number;
	/** Number of source files scanned for symbols. */
	filesScanned: number;
}

/** Options for {@link buildRepoMap}. */
export interface BuildRepoMapOptions {
	/** Abort the native scan after this many milliseconds. Default: 5000. */
	timeoutMs?: number;
	/** Hard cap on rendered output lines. Default: 200. */
	maxLines?: number;
	/** Hard cap on files scanned with tree-sitter. Default: 2000. */
	maxFiles?: number;
	/** Hard cap on symbols kept per file. Default: 40. */
	maxSymbolsPerFile?: number;
}

function emptyRepoMap(rootPath: string): RepoMap {
	return {
		rootPath,
		rendered: "",
		truncated: false,
		totalLines: 0,
		filesScanned: 0,
	};
}

/**
 * Build the repo-map block shown in the system prompt. Walks the working
 * tree, extracts top-level definitions per file using tree-sitter, scores
 * files by symbol count + inbound reference count + mtime recency, and
 * renders a token-budgeted ranked listing analogous to Aider's repo-map.
 *
 * Returns an empty {@link RepoMap} when the native binding is unavailable
 * (e.g. before `napi build` has been run after adding the binding) or when
 * the scan fails for any reason — the system prompt then simply omits the
 * `<repo-map>` block, matching the `workspace-tree` degradation contract.
 */
export async function buildRepoMap(cwd: string, options: BuildRepoMapOptions = {}): Promise<RepoMap> {
	const rootPath = path.resolve(cwd);

	if (typeof buildRepoMapNative !== "function") {
		return emptyRepoMap(rootPath);
	}

	const timeoutMs = options.timeoutMs ?? REPO_MAP_DEFAULTS.timeoutMs;
	const maxLines = options.maxLines ?? REPO_MAP_DEFAULTS.maxLines;
	const maxFiles = options.maxFiles ?? REPO_MAP_DEFAULTS.maxFiles;
	const maxSymbolsPerFile = options.maxSymbolsPerFile ?? REPO_MAP_DEFAULTS.maxSymbolsPerFile;

	try {
		const result = await buildRepoMapNative({
			root: rootPath,
			maxLines,
			maxFiles,
			maxSymbolsPerFile,
			timeoutMs,
		});
		return {
			rootPath,
			rendered: result.rendered ?? "",
			truncated: Boolean(result.truncated),
			totalLines: result.totalLines ?? 0,
			filesScanned: result.fileCount ?? 0,
		};
	} catch {
		return emptyRepoMap(rootPath);
	}
}
