# Producer Tools

The desktop application that bundles the ShadowRoom MCP servers into one product for DJs and
producers.

把 ShadowRoom 的四个 MCP 服务器打包成一个面向 DJ / 制作人的桌面应用。

[中文说明](README.zh-CN.md) · License: [AGPL-3.0](LICENSE)

## Status

Scaffolding. The UI/frontend reference is written up in
[docs/ui-reference.md](docs/ui-reference.md) (patterns borrowed from DeepSeek Harness); the agent
core will be the Codex harness driven over its `app-server` protocol.

## What it will contain

| Tool | Surface |
| --- | --- |
| `rekordbox-serato-bridge` | Conversion & preview: playlists, cues/loops/colors, dry-run reports |
| `audio-analysis-dedupe` | Library analysis and duplicate groups |
| `set-planner` | Set timeline and next-track suggestions |
| `shadow-music-generator` | Generation jobs: queue, stages, artifacts, licenses |

Every tool stays available as a standalone MCP server; this app is the shell that installs them,
keeps their settings and gives DJs one place to work.

## Plan

1. UI design, following the reference in `docs/ui-reference.md`.
2. App scaffold: pnpm workspace, `apps/desktop`, `ui-*` packages, `--sr-*` design tokens.
3. Wire the Codex harness (bundled `codex` binary + `app-server` protocol) and register the four
   MCP servers with it.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
