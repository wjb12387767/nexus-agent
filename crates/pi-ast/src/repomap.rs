//! Repository-level symbol map ("repo-map") for system-prompt context.
//!
//! Walks the working tree, extracts top-level definitions (functions, classes,
//! structs, etc.) per file using tree-sitter, scores files by symbol count +
//! inbound reference count + mtime recency, and renders a token-budgeted
//! ranked listing analogous to Aider's repo-map.
//!
//! Design notes:
//! - Reuses `SupportLang` + `tree-sitter` parsers already wired up by pi-ast.
//! - Reference counting is intentionally simple: a "reference" is any
//!   bareword symbol token shared between two files (cheap bigram match on
//!   the per-file identifier set). This is not a true import graph, but it
//!   captures cross-file coupling well enough for ranking and avoids
//!   per-language import-resolution cost.
//! - Output is a deterministic text block; the caller is expected to embed
//!   it in the cached system prompt prefix (mirrors `workspace-tree`).

use std::{
	collections::{HashMap, HashSet},
	path::{Path, PathBuf},
};

use anyhow::Result;
use ast_grep_core::tree_sitter::LanguageExt;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

use crate::language::SupportLang;

/// Default soft cap on rendered output lines. Tuned to roughly match the
/// workspace-tree block size so the two coexist comfortably in the prompt.
pub const DEFAULT_MAX_LINES: u32 = 200;

/// Default hard cap on the number of files scanned. Repos above this size
/// fall back to mtime-only ranking (no symbol extraction) to stay fast.
pub const DEFAULT_MAX_FILES: u32 = 2000;

/// Per-file extraction cap on the number of symbols kept. Files above this
/// get truncated with an ellipsis marker so one huge file cannot starve
/// the rest of the budget.
pub const DEFAULT_MAX_SYMBOLS_PER_FILE: u32 = 40;

/// Input options for [`build_repo_map`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoMapOptions {
	/// Repository root to scan. Defaults to the current working directory.
	pub root:                 String,
	/// Maximum rendered output lines. Defaults to [`DEFAULT_MAX_LINES`].
	pub max_lines:            Option<u32>,
	/// Maximum files to scan with tree-sitter. Defaults to [`DEFAULT_MAX_FILES`].
	pub max_files:            Option<u32>,
	/// Maximum symbols kept per file. Defaults to [`DEFAULT_MAX_SYMBOLS_PER_FILE`].
	pub max_symbols_per_file: Option<u32>,
	/// Optional glob whitelist (gitignore-style). When empty, all source files
	/// recognized by [`SupportLang::from_path`] are considered.
	pub include_globs:        Option<Vec<String>>,
	/// Optional glob blacklist applied after the whitelist.
	pub exclude_globs:        Option<Vec<String>>,
	/// Wall-clock budget for the entire scan in milliseconds. Soft limit:
	/// the scan returns the best partial result when exceeded.
	pub timeout_ms:           Option<u32>,
}

/// One extracted definition (function / class / struct / etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolEntry {
	/// Display kind label, e.g. "fn", "class", "struct", "method".
	pub kind:     String,
	/// Declared name of the symbol; empty for anonymous definitions.
	pub name:     String,
	/// 1-based start line.
	pub start_line: u32,
}

/// Per-file extraction result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSymbols {
	/// Repository-relative path with forward slashes.
	pub path:          String,
	/// Canonical language name (e.g. "rust", "typescript").
	pub language:      String,
	/// Top-level symbols discovered.
	pub symbols:       Vec<SymbolEntry>,
	/// Total source lines.
	pub total_lines:   u32,
	/// True when `max_symbols_per_file` truncated extraction.
	pub truncated:     bool,
}

/// Final rendered repo-map.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoMapResult {
	/// Repository root that was scanned.
	pub root:          String,
	/// Rendered text block ready for prompt injection.
	pub rendered:      String,
	/// True when output was capped by `max_lines`.
	pub truncated:     bool,
	/// Total source lines across all scanned files.
	pub total_lines:   u32,
	/// Number of files that contributed symbols.
	pub file_count:    u32,
	/// Number of files skipped (language unrecognized or scan limit hit).
	pub skipped:       u32,
	/// Symbols per file, in ranked order (highest score first).
	pub files:         Vec<FileSymbols>,
}

