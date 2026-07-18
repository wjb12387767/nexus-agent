//! Bash 命令解析模块：使用 tree-sitter-bash 解析 bash 命令字符串，
//! 返回结构化的 AST 节点树，通过 NAPI 暴露给 TypeScript。
//!
//! 设计参考 `openclaude-main/src/utils/bash/parser.ts`：
//! - `MAX_COMMAND_LENGTH = 10000`：超长命令直接 abort，不进入 parser
//! - `PARSE_TIMEOUT = 50ms`：用 `std::time::Instant` 限制遍历耗时
//! - `MAX_NODES = 50_000`：遍历时节点计数，超限 abort
//! - 失败/超时返回 `aborted: true`（对应 OpenClaude 的 `PARSE_ABORTED` 符号）

use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tree_sitter::{Node as TSNode, Parser};

/// 命令字符串最大长度（与 openclaude `MAX_COMMAND_LENGTH` 对齐）。
const MAX_COMMAND_LENGTH: usize = 10_000;

/// 解析遍历的最大节点数预算（防止 OOM / 病态嵌套）。
const MAX_NODES: u32 = 50_000;

/// 解析遍历的墙钟超时（与 openclaude `PARSE_TIMEOUT_MS` 对齐）。
const PARSE_TIMEOUT: Duration = Duration::from_millis(50);

/// tree-sitter-bash AST 节点，递归结构。
#[napi(object)]
pub struct BashNode {
	/// tree-sitter 节点类型，如 "program"、"command"、"word"、"pipeline"。
	pub node_type:  String,
	/// 节点对应的原文切片（UTF-8）。
	pub text:       String,
	/// 起始字节偏移（UTF-8 字节索引，inclusive）。
	pub start_byte: u32,
	/// 结束字节偏移（UTF-8 字节索引，exclusive）。
	pub end_byte:   u32,
	/// 起始行（0-based）。
	pub start_row:  u32,
	/// 起始列（0-based 字节偏移）。
	pub start_col:  u32,
	/// 结束行（0-based）。
	pub end_row:    u32,
	/// 结束列（0-based 字节偏移）。
	pub end_col:    u32,
	/// 递归子节点列表。
	pub children:   Vec<BashNode>,
}

/// [`parse_bash_command`] 的返回结构。
#[napi(object)]
pub struct BashAstResult {
	/// 解析得到的根节点；空命令或 abort 时为 `None`。
	pub root_node:     Option<BashNode>,
	/// `true` = 解析超时 / 超 node budget / 解析失败 / 命令超长。
	pub aborted:       bool,
	/// 实际遍历到的节点数（abort 时为截断时的计数）。
	pub node_count:    u32,
	/// 解析 + 遍历总耗时（毫秒）。
	pub parse_time_ms: f64,
}

/// 解析 bash 命令字符串并返回结构化 AST。
///
/// 行为约定：
/// - 空命令：返回 `root_node: None, aborted: false`
/// - 命令长度 > 10000：直接返回 `aborted: true`，不进入 parser
/// - 解析失败 / 遍历超 50ms / 节点数 > 50000：返回 `aborted: true`
///
/// 根节点类型恒为 `"program"`（tree-sitter-bash 语法规定）；
/// pipeline / redirected_statement / declaration_command 等结构作为
/// program 的子节点出现。
#[napi]
pub fn parse_bash_command(command: String) -> Result<BashAstResult> {
	// 空命令：不 abort，root_node 为 None
	if command.is_empty() {
		return Ok(BashAstResult {
			root_node:     None,
			aborted:       false,
			node_count:    0,
			parse_time_ms: 0.0,
		});
	}

	// 超长命令：直接 abort，不进入 parser（与 openclaude 行为一致）
	if command.len() > MAX_COMMAND_LENGTH {
		return Ok(BashAstResult {
			root_node:     None,
			aborted:       true,
			node_count:    0,
			parse_time_ms: 0.0,
		});
	}

	let start = Instant::now();

	// 构造 parser 并设置 bash 语言
	let mut parser = Parser::new();
	parser
		.set_language(&tree_sitter_bash::LANGUAGE.into())
		.map_err(|e| Error::from_reason(format!("failed to set bash language: {e}")))?;

	// 解析命令字符串；返回 None 仅在带 cancellation flag 时发生，
	// 这里未使用 cancellation，正常情况下总能得到 Some(tree)。
	let tree = match parser.parse(&command, None) {
		Some(tree) => tree,
		None => {
			return Ok(BashAstResult {
				root_node:     None,
				aborted:       true,
				node_count:    0,
				parse_time_ms: elapsed_ms(start),
			});
		}
	};

	// 递归遍历构建 BashNode 树，期间检查 budget / timeout
	let mut node_count: u32 = 0;
	let root_ts_node = tree.root_node();
	let root_node = build_bash_node(root_ts_node, &command, &mut node_count, start);

	// build_bash_node 返回 None 的唯一路径是 budget / timeout 触发，
	// 因为 tree.root_node() 总是非 None。以此判定 aborted。
	let aborted = root_node.is_none();

	Ok(BashAstResult {
		root_node,
		aborted,
		node_count,
		parse_time_ms: elapsed_ms(start),
	})
}

