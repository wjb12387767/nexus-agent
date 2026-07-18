#!/usr/bin/env bun
/**
 * Release script for pi-mono (omp base) — extended by Nexus Agent (M9 Task 9.4).
 *
 * Usage:
 *   bun scripts/release.ts <version|major|minor|patch>           Full release (preflight, version, changelog, commit, push, watch)
 *   bun scripts/release.ts <version|major|minor|patch> --dry-run Dry-run: 不写文件、不 commit、不 push、不 tag
 *   bun scripts/release.ts <version|major|minor|patch> --nexus   发布 Nexus 专有 tag（nexus-v*）触发 release.yml
 *   bun scripts/release.ts watch                                 Watch CI for current commit
 *
 * Example: bun scripts/release.ts minor
 * Example: bun scripts/release.ts 1.0.0-beta --dry-run
 * Example: bun scripts/release.ts 1.0.0-beta --nexus
 *
 * Nexus 扩展（Task 9.4）：
 *   - --dry-run：所有 mutating 操作改为只打印不执行（pre-flight checks 仍执行）
 *   - --nexus：使用 `nexus-v*` tag 前缀，触发 .github/workflows/release.yml
 *     （独立于 omp 的 v* tag，避免与 omp 已有 release 流程冲突）
 *   - vsix manifest 同步更新（vscode-extension/nexus-vscode/package.json）
 *   - @nexus-agent/* catalog 条目同步更新（在 root package.json 中）
 */
import { $, Glob } from "bun";
import { runChangelogFixer } from "./fix-changelogs";
import { existsSync } from "node:fs";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");