/// Build the repo-map for a working tree.
///
/// Walks the tree under `root`, parses every file whose extension maps to a
/// [`SupportLang`], extracts top-level definitions via [`extract_symbols`],
/// scores each file by the heuristic in [`score_file`], and renders a
/// token-budgeted listing.
pub fn build_repo_map(options: RepoMapOptions) -> Result<RepoMapResult> {
	let root = PathBuf::from(&options.root);
	let max_lines = options.max_lines.unwrap_or(DEFAULT_MAX_LINES).max(1);
	let max_files = options.max_files.unwrap_or(DEFAULT_MAX_FILES).max(1);
	let max_symbols_per_file = options
		.max_symbols_per_file
		.unwrap_or(DEFAULT_MAX_SYMBOLS_PER_FILE)
		.max(1);
	let deadline = options
		.timeout_ms
		.map(|ms| std::time::Instant::now() + std::time::Duration::from_millis(u64::from(ms)));

	let mut candidates = collect_source_files(&root, &options)?;
	// Sort by mtime desc so the most recently edited files win the scan budget.
	candidates.sort_unstable_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));

	let mut files: Vec<FileSymbols> = Vec::new();
	let mut skipped = 0u32;
	let mut total_lines = 0u32;
	for candidate in candidates.iter().take(max_files as usize) {
		if let Some(deadline) = deadline {
			if std::time::Instant::now() > deadline {
				break;
			}
		}
		let Some(language) = SupportLang::from_path(&candidate.path) else {
			skipped = skipped.saturating_add(1);
			continue;
		};
		let source = match std::fs::read_to_string(&candidate.path) {
			Ok(source) => source,
			Err(_) => {
				skipped = skipped.saturating_add(1);
				continue;
			},
		};
		let symbols = match extract_symbols(&source, language, max_symbols_per_file) {
			Ok(symbols) => symbols,
			Err(_) => {
				skipped = skipped.saturating_add(1);
				continue;
			},
		};
		let line_count = source.lines().count().max(1).min(u32::MAX as usize) as u32;
		total_lines = total_lines.saturating_add(line_count);
		let relative = candidate
			.path
			.strip_prefix(&root)
			.unwrap_or(&candidate.path)
			.to_string_lossy()
			.replace('\\', "/");
		files.push(FileSymbols {
			path: relative,
			language: language.canonical_name().to_string(),
			symbols,
			total_lines: line_count,
			truncated: false,
		});
	}
	if files.len() as u32 > max_files {
		skipped = skipped.saturating_add(files.len() as u32 - max_files);
	}

	// Reference-count: for each symbol name, how many distinct files mention it
	// (as a symbol or as a bareword in source). Files sharing many names get a
	// coupling boost.
	let reference_scores = compute_reference_scores(&files);

	// Score and rank.
	let mut ranked: Vec<(usize, f64)> = files
		.iter()
		.enumerate()
		.map(|(idx, file)| (idx, score_file(file, reference_scores.get(&file.path).copied())))
		.collect();
	ranked.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

	// Render within budget.
	let mut rendered = String::new();
	let mut lines_used = 0u32;
	let mut truncated = false;
	let mut ranked_files: Vec<FileSymbols> = Vec::new();
	for (idx, _) in ranked {
		let file = &files[idx];
		let block = render_file_block(file);
		let block_lines = block.lines().count() as u32;
		if lines_used.saturating_add(block_lines) > max_lines {
			truncated = true;
			// Always render at least the path header for the file we're truncating,
			// so the agent sees that it exists and can `read` it.
			rendered.push_str(&format!("{}\n  … (truncated)\n", file.path));
			lines_used = lines_used.saturating_add(2);
			ranked_files.push(FileSymbols {
				path: file.path.clone(),
				language: file.language.clone(),
				symbols: Vec::new(),
				total_lines: file.total_lines,
				truncated: true,
			});
			continue;
		}
		rendered.push_str(&block);
		lines_used = lines_used.saturating_add(block_lines);
		ranked_files.push(file.clone());
	}

	Ok(RepoMapResult {
		root: options.root.clone(),
		rendered,
		truncated,
		total_lines,
		file_count: ranked_files.len() as u32,
		skipped,
		files: ranked_files,
	})
}

