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

Without `pnpm serve:agent` a submit only records the request and adds a 内核未启动 notice. Still
missing: an approvals surface (the core runs with `approvalPolicy: never` for now), a UI for
`stage_serato_cues`, and packaging the app as `apps/desktop`. The UI/frontend reference lives in
[docs/ui-reference.md](docs/ui-reference.md) (patterns borrowed from DeepSeek Harness).

## Run it

```sh
pnpm install
pnpm serve        # MCP bridge: spawns the four ShadowRoom MCP servers, /api on 127.0.0.1:8787
pnpm serve:agent  # agent bridge: drives `codex app-server`, /api/agent on 127.0.0.1:8788
pnpm dev          # the web UI on http://localhost:5173 (proxies /api and /api/agent)
```

With both bridges running the composer runs a real agent turn: the message goes to the Codex core,
the answer streams into the transcript, and every tool the agent calls appears as a row right where
it happened (the same rows listed under **轨迹**). The four plugins are injected into each thread, so
the agent drives the tools the panels also call by hand. Each panel still runs jobs on its own:

| Panel | What it does |
| --- | --- |
| `rekordbox-serato-bridge` | reads both libraries, previews a conversion (read-only), converts a playlist into an output folder, or writes back to Rekordbox (dry-run by default) |
| `set-planner` | times an ordered set: cue segments, overlaps, warnings, total runtime |
| `audio-analysis-dedupe` | analysis of one file, or a duplicate scan of a folder (read-only) |
| `shadow-music-generator` | queues a generation job (dry-run — no model is executed) and reads it back |

The bridge finds the plugin checkouts under `~/Documents/ShadowRoom` by default; set
`SHADOWROOM_HOME` if yours live elsewhere. `SHADOWROOM_PYTHON`, `SHADOWROOM_BRIDGE_PORT` and
`SHADOWROOM_CALL_TIMEOUT_MS` are also configurable — see [docs/internals.md](docs/internals.md).

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
2. Bridge the four MCP servers (`pnpm serve`) so the panels run real jobs. ✅ *(all four panels are
   wired; `stage_serato_cues` still has no UI)*
3. Wire the Codex harness (bundled `codex` binary + `app-server` protocol) and register the four
   MCP servers with it.
4. Desktop shell (`apps/desktop`).

## License

AGPL-3.0 — see [LICENSE](LICENSE).
