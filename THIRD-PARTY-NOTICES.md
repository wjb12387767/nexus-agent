# Third-Party Notices

Nexus Agent incorporates code, algorithms, and design patterns from the following
open-source projects. All attributions are preserved per their respective licenses.

## 1. Oh My Pi (omp) — primary base

- **Source**: https://github.com/can1357/oh-my-pi
- **License**: MIT
- **Copyright**: © 2025 Mario Zechner · © 2025-2026 Can Bölük
- **Usage**: Base monorepo structure, all 16 TS packages and 4 Rust crates
  (pi-natives, pi-shell, pi-ast, pi-iso). Forked as the foundation of Nexus Agent.
- **Files**: `packages/*`, `crates/pi-*`

## 2. Grok Build (SpaceXAI) — sandbox / checkpoint / compaction

- **Source**: https://github.com/xai-org/grok-build (mirror of SpaceXAI monorepo)
- **License**: Apache License 2.0
- **Usage**: Per Apache §4(b), the following files are ported (with modification)
  from `crates/codegen/xai-grok-*` and carry the Apache 2.0 notice in their headers:
  - `crates/nexus-sandbox/` ← `xai-grok-sandbox` (Landlock/Seatbelt/seccomp)
  - `crates/nexus-checkpoint/` ← `xai-grok-workspace/src/session` (checkpoint store, swap policy)
  - `packages/nexus-compaction/` ← `xai-grok-compaction` (inter/intra/code/history algorithms)
- **Modifications**: Stripped `xai-tool-runtime` / `xai-tool-types` internal dependencies,
  re-typed against Nexus local types, exposed via NAPI.

## 3. OpenClaude (Gitlawb) — gRPC / VS Code / routing

- **Source**: https://github.com/Gitlawb/openclaude
- **License**: MIT
- **Usage**:
  - `packages/nexus-grpc/proto/nexus.proto` ← `src/proto/openclaude.proto` (renamed service)
  - `vscode-extension/nexus-vscode/` ← `vscode-extension/openclaude-vscode/` (rebranded)
  - `packages/nexus-routing/` ← `agentModels`/`agentRouting` configuration schema
- **Note**: OpenClaude is itself a fork of Anthropic's Claude Code. "Claude" and
  "Claude Code" are trademarks of Anthropic PBC; Nexus Agent is not affiliated
  with, endorsed by, or sponsored by Anthropic.

## OpenClaude — bash AST security walker

The bash AST security walker algorithm in `packages/nexus-bash-ast/src/walker.ts`
is adapted from OpenClaude's `src/utils/bash/ast.ts`:
- DANGEROUS_TYPES set (fail-closed allowlist of dangerous node types)
- varScope tracking (variable assignment scope, including `declare -n` nameref)
- walkCommand / walkArgument / walkVariableAssignment walker functions
- pipeline varScope snapshot semantics

Source: https://github.com/Gitlawb/openclaude
License: MIT

The algorithm logic is preserved; the implementation is rewritten to operate
on plain JSON BashNode structures (from Rust tree-sitter-bash via NAPI) instead
of tree-sitter's native Node objects.

## 4. Vendored upstream (inherited from omp)

See `crates/vendor/*/LICENSE` for the full list of vendored crates
(brush-shell, jaq, uu-ln, uu-ls, uu-mv, uu-rm, uu-tr, uu-wc, ...).