/// 递归把 [`tree_sitter::Node`] 转换为 [`BashNode`]。
///
/// 每次进入节点时递增计数器并检查预算；超限 / 超时返回 `None`
/// 让上层短路。返回 `None` 仅表示「需要 abort」，调用方据此设置
/// `aborted = true`。
fn build_bash_node(
	node: TSNode,
	source: &str,
	node_count: &mut u32,
	start_time: Instant,
) -> Option<BashNode> {
	*node_count += 1;

	// 节点预算检查
	if *node_count > MAX_NODES {
		return None;
	}

	// 超时检查（每节点都查；遍历本身很快，开销可忽略）
	if start_time.elapsed() > PARSE_TIMEOUT {
		return None;
	}

	// 节点元数据
	let node_type = node.kind().to_string();
	// utf8_text 在源为合法 UTF-8 时不会失败；失败时退化为空串
	let text = node
		.utf8_text(source.as_bytes())
		.unwrap_or("")
		.to_string();
	let start_byte = node.start_byte() as u32;
	let end_byte = node.end_byte() as u32;
	let start_pos = node.start_position();
	let end_pos = node.end_position();

	// 递归子节点：用 cursor 迭代直接子节点
	let mut children: Vec<BashNode> = Vec::with_capacity(node.child_count());
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		match build_bash_node(child, source, node_count, start_time) {
			Some(c) => children.push(c),
			None => return None, // 子节点触发 abort，向上传播
		}
	}

	Some(BashNode {
		node_type,
		text,
		start_byte,
		end_byte,
		start_row: start_pos.row as u32,
		start_col: start_pos.column as u32,
		end_row: end_pos.row as u32,
		end_col: end_pos.column as u32,
		children,
	})
}