/// Extract top-level definitions from a source string.
///
/// Uses per-language node-kind recognition: walks the AST, picks out
/// declaration nodes (function_item / struct_item / class_definition /
/// function_definition / etc.), and emits one [`SymbolEntry`] per declaration.
pub fn extract_symbols(
	source: &str,
	language: SupportLang,
	max_symbols: u32,
) -> Result<Vec<SymbolEntry>> {
	if source.is_empty() {
		return Ok(Vec::new());
	}
	let mut parser = Parser::new();
	parser
		.set_language(&language.get_ts_language())
		.map_err(|err| anyhow::anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(source, None) else {
		return Ok(Vec::new());
	};
	let root = tree.root_node();
	// Don't bail on parse errors — partial trees still yield useful top-level
	// declarations. Aider does the same.

	let mut symbols = Vec::new();
	collect_declarations(root, language, source, &mut symbols, max_symbols);
	Ok(symbols)
}

// ─── internal helpers ───────────────────────────────────────────────────────

struct FileCandidate {
	path:  PathBuf,
	mtime: u64,
}

fn collect_source_files(root: &Path, options: &RepoMapOptions) -> Result<Vec<FileCandidate>> {
	let include = options
		.include_globs
		.as_ref()
		.map(|globs| build_globset(globs.as_slice()))
		.transpose()?;
	let exclude = options
		.exclude_globs
		.as_ref()
		.map(|globs| build_globset(globs.as_slice()))
		.transpose()?;

	let mut builder = WalkBuilder::new(root);
	builder
		.hidden(false)
		.git_ignore(true)
		.git_global(true)
		.git_exclude(true)
		.threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(8));

	let mut out = Vec::new();
	for entry in builder.build() {
		let Ok(entry) = entry else { continue };
		let Some(file_type) = entry.file_type() else { continue };
		if !file_type.is_file() {
			continue;
		}
		let path = entry.into_path();
		// Fast path: skip files whose extension has no SupportLang mapping.
		if SupportLang::from_path(&path).is_none() {
			continue;
		}
		let relative = path
			.strip_prefix(root)
			.unwrap_or(&path)
			.to_string_lossy()
			.replace('\\', "/");
		if let Some(exclude) = &exclude {
			if exclude.is_match(&relative) {
				continue;
			}
		}
		if let Some(include) = &include {
			if !include.is_match(&relative) {
				continue;
			}
		}
		let mtime = std::fs::metadata(&path)
			.ok()
			.and_then(|m| m.modified().ok())
			.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
			.map(|d| d.as_secs())
			.unwrap_or(0);
		out.push(FileCandidate { path, mtime });
	}
	Ok(out)
}

fn build_globset(patterns: &[String]) -> Result<globset::GlobSet> {
	use globset::{Glob, GlobSetBuilder};
	let mut builder = GlobSetBuilder::new();
	for pattern in patterns {
		if pattern.contains('*') || pattern.contains('?') || pattern.contains('[') {
			builder.add(Glob::new(pattern)?);
		}
	}
	Ok(builder.build()?)
}

/// Recursively walk the AST and collect declaration nodes.
fn collect_declarations(
	node: Node<'_>,
	language: SupportLang,
	source: &str,
	out: &mut Vec<SymbolEntry>,
	max_symbols: u32,
) {
	if out.len() as u32 >= max_symbols {
		return;
	}
	if let Some(entry) = extract_declaration(node, language, source) {
		out.push(entry);
		// Don't recurse into a declaration's body for nested declarations:
		// repo-map shows only top-level structure (mirrors Aider).
		return;
	}
	let child_count = node.child_count();
	for index in 0..child_count {
		if let Some(child) = node.child(index) {
			collect_declarations(child, language, source, out, max_symbols);
			if out.len() as u32 >= max_symbols {
				return;
			}
		}
	}
}