// ─── Nexus 扩展：CLI 参数解析 ─────────────────────────────────────────
// dry-run：不写文件、不 commit、不 tag、不 push。
// nexus：使用 nexus-v* tag 前缀，触发 .github/workflows/release.yml。
const releaseArgs = process.argv.slice(2);
const dryRun = releaseArgs.includes("--dry-run") || releaseArgs.includes("-n");
const useNexusTag = releaseArgs.includes("--nexus");
// 真正的位置参数（版本号或 bump 类型）是首个非 -- 开头的 token
const positionalArg = releaseArgs.find((a) => !a.startsWith("-")) || "";

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`;
}

// dry-run 守护：dryRun 时只打印 label，不执行 fn
async function guard(label: string, fn: () => Promise<unknown>): Promise<void> {
	if (dryRun) {
		console.log(`  [dry-run] ${label}`);
		return;
	}
	await fn();
}

// =============================================================================
// Shared functions
// =============================================================================

async function watchCI(): Promise<boolean> {
	const commitSha = (await git(["rev-parse", "HEAD"]).text()).trim();
	console.log(`  Commit: ${commitSha.slice(0, 8)}`);

	while (true) {
		const runsOutput = await $`gh run list --commit ${commitSha} --json databaseId,status,conclusion,name`.text();
		const runs: Array<{ databaseId: number; status: string; conclusion: string | null; name: string }> =
			JSON.parse(runsOutput);

		if (runs.length === 0) {
			console.log("  Waiting for CI to start...");
			await Bun.sleep(3000);
			continue;
		}

		// Check job-level status for in-progress runs (fail fast on first job failure)
		const failedJobs: Array<{ workflow: string; job: string; jobId: number; conclusion: string }> = [];
		const inProgressRuns = runs.filter(r => r.status === "in_progress" || r.status === "queued");

		for (const run of inProgressRuns) {
			const jobsOutput = await $`gh run view ${run.databaseId} --json jobs`.quiet().nothrow().text();
			try {
				const { jobs } = JSON.parse(jobsOutput) as {
					jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }>;
				};
				for (const job of jobs) {
					if (job.status === "completed" && job.conclusion !== "success" && job.conclusion !== "skipped") {
						failedJobs.push({
							workflow: run.name,
							job: job.name,
							jobId: job.databaseId,
							conclusion: job.conclusion ?? "unknown",
						});
					}
				}
			} catch {
				// Ignore parse errors
			}
		}

		if (failedJobs.length > 0) {
			console.error("\nCI job failed:");
			for (const f of failedJobs) {
				console.error(`  - ${f.workflow} / ${f.job} (job ${f.jobId}): ${f.conclusion}`);
				// Tail the failed job's log
				const log = await $`gh run view --job ${f.jobId} --log-failed`.quiet().nothrow().text();
				if (log.trim()) {
					const lines = log.trimEnd().split("\n");
					const tail = lines.slice(-20).join("\n");
					console.error(`\n--- Last 20 lines of ${f.job} ---\n${tail}\n`);
				}
			}
			return false;
		}

		// Check workflow-level status
		const pending = runs.filter(r => r.status !== "completed");
		const failed = runs.filter(r => r.status === "completed" && r.conclusion !== "success");
		const passed = runs.filter(r => r.status === "completed" && r.conclusion === "success");

		console.log(`  ${passed.length} passed, ${pending.length} pending, ${failed.length} failed`);

		if (failed.length > 0) {
			console.error("\nCI failed:");
			for (const r of failed) {
				console.error(`  - ${r.name}: ${r.conclusion}`);
				// Fetch failed jobs and tail their logs
				const jobsOutput = await $`gh run view ${r.databaseId} --json jobs`.quiet().nothrow().text();
				try {
					const { jobs } = JSON.parse(jobsOutput) as {
						jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }>;
					};
					for (const job of jobs) {
						if (job.conclusion !== "success" && job.conclusion !== "skipped") {
							const log = await $`gh run view --job ${job.databaseId} --log-failed`.quiet().nothrow().text();
							if (log.trim()) {
								const lines = log.trimEnd().split("\n");
								const tail = lines.slice(-20).join("\n");
								console.error(`\n--- Last 20 lines of ${job.name} (job ${job.databaseId}) ---\n${tail}\n`);
							}
						}
					}
				} catch {
					// Ignore parse errors
				}
			}
			return false;
		}

		if (pending.length === 0) {
			console.log("  All CI checks passed!\n");
			return true;
		}

		await Bun.sleep(5000);
	}
}

function hasUnreleasedContent(content: string): boolean {
	const unreleasedMatch = content.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);
	if (!unreleasedMatch) return false;
	const sectionContent = unreleasedMatch[1].trim();
	return sectionContent.length > 0;
}

function removeEmptyVersionEntries(content: string): string {
	// Remove version entries that have no content (just whitespace until next ## [ or EOF)
	return content.replace(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];

	for await (const changelog of changelogGlob.scan(".")) {
		let content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// Only create version entry if [Unreleased] has content
		if (hasUnreleasedContent(content)) {
			content = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
			content = content.replace(/^(# Changelog\n\n)/, `$1## [Unreleased]\n\n`);
		}

		// Clean up any existing empty version entries
		content = removeEmptyVersionEntries(content);

		await Bun.write(changelog, content);
		console.log(`  Updated ${changelog}`);
	}
}

// =============================================================================
// Subcommands
// =============================================================================

async function cmdWatch(): Promise<void> {
	console.log("\n=== Watching CI ===\n");
	const success = await watchCI();
	process.exit(success ? 0 : 1);
}