/// 计算自 `start` 以来的毫秒数（f64 保留亚毫秒精度）。
fn elapsed_ms(start: Instant) -> f64 {
	start.elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
	use super::*;

	/// 在 BashNode 树中深度优先搜索第一个匹配节点类型的节点。
	fn find_node_by_type<'a>(node: &'a BashNode, ty: &str) -> Option<&'a BashNode> {
		if node.node_type == ty {
			return Some(node);
		}
		for child in &node.children {
			if let Some(found) = find_node_by_type(child, ty) {
				return Some(found);
			}
		}
		None
	}

	#[test]
	fn test_parse_simple_command() {
		// `ls -la /tmp` → program > command(word, word, word)
		let result = parse_bash_command("ls -la /tmp".to_string())
			.expect("parse should not error on simple command");
		assert!(!result.aborted, "简单命令不应 abort");
		let root = result
			.root_node
			.as_ref()
			.expect("root_node should be present");
		assert_eq!(root.node_type, "program", "根节点类型应为 program");
		assert!(
			result.node_count > 0,
			"node_count 应大于 0（至少包含 root）"
		);
		assert!(
			find_node_by_type(root, "command").is_some(),
			"树中应包含 command 节点"
		);
		assert!(
			root.text.contains("ls"),
			"根节点文本应包含原命令"
		);
		assert!(
			result.parse_time_ms >= 0.0,
			"parse_time_ms 应为非负数"
		);
	}

	#[test]
	fn test_parse_pipeline() {
		// `cat foo | grep bar | wc -l` → program > pipeline(command, |, command, |, command)
		let result = parse_bash_command("cat foo | grep bar | wc -l".to_string())
			.expect("parse should not error on pipeline");
		assert!(!result.aborted, "pipeline 不应 abort");
		let root = result.root_node.as_ref().expect("root_node");
		assert_eq!(root.node_type, "program");
		// tree-sitter-bash 在 program 下挂 pipeline 节点
		assert!(
			find_node_by_type(root, "pipeline").is_some(),
			"树中应包含 pipeline 节点"
		);
	}

	#[test]
	fn test_parse_redirect() {
		// `echo hello > /tmp/out` → program > redirected_statement(command, file_redirect)
		let result = parse_bash_command("echo hello > /tmp/out".to_string())
			.expect("parse should not error on redirect");
		assert!(!result.aborted);
		let root = result.root_node.as_ref().expect("root_node");
		// 重定向会生成 file_redirect 节点（嵌套在 redirected_statement 内）
		assert!(
			find_node_by_type(root, "file_redirect").is_some(),
			"树中应包含 file_redirect 节点"
		);
	}

	#[test]
	fn test_parse_declare() {
		// `declare -n X=Y` → program > declaration_command
		let result = parse_bash_command("declare -n X=Y".to_string())
			.expect("parse should not error on declare");
		assert!(!result.aborted);
		let root = result.root_node.as_ref().expect("root_node");
		assert!(
			find_node_by_type(root, "declaration_command").is_some(),
			"树中应包含 declaration_command 节点"
		);
	}

	#[test]
	fn test_parse_too_long() {
		// 超过 10000 字符的命令必须直接 abort，不进入 parser
		let cmd = "a".repeat(MAX_COMMAND_LENGTH + 1);
		assert_eq!(cmd.len(), 10_001);
		let result = parse_bash_command(cmd)
			.expect("over-length input should not return Err");
		assert!(
			result.aborted,
			"超长命令必须 abort"
		);
		assert!(
			result.root_node.is_none(),
			"超长命令不应产生 root_node"
		);
		assert_eq!(
			result.node_count, 0,
			"超长命令不应进入遍历，node_count 应为 0"
		);
	}

	#[test]
	fn test_parse_empty() {
		// 空命令：root_node 为 None，但不 abort
		let result = parse_bash_command(String::new())
			.expect("empty input should not return Err");
		assert!(
			!result.aborted,
			"空命令不应 abort"
		);
		assert!(
			result.root_node.is_none(),
			"空命令的 root_node 应为 None"
		);
		assert_eq!(result.node_count, 0);
	}

	#[test]
	fn test_parse_at_length_boundary() {
		// 恰好 10000 字符的命令应正常解析（边界检查用 `>` 而非 `>=`）
		let cmd = "a".repeat(MAX_COMMAND_LENGTH);
		assert_eq!(cmd.len(), 10_000);
		let result = parse_bash_command(cmd)
			.expect("boundary-length input should not return Err");
		assert!(
			!result.aborted,
			"恰好 10000 字符的命令不应 abort"
		);
		assert!(result.root_node.is_some());
	}

	#[test]
	fn test_parse_node_metadata_sane() {
		// 验证节点元数据（byte/row/col）合理
		let result = parse_bash_command("echo hi".to_string())
			.expect("parse should not error");
		let root = result.root_node.as_ref().expect("root_node");
		assert_eq!(root.start_byte, 0);
		assert_eq!(root.end_byte, 7, "echo hi 共 7 字节");
		assert_eq!(root.start_row, 0);
		assert_eq!(root.start_col, 0);
		// 子节点 word "echo" 应在字节 0..4
		let cmd = find_node_by_type(root, "command").expect("command node");
		let word = cmd
			.children
			.iter()
			.find(|c| c.node_type == "command_name")
			.or_else(|| cmd.children.iter().find(|c| c.node_type == "word"))
			.expect("should find command_name or word child");
		assert_eq!(word.start_byte, 0);
		assert_eq!(word.end_byte, 4);
		assert_eq!(word.text, "echo");
	}
}