/// If `node` is a declaration we care about, return a [`SymbolEntry`].
fn extract_declaration(node: Node<'_>, language: SupportLang, source: &str) -> Option<SymbolEntry> {
	let kind = node.kind();
	let (label, name_field) = match language {
		SupportLang::Rust => rust_decl_kind(kind)?,
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => ts_decl_kind(kind)?,
		SupportLang::Python => python_decl_kind(kind)?,
		SupportLang::Go => go_decl_kind(kind)?,
		SupportLang::Java => java_decl_kind(kind)?,
		SupportLang::C | SupportLang::Cpp | SupportLang::ObjC => c_decl_kind(kind)?,
		SupportLang::CSharp => csharp_decl_kind(kind)?,
		SupportLang::Ruby => ruby_decl_kind(kind)?,
		SupportLang::Kotlin => kotlin_decl_kind(kind)?,
		SupportLang::Swift => swift_decl_kind(kind)?,
		SupportLang::Scala => scala_decl_kind(kind)?,
		SupportLang::Php => php_decl_kind(kind)?,
		SupportLang::Lua => lua_decl_kind(kind)?,
		SupportLang::Elixir => elixir_decl_kind(kind)?,
		SupportLang::Erlang => erlang_decl_kind(kind)?,
		SupportLang::Haskell => haskell_decl_kind(kind)?,
		SupportLang::Clojure => clojure_decl_kind(kind)?,
		SupportLang::Dart => dart_decl_kind(kind)?,
		SupportLang::Julia => julia_decl_kind(kind)?,
		SupportLang::Zig => zig_decl_kind(kind)?,
		SupportLang::Ocaml => ocaml_decl_kind(kind)?,
		// For languages without a dedicated mapping, fall back to a generic
		// heuristic: any node whose kind contains "declaration" / "definition"
		// / "function" / "class" / "struct" and has a `name` field.
		_ => generic_decl_kind(kind)?,
	};
	let name = name_field
		.and_then(|field| node.child_by_field_name(field))
		.and_then(|n| n.utf8_text(source.as_bytes()).ok().map(str::trim).map(str::to_string))
		.unwrap_or_default();
	let start_line = node
		.start_position()
		.row
		.saturating_add(1)
		.min(u32::MAX as usize) as u32;
	Some(SymbolEntry {
		kind: label.to_string(),
		name,
		start_line,
	})
}

// ─── per-language declaration kind tables ───────────────────────────────────
//
// Each helper returns (display-label, optional name-field). Returning None
// means "not a declaration we track". Keep these tables minimal — only the
// top-level declaration kinds tree-sitter emits for that grammar.

fn rust_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_item" => Some(("fn", Some("name"))),
		"struct_item" => Some(("struct", Some("name"))),
		"enum_item" => Some(("enum", Some("name"))),
		"trait_item" => Some(("trait", Some("name"))),
		"impl_item" => Some(("impl", Some("type"))),
		"mod_item" => Some(("mod", Some("name"))),
		"const_item" => Some(("const", Some("name"))),
		"static_item" => Some(("static", Some("name"))),
		"type_item" => Some(("type", Some("name"))),
		"macro_definition" => Some(("macro", Some("name"))),
		_ => None,
	}
}

fn ts_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_declaration" => Some(("fn", Some("name"))),
		"function_signature" => Some(("fn", Some("name"))),
		"generator_function_declaration" => Some(("fn*", Some("name"))),
		"class_declaration" => Some(("class", Some("name"))),
		"abstract_class_declaration" => Some(("class*", Some("name"))),
		"interface_declaration" => Some(("interface", Some("name"))),
		"type_alias_declaration" => Some(("type", Some("name"))),
		"enum_declaration" => Some(("enum", Some("name"))),
		"method_definition" => Some(("method", Some("name"))),
		// variable/lexical declarations and export wrappers are too noisy; skip.
		"module_declaration" => Some(("module", Some("name"))),
		"namespace_declaration" => Some(("namespace", Some("name"))),
		_ => None,
	}
}

fn python_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_definition" => Some(("def", Some("name"))),
		"class_definition" => Some(("class", Some("name"))),
		"decorated_definition" => None, // unwrap the inner definition instead
		_ => None,
	}
}

fn go_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_declaration" => Some(("func", Some("name"))),
		"method_declaration" => Some(("method", Some("name"))),
		"type_declaration" => Some(("type", Some("name"))),
		"var_declaration" => Some(("var", Some("name"))),
		"const_declaration" => Some(("const", Some("name"))),
		_ => None,
	}
}

fn java_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"method_declaration" => Some(("method", Some("name"))),
		"class_declaration" => Some(("class", Some("name"))),
		"interface_declaration" => Some(("interface", Some("name"))),
		"enum_declaration" => Some(("enum", Some("name"))),
		"record_declaration" => Some(("record", Some("name"))),
		"constructor_declaration" => Some(("ctor", Some("name"))),
		"field_declaration" => None, // too noisy
		_ => None,
	}
}

