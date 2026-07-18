/**
 * `@oh-my-pi/pi-natives` 模块补充声明。
 *
 * `crates/pi-natives/src/bash_ast.rs` 通过 `#[napi]` 暴露了 `parseBashCommand`，
 * 但 `packages/natives/native/index.d.ts` 是 NAPI-RS 自动生成的，需要重新
 * `napi build` 才会刷新。本文件在重新生成前补上类型，让本包可以正常
 * 通过 `tsgo --noEmit`；重新 build 后两份声明会合并为同一类型，无冲突。
 */
declare module "@oh-my-pi/pi-natives" {
	export interface BashNode {
		node_type: string;
		text: string;
		start_byte: number;
		end_byte: number;
		start_row: number;
		start_col: number;
		end_row: number;
		end_col: number;
		children: BashNode[];
	}

	export interface BashAstResult {
		root_node: BashNode | null;
		aborted: boolean;
		node_count: number;
		parse_time_ms: number;
	}

	/**
	 * 解析 bash 命令字符串并返回结构化 AST。
	 * 对应 `crates/pi-natives/src/bash_ast.rs::parse_bash_command`。
	 */
	export function parseBashCommand(command: string): BashAstResult;
}
