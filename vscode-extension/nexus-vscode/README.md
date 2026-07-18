# Nexus Agent VS Code Extension

A practical VS Code companion for Nexus Agent with a project-aware **Control Center**, predictable terminal launch behavior, and quick access to useful Nexus Agent workflows.

## Features

- **Real Control Center status** in the Activity Bar:
  - whether the configured `nexus` command is installed
  - the launch command being used
  - whether the launch shim injects `CLAUDE_CODE_USE_OPENAI=1`
  - the current workspace folder
  - the launch cwd that will be used for terminal sessions
  - whether `.nexus-profile.json` exists in the current workspace root
  - a conservative provider summary derived from the workspace profile or known environment flags
- **Project-aware launch behavior**:
  - `Launch Nexus` launches from the active editor's workspace when possible
  - falls back to the first workspace folder when needed
  - avoids launching from an arbitrary default cwd when a project is open
- **Practical sidebar actions**:
  - Launch Nexus
  - Launch in Workspace Root
  - Open Workspace Profile
  - Open Repository
  - Open Setup Guide
  - Open Command Palette
- **Built-in dark theme**: `Nexus Terminal Black`
- **Chat panel** with streaming output, tool-use cards, permission prompts, and session history
- **Optional gRPC transport** (M5): connect to a running `nexus grpc --port 50051` server instead of spawning a stdio CLI per session

## Requirements

- VS Code `1.95+`
- `nexus` available in your terminal PATH (`npm install -g nexus-agent@latest`)

## Commands

- `Nexus: Open Control Center`
- `Nexus: Launch in Terminal`
- `Nexus: Launch in Workspace Root`
- `Nexus: Open Repository`
- `Nexus: Open Setup Guide`
- `Nexus: Open Workspace Profile`
- `Nexus: New Chat`
- `Nexus: Open Chat Panel`
- `Nexus: Resume Session`
- `Nexus: Abort Generation`

## Settings

- `nexus.launchCommand` (default: `nexus`)
- `nexus.terminalName` (default: `Nexus Agent`)
- `nexus.useOpenAIShim` (default: `false`)
- `nexus.permissionMode` (default: `acceptEdits`; one of `default`, `acceptEdits`, `bypassPermissions`, `plan`)
- `nexus.transportMode` (default: `stdio`; one of `stdio`, `grpc`)
- `nexus.grpcEndpoint` (default: `localhost:50051`)

`nexus.useOpenAIShim` only injects `CLAUDE_CODE_USE_OPENAI=1` into terminals launched by the extension. It does not guess or configure a provider by itself.

### gRPC transport mode

Set `nexus.transportMode` to `grpc` and start the gRPC server in another terminal:

```bash
nexus grpc --port 50051
```

The extension will spawn `nexus grpc-cli --host localhost --port 50051` as a bridge subprocess and pipe its output into the chat UI. This is a best-effort bridge; the stdio mode remains the recommended default.

## Notes on Status Detection

- Provider status prefers the real workspace `.nexus-profile.json` file when present.
- If no saved profile exists, the extension falls back to known environment flags available to the VS Code extension host.
- If the source of truth is unclear, the extension shows `unknown` instead of guessing.

## Development

From this folder:

```bash
npm run test
npm run lint
```

To package (optional):

```bash
npm run package
```
