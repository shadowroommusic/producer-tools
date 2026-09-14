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

The core asks before it leaves its sandbox: command and file-change approvals show up as a card above
the composer (**拒绝 / 本次会话都允许 / 允许一次**), which is the same surface DeepSeek Harness uses.
Without `pnpm serve:agent` a submit only records the request and adds a 内核未启动 notice. Still
missing: a UI for `stage_serato_cues` and packaging the app as `apps/desktop`. The UI/frontend
reference lives in [docs/ui-reference.md](docs/ui-reference.md) (patterns borrowed from DeepSeek
Harness).

## Run it

```sh
pnpm install
pnpm serve        # MCP bridge: spawns the four ShadowRoom MCP servers, /api on 127.0.0.1:8787
pnpm serve:agent  # agent bridge: drives `codex app-server`, /api/agent on 127.0.0.1:8788
pnpm dev          # the web UI on http://localhost:5173 (proxies /api and /api/agent)
```

With both bridges running the composer runs a real agent turn: the message goes to the Codex core,
the answer streams into the transcript, and every tool the agent calls appears as a row right where
it happened (the same rows listed under **轨迹**), next to the model's folded 思考 rows and a
per-turn token/time line. The four plugins are injected into each thread, so the agent drives the
tools the panels also call by hand.

The composer is the generic agent shape: attach context from **+** (a file or folder path, or a
plugin — it becomes a chip above the draft), pick the model on the right, press Enter. Plugins are not
chosen in the composer; they live on the **插件** page in the sidebar, and picking one opens its panel
in the right dock. Each panel still runs jobs on its own:

**Studio** (sidebar → Studio) opens on a **project list** — 新建工程, or reopen the last one — and only
then goes into the multi-track workbench: a transport with BPM / key / bar count, a column of track
headers (name, mute, solo, fader, meter) and a bar-ruled lane area where clips can be added by
double-clicking a lane, dragged to move and deleted with Delete.

It **plays**: 导入音频 drops a file from disk onto a track (its length comes from the file's real
duration), the transport streams it through the local bridge, clips start and stop as the playhead
crosses them, and mute / solo / the fader move the volume. Clips can be moved, resized from their right
edge, and removed; the ruler seeks; zoom changes the bar width.

**Voice** — the microphone button in any page's composer starts a **call**, not a dictation: the
composer turns into a live waveform, the call stays open, every finished phrase is sent with its own
WAV recording attached (so humming a melody reaches the agent as audio, not just as text), the answer
is spoken back, and listening resumes. Chrome/Edge only; the button is disabled where the browser has
no speech recognition.

Say *把这段哼唱转成 MIDI* and it happens inside the same conversation: the agent calls the melody tool
(`hum_to_midi`, in `audio-analysis-dedupe`) on the recording it was just given, and the detected notes
appear as a clip with a mini piano roll on the open Studio project — no extra button, no second step.

**The dock** (right column) is the conversation: the transcript plus the composer, so you can watch and
type to the agent while working in Studio. Collapsed it is a narrow rail with two shortcuts —
**对话** and **插件** — which never covers the page. Plugin panels are pages in the middle column, not
part of the dock.

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
