# Producer Tools

The desktop application that bundles the ShadowRoom MCP servers into one product for DJs and
producers.

把 ShadowRoom 的四个 MCP 服务器打包成一个面向 DJ / 制作人的桌面应用。

[中文说明](README.zh-CN.md) · License: [AGPL-3.0](LICENSE)

## Status

Work in progress. The web UI shell renders today, with the layout and interaction patterns of
DeepSeek Harness: a three-column frame (sidebar with the workspace list and the plugins, the
conversation with its composer, and a right dock for the selected plugin), built on our own `--sr-*`
tokens — dark by default, light on request. The brand files come straight from
[shadowroom.cn](https://shadowroom.cn) (see `assets/logo/README.md`).

Still missing, in order: the bridge that runs the four MCP servers for the UI, and the Codex core
that turns a composer message into a running session. The UI/frontend reference lives in
[docs/ui-reference.md](docs/ui-reference.md) (patterns borrowed from DeepSeek Harness).

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

1. UI layer, following the reference in `docs/ui-reference.md`. ← *in progress*
2. Bridge the four MCP servers (`pnpm serve`) so the panels run real jobs.
3. Wire the Codex harness (bundled `codex` binary + `app-server` protocol) and register the four
   MCP servers with it.
4. Desktop shell (`apps/desktop`).

## License

AGPL-3.0 — see [LICENSE](LICENSE).