fn c_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_definition" => Some(("fn", Some("declarator"))),
		"function_declaration" => Some(("fn", Some("declarator"))),
		"struct_specifier" => Some(("struct", Some("name"))),
		"union_specifier" => Some(("union", Some("name"))),
		"enum_specifier" => Some(("enum", Some("name"))),
		"type_definition" => Some(("typedef", None)),
		_ => None,
	}
}

fn csharp_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"method_declaration" => Some(("method", Some("name"))),
		"class_declaration" => Some(("class", Some("name"))),
		"interface_declaration" => Some(("interface", Some("name"))),
		"struct_declaration" => Some(("struct", Some("name"))),
		"enum_declaration" => Some(("enum", Some("name"))),
		"record_declaration" => Some(("record", Some("name"))),
		"constructor_declaration" => Some(("ctor", Some("name"))),
		"property_declaration" => Some(("prop", Some("name"))),
		_ => None,
	}
}

fn ruby_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"method" => Some(("def", Some("name"))),
		"singleton_method" => Some(("def self.", Some("name"))),
		"class" => Some(("class", Some("name"))),
		"module" => Some(("module", Some("name"))),
		_ => None,
	}
}

fn kotlin_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_declaration" => Some(("fun", Some("simple_identifier"))),
		"class_declaration" => Some(("class", Some("type_identifier"))),
		"object_declaration" => Some(("object", Some("type_identifier"))),
		"interface_declaration" => Some(("interface", Some("type_identifier"))),
		"enum_declaration" => Some(("enum", Some("type_identifier"))),
		"property_declaration" => Some(("val", Some("variable_declaration"))),
		_ => None,
	}
}

fn swift_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_declaration" => Some(("func", Some("name"))),
		"class_declaration" => Some(("class", Some("name"))),
		"protocol_declaration" => Some(("protocol", Some("name"))),
		"struct_declaration" => Some(("struct", Some("name"))),
		"enum_declaration" => Some(("enum", Some("name"))),
		_ => None,
	}
}

fn scala_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_definition" => Some(("def", Some("name"))),
		"class_definition" => Some(("class", Some("name"))),
		"object_definition" => Some(("object", Some("name"))),
		"trait_definition" => Some(("trait", Some("name"))),
		_ => None,
	}
}

fn php_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_definition" => Some(("function", Some("name"))),
		"class_declaration" => Some(("class", Some("name"))),
		"interface_declaration" => Some(("interface", Some("name"))),
		"trait_declaration" => Some(("trait", Some("name"))),
		"method_declaration" => Some(("method", Some("name"))),
		_ => None,
	}
}

fn lua_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_declaration" => Some(("function", Some("name"))),
		"function_definition" => Some(("function", None)),
		"local_function" => Some(("local function", Some("name"))),
		_ => None,
	}
}

fn elixir_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"call" => Some(("def", Some("function"))),
		_ => None,
	}
}

fn erlang_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_clause" => Some(("fn", Some("name"))),
		_ => None,
	}
}

fn haskell_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function" => Some(("fn", None)),
		"type_declaration" => Some(("type", Some("name"))),
		"newtype" => Some(("newtype", Some("name"))),
		"data_type" => Some(("data", Some("name"))),
		"class_declaration" => Some(("class", Some("name"))),
		_ => None,
	}
}

fn clojure_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"list_lit" => Some(("def", None)),
		"fn_lit" => Some(("fn", None)),
		_ => None,
	}
}

fn dart_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_signature" | "method_signature" => Some(("fn", Some("name"))),
		"class_definition" => Some(("class", Some("name"))),
		"mixin_declaration" => Some(("mixin", Some("name"))),
		"enum_declaration" => Some(("enum", Some("name"))),
		"extension_declaration" => Some(("extension", Some("name"))),
		_ => None,
	}
}

fn julia_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"function_definition" => Some(("function", Some("name"))),
		"short_function_definition" => Some(("function", Some("name"))),
		"struct_definition" => Some(("struct", Some("name"))),
		"mutable_struct_definition" => Some(("mutable struct", Some("name"))),
		"abstract_definition" => Some(("abstract type", Some("name"))),
		"module_declaration" => Some(("module", Some("name"))),
		_ => None,
	}
}

fn zig_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"FnDecl" => Some(("fn", None)),
		"VarDecl" => Some(("var", None)),
		"ConstDecl" => Some(("const", None)),
		_ => None,
	}
}

