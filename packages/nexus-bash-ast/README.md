# @nexus-agent/bash-ast

Nexus Agent 的 AST-based bash 命令安全分析包，移植自 OpenClaude 的
`src/utils/bash/ast.ts` security walker 算法。

## 设计目标

- **fail-closed**：任何 walker 不认识的 tree-sitter 节点类型都会触发
  `needs-approval`，避免静默放过危险结构。
- **纯 JSON AST**：基于 `@oh-my-pi/pi-natives` 暴露的 `parseBashCommand` NAPI
  返回的纯 JSON `BashNode` 树（无 tree-sitter Node 的方法）。
- **审计友好**：返回 `SimpleCommand[]`，包含 argv / envVars / redirects，方便
  下游权限规则匹配。

## 入口

- `parseForSecurity(cmd: string): ParseForSecurityResult` — 主入口，先解析
  再 walker。
- `parseForSecurityFromAst(cmd, root)` — 跳过解析，直接对已有 AST 跑 walker。
- `parseCommand(cmd)` — 仅解析，返回 `BashNode | null | PARSE_ABORTED`。

## 返回

```ts
type SecurityVerdict = "safe" | "needs-approval" | "aborted";

interface ParseForSecurityResult {
  verdict: SecurityVerdict;
  reason?: string;
  commands: SimpleCommand[];
  aborted: boolean;
}
```

- `safe`：成功提取所有简单命令，下游可基于 `commands` 做权限匹配。
- `needs-approval`：命令包含 walker 不能静态分析的结构（command_substitution、
  subshell、declare -n nameref、未跟踪的 `$VAR` 等），需要用户批准。
- `aborted`：Rust 解析器超时 / 超 node budget / 命令超长 / NAPI 调用失败，
  调用方应 fall back 到正则方案。

## 依赖

- `@oh-my-pi/pi-natives` 提供 `parseBashCommand` NAPI 绑定
  （`crates/pi-natives/src/bash_ast.rs`）。

## Algorithm Attribution

The security walker algorithm (`src/walker.ts`) is adapted from [OpenClaude](https://github.com/Gitlawb/openclaude)'s `src/utils/bash/ast.ts` (MIT License):

- `DANGEROUS_TYPES` set — fail-closed allowlist of dangerous tree-sitter-bash node types
- `varScope: Map<string, string>` — variable assignment scope tracking, including `declare -n` nameref detection
- `walkCommand` / `walkArgument` / `walkVariableAssignment` — recursive AST walker functions
- Pipeline `varScope` snapshot semantics — `||`/`|`/`&` branches don't inherit varScope mutations

The algorithm logic is preserved; the implementation is rewritten to operate on plain JSON `BashNode` structures (produced by Rust `tree-sitter-bash` via NAPI) instead of tree-sitter's native `Node` objects with `.walk()` iterators.

See `THIRD-PARTY-NOTICES.md` for full license attribution.
