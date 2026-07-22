//! NAPI bindings for the repo-map module.
//!
//! Exposes [`pi_ast::repomap::build_repo_map`] as `buildRepoMap` to JS.
//! Mirrors the pattern used by `summary.rs` (sync napi function) and
//! `ast.rs` (async `task::blocking` for longer scans). Because repo-map
//! scans can touch thousands of files, we use the async `task::blocking`
//! path so the JS event loop is not blocked.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Options for [`build_repo_map`].
#[napi(object)]
pub struct RepoMapOptions {
	/// Repository root to scan (absolute path recommended).
	pub root:                 String,
	/// Maximum rendered output lines. Defaults to 200.
	pub max_lines:            Option<u32>,
	/// Maximum files to scan with tree-sitter. Defaults to 2000.
	pub max_files:            Option<u32>,
	/// Maximum symbols kept per file. Defaults to 40.
	pub max_symbols_per_file: Option<u32>,
	/// Optional gitignore-style glob whitelist.
	pub include_globs:        Option<Vec<String>>,
	/// Optional glob blacklist applied after the whitelist.
	pub exclude_globs:        Option<Vec<String>>,
	/// Wall-clock budget in milliseconds. Soft limit.
	pub timeout_ms:           Option<u32>,
	/// Optional cancellation signal (AbortSignal).
	pub signal:               Option<Unknown<'static>>,
}

/// One extracted definition.
#[napi(object)]
pub struct SymbolEntry {
	/// Display kind label, e.g. "fn", "class", "struct".
	pub kind:       String,
	/// Declared name; empty for anonymous definitions.
	pub name:       String,
	/// 1-based start line.
	pub start_line: u32,
}

/// Per-file extraction result.
#[napi(object)]
pub struct FileSymbols {
	/// Repository-relative path with forward slashes.
	pub path:        String,
	/// Canonical language name (e.g. "rust", "typescript").
	pub language:    String,
	/// Top-level symbols discovered.
	pub symbols:     Vec<SymbolEntry>,
	/// Total source lines.
	pub total_lines: u32,
	/// True when `max_symbols_per_file` truncated extraction.
	pub truncated:   bool,
}

/// Final rendered repo-map result.
#[napi(object)]
pub struct RepoMapResult {
	/// Repository root that was scanned.
	pub root:        String,
	/// Rendered text block ready for prompt injection.
	pub rendered:    String,
	/// True when output was capped by `max_lines`.
	pub truncated:   bool,
	/// Total source lines across all scanned files.
	pub total_lines: u32,
	/// Number of files that contributed symbols.
	pub file_count:  u32,
	/// Number of files skipped (language unrecognized or scan limit hit).
	pub skipped:     u32,
	/// Symbols per file, in ranked order (highest score first).
	pub files:       Vec<FileSymbols>,
}

impl From<pi_ast::repomap::SymbolEntry> for SymbolEntry {
	fn from(value: pi_ast::repomap::SymbolEntry) -> Self {
		Self {
			kind: value.kind,
			name: value.name,
			start_line: value.start_line,
		}
	}
}

impl From<pi_ast::repomap::FileSymbols> for FileSymbols {
	fn from(value: pi_ast::repomap::FileSymbols) -> Self {
		Self {
			path: value.path,
			language: value.language,
			symbols: value.symbols.into_iter().map(Into::into).collect(),
			total_lines: value.total_lines,
			truncated: value.truncated,
		}
	}
}

impl From<pi_ast::repomap::RepoMapResult> for RepoMapResult {
	fn from(value: pi_ast::repomap::RepoMapResult) -> Self {
		Self {
			root: value.root,
			rendered: value.rendered,
			truncated: value.truncated,
			total_lines: value.total_lines,
			file_count: value.file_count,
			skipped: value.skipped,
			files: value.files.into_iter().map(Into::into).collect(),
		}
	}
}

/// Build a repository-level symbol map ("repo-map") for system-prompt context.
///
/// Walks the working tree under `root`, parses every source file whose
/// extension maps to a [`pi_ast::SupportLang`], extracts top-level definitions
/// via tree-sitter, scores files by symbol count + cross-file coupling, and
/// renders a token-budgeted ranked listing.
///
/// Returns a Promise that resolves to [`RepoMapResult`].
#[napi]
pub fn build_repo_map(options: RepoMapOptions) -> task::Promise<RepoMapResult> {
	let ct = task::CancelToken::new(options.timeout_ms, options.signal);
	task::blocking("build_repo_map", ct, move |_ct| {
		let inner_options = pi_ast::repomap::RepoMapOptions {
			root: options.root,
			max_lines: options.max_lines,
			max_files: options.max_files,
			max_symbols_per_file: options.max_symbols_per_file,
			include_globs: options.include_globs,
			exclude_globs: options.exclude_globs,
			timeout_ms: options.timeout_ms,
		};
		pi_ast::repomap::build_repo_map(inner_options)
			.map(Into::into)
			.map_err(|err| Error::from_reason(err.to_string()))
	})
}
