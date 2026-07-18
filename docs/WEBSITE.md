# Nexus Agent Documentation Website

## Status

**Placeholder** — the documentation site at `https://docs.nexus.agent` is
planned for the v1.0.0-beta milestone (M9). Until then, documentation lives
in this `docs/` directory and in the repository root (`README.md`,
`DESIGN.md`, `ROADMAP.md`).

## Planned URL Structure

| URL | Content |
|---|---|
| `https://docs.nexus.agent/` | Landing page → quickstart |
| `https://docs.nexus.agent/guides/` | User guides (install, config, tools) |
| `https://docs.nexus.agent/reference/` | API/CLI reference |
| `https://docs.nexus.agent/integrations/` | gRPC, VS Code, MCP |
| `https://docs.nexus.agent/migration/` | nexus → Nexus migration guide |

## Build

The site will be generated from the markdown sources in `docs/` using a
static site generator (tentatively VitePress or Astro Starlight). The
generator config and CI pipeline will be added in M9.

## Brand URL

- Main site: `https://nexus.agent`
- Docs site: `https://docs.nexus.agent` (placeholder, not yet live)
- Collab relay: `https://collab.nexus.agent` (placeholder, not yet live)