function parseVersion(v: string): [number, number, number] {
	const match = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) throw new Error(`Invalid version: ${v}`);
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function bumpVersion(current: string, bump: "major" | "minor" | "patch"): string {
	const [major, minor, patch] = parseVersion(current);
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

function compareVersions(a: string, b: string): number {
	const [aMajor, aMinor, aPatch] = parseVersion(a);
	const [bMajor, bMinor, bPatch] = parseVersion(b);
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	return aPatch - bPatch;
}

async function cmdRelease(versionOrBump: string): Promise<void> {
	console.log("\n=== Release Script ===\n");
	if (dryRun) {
		console.log("[dry-run] 模式已启用：将跳过 git commit/tag/push、lockfile 重新生成、watch CI。\n");
		console.log("[dry-run] 注意：sd / Bun.write 命令仍会修改工作区文件，事后请运行 `git checkout .` 还原。\n");
	}
	if (useNexusTag) {
		console.log("[nexus] 使用 nexus-v* tag 前缀（触发 .github/workflows/release.yml）\n");
	}

	// 1. Pre-flight checks
	console.log("Pre-flight checks...");

	const branch = await git(["branch", "--show-current"]).text();
	if (branch.trim() !== "main") {
		console.error(`Error: Must be on main branch (currently on '${branch.trim()}')`);
		process.exit(1);
	}
	console.log("  On main branch");

	const status = await git(["status", "--porcelain"]).text();
	if (status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	// Nexus 扩展：useNexusTag=true 时用 `nexus-v*` 前缀找上一个 tag
	const tagGlob = useNexusTag ? "nexus-v*" : "v*";
	const latestTag = (await git(["describe", "--tags", "--abbrev=0", "--match", tagGlob]).text()).trim();
	let version = versionOrBump;
	if (version === "major" || version === "minor" || version === "patch") {
		version = bumpVersion(latestTag, version);
		console.log(`Bumping ${versionOrBump} version from ${latestTag} -> ${version}`);
	}

	// Nexus 扩展：prerelease 版本（如 1.0.0-beta）跳过严格比较
	// 因为 parseVersion 不解析 prerelease 后缀，1.0.0-alpha vs 1.0.0-beta 会误判为相等。
	const isPrerelease = /-\w/.test(version);
	if (!isPrerelease && compareVersions(version, latestTag) <= 0) {
		console.error(`Error: Version ${version} must be greater than latest tag ${latestTag}`);
		process.exit(1);
	}
	if (isPrerelease) {
		console.log(`  Version ${version} (prerelease) — 跳过与 ${latestTag} 的严格比较`);
	} else {
		console.log(`  Version ${version} > ${latestTag}\n`);
	}

	// 2. Update package versions
	console.log(`Updating package versions to ${version}…`);
	const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));

	// Filter out private packages
	const publicPkgPaths: string[] = [];
	for (const pkgPath of pkgJsonPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		publicPkgPaths.push(pkgPath);
	}

	await $`sd '"version": "[^"]+"' ${`"version": "${version}"`} ${publicPkgPaths}`;

	// Verify
	console.log("  Verifying versions:");
	for (const pkgPath of publicPkgPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
	}
	console.log();

	// Update @oh-my-pi/* catalog entries in root package.json
	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(/("@oh-my-pi\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	// Nexus 扩展：同步更新 @nexus-agent/* catalog 条目（workspace:* 不需要 bump，
	// 但若条目用了显式版本号要同步）
	rootPkgRaw = rootPkgRaw.replace(/("@nexus-agent\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	await guard("write root package.json (catalog updates)", async () => {
		await Bun.write("package.json", rootPkgRaw);
	});
	console.log("  Updated root catalog @oh-my-pi/* + @nexus-agent/* entries");

	// Nexus 扩展（Task 9.4）：同步 vsix manifest（vscode-extension/nexus-vscode/package.json）
	const vsixManifestPath = "vscode-extension/nexus-vscode/package.json";
	if (existsSync(vsixManifestPath)) {
		console.log("Updating VS Code extension manifest...");
		const vsixRaw = await Bun.file(vsixManifestPath).text();
		const vsixUpdated = vsixRaw.replace(/("version":\s*)"[^"]+"/g, `$1"${version}"`);
		await guard(`write ${vsixManifestPath}`, async () => {
			await Bun.write(vsixManifestPath, vsixUpdated);
		});
		console.log(`  ${vsixManifestPath} -> ${version}`);
	}

	// 3. Update Rust workspace version
	console.log(`Updating Rust workspace version to ${version}…`);
	await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`;

	// Verify
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (versionMatch) {
		console.log(`  workspace: ${versionMatch[1]}`);
	}

	// List crates using workspace version
	for await (const cargoPath of cargoTomlGlob.scan(".")) {
		const content = await Bun.file(cargoPath).text();
		if (content.includes("version.workspace = true")) {
			const nameMatch = content.match(/^name = "([^"]+)"/m);
			if (nameMatch) {
				console.log(`  ${nameMatch[1]}: ${version} (workspace)`);
			}
		}
	}
	console.log();

	// 3b. Rename the pi-natives version sentinel so any `.node` left on disk from
	// a previous release physically cannot expose the symbol the new `index.js`
	// expects. The JS loader derives `VERSION_SENTINEL_EXPORT` from `package.json`
	// at runtime, so the only thing that has to move on the Rust side is the
	// `js_name = "__piNativesV…"` literal. `gen-enums.ts` regenerates the matching
	// entries in `packages/natives/native/{index.d.ts,index.js}` on the next napi
	// build, but bump them here too so the committed surface tracks the version
	// without waiting for a local rebuild on the release host.
	console.log(`Bumping pi-natives version sentinel to v${version}…`);
	const sentinelJsId = version.replace(/[^A-Za-z0-9]/g, "_");
	const sentinelName = `__piNativesV${sentinelJsId}`;
	const sentinelFiles = [
		"crates/pi-natives/src/lib.rs",
		"packages/natives/native/index.d.ts",
		"packages/natives/native/index.js",
	];
	await $`sd '__piNativesV[A-Za-z0-9_]+' ${sentinelName} ${sentinelFiles}`;
	const libRs = await Bun.file("crates/pi-natives/src/lib.rs").text();
	if (!libRs.includes(`js_name = "${sentinelName}"`)) {
		console.error(
			`Error: pi-natives version sentinel did not move to ${sentinelName} in crates/pi-natives/src/lib.rs. ` +
				"The `__piNativesV…` literal may have been removed or renamed; restore it before releasing.",
		);
		process.exit(1);
	}
	console.log(`  sentinel: ${sentinelName}\n`);

	// 4. Regenerate lockfiles
	console.log("Regenerating lockfiles...");
	await guard("regenerate bun.lock + Cargo.lock", async () => {
		await $`rm -f bun.lock`;
		await $`bun install`;
		await $`cargo generate-lockfile`;
	});
	console.log();

	// 5. Update changelogs
	console.log("Updating CHANGELOGs...");
	// Omit `since` so the fixer resolves its own baseline: the `clog` tag (last
	// authoritative rewrite) when newer than `latestTag`, else `latestTag`. This
	// keeps a release run from re-promoting bullets a prior `--recover` restored.
	const fixResult = await runChangelogFixer({});
	for (const fixed of fixResult.changedFiles) {
		console.log(
			`  Fixed ${fixed.path}: ${fixed.promotedItems} promoted, ` +
				`${fixed.mergedDuplicateHeadings} duplicate heading(s) merged, ` +
				`${fixed.removedEmptyHeadings} empty heading(s) removed`,
		);
	}
	await guard("updateChangelogsForRelease", async () => {
		await updateChangelogsForRelease(version);
	});
	console.log();

	// 6. Run checks
	console.log("Running checks...");
	await guard("bun run check", async () => {
		await $`bun run check`;
	});
	console.log();

	// 7. Commit
	console.log("Committing...");
	await guard("git add + commit", async () => {
		await git(["add", "."]);
		await git(["commit", "-m", `chore: bump version to ${version}`]);
	});
	console.log();

	// 8. Tag, then push branch + tag atomically — pushing the tag by object id.
	//
	// This repo is in the global `[maintenance] repo = …` list, so a scheduled
	// `git maintenance run` fetches origin with `fetch.pruneTags=true` (set
	// globally) and deletes any local tag not yet on the remote — i.e. the
	// brand-new release tag. The `-c fetch.pruneTags=false` on our git wrapper
	// only governs our own git calls, not the concurrent maintenance process, so
	// a local tag ref may vanish before or while the push resolves it.
	//
	// A bare push refspec (`refs/tags/v…` with no `:dst`) re-resolves the tag on
	// disk during refspec matching (git's remote.c:match_explicit); if the prune
	// lands in that window git dies with
	// "refs/tags/v… cannot be resolved to branch", and if it lands before the
	// push it dies with "src refspec … does not match any". We sidestep both by
	// pushing the HEAD commit object id straight into the remote tag ref
	// (`<sha>:refs/tags/v…`): the push has no dependency on a local tag, and the
	// commit is reachable from main so maintenance cannot prune it. The local
	// tag we still create is only for `git describe`; losing it is harmless. The
	// default Git LFS pre-push hook uploads the branch's LFS objects as part of
	// this same atomic push — no separate `git lfs push` is needed.
	console.log("Tagging and pushing to remote...");
	// Nexus 扩展：useNexusTag=true 时使用 `nexus-v*` tag 前缀，触发 release.yml
	const tagRef = useNexusTag ? `nexus-v${version}` : `v${version}`;
	await guard(`git tag -f ${tagRef}`, async () => {
		await git(["tag", "-f", tagRef]);
	});
	await guard(`git push --atomic (main + ${tagRef})`, async () => {
		const sha = (await git(["rev-parse", "HEAD"]).text()).trim();
		await git(["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `${sha}:refs/tags/${tagRef}`]);
	});
	console.log();

	// 9. Watch CI
	if (dryRun) {
		console.log("[dry-run] 跳过 watch CI（dry-run 模式不推送，无 CI 可监听）\n");
		return;
	}
	console.log("Watching CI...");
	const success = await watchCI();

	if (success) {
		console.log(`=== Released v${version} ===`);
	} else {
		// CI's `concurrency` block (.github/workflows/ci.yml) recognizes a
		// release run by its `chore: bump version to vX.Y.Z` subject (#2564),
		// so retries that keep that subject also get the per-sha, never-cancel
		// group. Reword the body, not the subject.
		console.log("\nTo retry after fixing (repeat until CI passes):");
		console.log(`  git commit -m "chore: bump version to ${version}" -m "<what was fixed>"`);
		console.log(`  git tag -f v${version}`);
		console.log(
			`  git push --atomic origin refs/heads/main:refs/heads/main "+$(git rev-parse HEAD):refs/tags/v${version}"`,
		);
		console.log("  bun scripts/release.ts watch");
		process.exit(1);
	}
}

// =============================================================================
// Main
// =============================================================================

if (!positionalArg) {
	console.error("Usage:");
	console.error("  bun scripts/release.ts <version|major|minor|patch> [--dry-run] [--nexus]   Full release");
	console.error("  bun scripts/release.ts watch                                            Watch CI for current commit");
	console.error("");
	console.error("Examples:");
	console.error("  bun scripts/release.ts minor");
	console.error("  bun scripts/release.ts 1.0.0-beta --dry-run");
	console.error("  bun scripts/release.ts 1.0.0-beta --nexus");
	process.exit(1);
}

if (positionalArg === "watch") {
	await cmdWatch();
} else if (
	positionalArg === "major" ||
	positionalArg === "minor" ||
	positionalArg === "patch" ||
	/^\d+\.\d+\.\d+(-[a-z0-9][a-z0-9.\-]*)?$/i.test(positionalArg)
) {
	await cmdRelease(positionalArg);
} else {
	console.error(`Unknown command or invalid version: ${positionalArg}`);
	console.error("Usage:");
	console.error("  bun scripts/release.ts <version|major|minor|patch> [--dry-run] [--nexus]");
	console.error("  bun scripts/release.ts watch");
	process.exit(1);
}