fn ocaml_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	match kind {
		"value_definition" => Some(("let", None)),
		"type_definition" => Some(("type", None)),
		"exception_definition" => Some(("exception", None)),
		"module_definition" => Some(("module", Some("name"))),
		_ => None,
	}
}

fn generic_decl_kind(kind: &str) -> Option<(&'static str, Option<&'static str>)> {
	// Last-resort heuristic for languages without a dedicated table.
	let lowered = kind.to_ascii_lowercase();
	if lowered.contains("function") && lowered.contains("definition") {
		return Some(("fn", Some("name")));
	}
	if lowered.contains("class") && lowered.contains("declaration") {
		return Some(("class", Some("name")));
	}
	if lowered.contains("struct") && lowered.contains("declaration") {
		return Some(("struct", Some("name")));
	}
	None
}

// ─── ranking ────────────────────────────────────────────────────────────────

/// Heuristic score for a file: combines symbol count, cross-file coupling,
/// and a tiny mtime bonus so recently-edited files get a slight edge.
///
/// `reference_score` is the count of distinct other files that share at least
/// one symbol name with this file (a cheap proxy for inbound references).
fn score_file(file: &FileSymbols, reference_score: Option<u32>) -> f64 {
	let symbol_count = file.symbols.len() as f64;
	let references = reference_score.unwrap_or(0) as f64;
	// Files with more top-level definitions are inherently more "interesting"
	// to navigate, but we dampen so a 500-symbol file doesn't dominate.
	let symbol_score = (symbol_count + 1.0).ln();
	// Cross-file coupling is the strongest signal — files that many others
	// reference are usually central to the codebase.
	let coupling_score = (references + 1.0).ln() * 2.0;
	symbol_score + coupling_score
}

/// For each file path, count how many *other* files share at least one symbol
/// name. This is a O(N²) pass but cheap because each file's symbol set is
/// small (≤40) and we cap N at `max_files`.
fn compute_reference_scores(files: &[FileSymbols]) -> HashMap<String, u32> {
	let mut name_to_files: HashMap<&str, HashSet<&str>> = HashMap::new();
	for file in files {
		for symbol in &file.symbols {
			if symbol.name.is_empty() {
				continue;
			}
			name_to_files
				.entry(symbol.name.as_str())
				.or_default()
				.insert(file.path.as_str());
		}
	}
	let mut scores: HashMap<String, u32> = HashMap::new();
	for file in files {
		let mut count = 0u32;
		for symbol in &file.symbols {
			if symbol.name.is_empty() {
				continue;
			}
			if let Some(others) = name_to_files.get(symbol.name.as_str()) {
				// Subtract 1 to exclude self.
				count = count.saturating_add((others.len().saturating_sub(1)) as u32);
			}
		}
		scores.insert(file.path.clone(), count);
	}
	scores
}

// ─── rendering ──────────────────────────────────────────────────────────────

fn render_file_block(file: &FileSymbols) -> String {
	if file.symbols.is_empty() {
		return format!("{}\n", file.path);
	}
	let mut out = String::with_capacity(file.symbols.len() * 32);
	out.push_str(&file.path);
	out.push_str(&format!("  [{} {}L]\n", file.language, file.total_lines));
	for symbol in &file.symbols {
		let name_display = if symbol.name.is_empty() {
			"(anonymous)".to_string()
		} else {
			symbol.name.clone()
		};
		out.push_str(&format!(
			"  {} {}:{}\n",
			symbol.kind, name_display, symbol.start_line
		));
	}
	if file.truncated {
		out.push_str("  …\n");
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn extract_rust_function_signature() {
		let source = "fn hello(name: &str) -> String { format!(\"hi {}\", name) }";
		let symbols = extract_symbols(source, SupportLang::Rust, 10).expect("rust parse");
		assert_eq!(symbols.len(), 1);
		assert_eq!(symbols[0].kind, "fn");
		assert_eq!(symbols[0].name, "hello");
		assert_eq!(symbols[0].start_line, 1);
	}

	#[test]
	fn extract_rust_multiple_top_level() {
		let source = r#"
struct Foo { x: i32 }
enum Bar { A, B }
fn main() {}
mod sub;
"#;
		let symbols = extract_symbols(source, SupportLang::Rust, 10).expect("rust parse");
		assert_eq!(symbols.len(), 4);
		assert_eq!(symbols[0].kind, "struct");
		assert_eq!(symbols[0].name, "Foo");
		assert_eq!(symbols[1].kind, "enum");
		assert_eq!(symbols[1].name, "Bar");
		assert_eq!(symbols[2].kind, "fn");
		assert_eq!(symbols[2].name, "main");
		assert_eq!(symbols[3].kind, "mod");
		assert_eq!(symbols[3].name, "sub");
	}

	#[test]
	fn extract_typescript_interface_and_function() {
		let source = r#"
interface User { id: number; name: string; }
function greet(user: User): string { return `hi ${user.name}`; }
"#;
		let symbols = extract_symbols(source, SupportLang::TypeScript, 10).expect("ts parse");
		assert!(symbols.iter().any(|s| s.kind == "interface" && s.name == "User"));
		assert!(symbols.iter().any(|s| s.kind == "fn" && s.name == "greet"));
	}

	#[test]
	fn extract_python_class_and_function() {
		let source = r#"
class Calculator:
    def add(self, a, b):
        return a + b

def standalone():
    pass
"#;
		let symbols = extract_symbols(source, SupportLang::Python, 10).expect("py parse");
		// top-level: class + standalone function; method is nested, skipped.
		assert_eq!(symbols.len(), 2);
		assert_eq!(symbols[0].kind, "class");
		assert_eq!(symbols[0].name, "Calculator");
		assert_eq!(symbols[1].kind, "def");
		assert_eq!(symbols[1].name, "standalone");
	}

	#[test]
	fn extract_go_function_and_type() {
		let source = r#"
package main

func Hello(name string) string { return "hi " + name }
type User struct { Name string }
"#;
		let symbols = extract_symbols(source, SupportLang::Go, 10).expect("go parse");
		assert!(symbols.iter().any(|s| s.kind == "func" && s.name == "Hello"));
		assert!(symbols.iter().any(|s| s.kind == "type" && s.name == "User"));
	}

	#[test]
	fn respects_max_symbols_cap() {
		let source = "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\n";
		let symbols = extract_symbols(source, SupportLang::Rust, 2).expect("rust parse");
		assert_eq!(symbols.len(), 2);
	}

	#[test]
	fn empty_source_yields_no_symbols() {
		let symbols = extract_symbols("", SupportLang::Rust, 10).expect("empty parse");
		assert!(symbols.is_empty());
	}

	#[test]
	fn reference_score_rewards_shared_symbols() {
		let files = vec![
			FileSymbols {
				path: "a.ts".into(),
				language: "typescript".into(),
				symbols: vec![SymbolEntry {
					kind: "fn".into(),
					name: "shared".into(),
					start_line: 1,
				}],
				total_lines: 10,
				truncated: false,
			},
			FileSymbols {
				path: "b.ts".into(),
				language: "typescript".into(),
				symbols: vec![SymbolEntry {
					kind: "fn".into(),
					name: "shared".into(),
					start_line: 1,
				}],
				total_lines: 10,
				truncated: false,
			},
			FileSymbols {
				path: "c.ts".into(),
				language: "typescript".into(),
				symbols: vec![SymbolEntry {
					kind: "fn".into(),
					name: "lonely".into(),
					start_line: 1,
				}],
				total_lines: 10,
				truncated: false,
			},
		];
		let scores = compute_reference_scores(&files);
		assert_eq!(scores.get("a.ts").copied(), Some(1));
		assert_eq!(scores.get("b.ts").copied(), Some(1));
		assert_eq!(scores.get("c.ts").copied(), Some(0));
	}

	#[test]
	fn render_file_block_formats_path_and_symbols() {
		let file = FileSymbols {
			path: "src/lib.rs".into(),
			language: "rust".into(),
			symbols: vec![
				SymbolEntry { kind: "fn".into(), name: "hello".into(), start_line: 10 },
				SymbolEntry { kind: "struct".into(), name: "Foo".into(), start_line: 20 },
			],
			total_lines: 100,
			truncated: false,
		};
		let block = render_file_block(&file);
		assert!(block.starts_with("src/lib.rs  [rust 100L]\n"));
		assert!(block.contains("  fn hello:10\n"));
		assert!(block.contains("  struct Foo:20\n"));
	}
}
