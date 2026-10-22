# Producer Tools

The desktop application and integration hub for the **nine** open-source ShadowRoom MCP servers.

把九个开源的 ShadowRoom MCP 服务器连接成一套面向 DJ / 制作人的桌面体验，同时保持每个服务器都可被
任意 MCP 客户端独立调用。

[中文说明](README.zh-CN.md) · License: [AGPL-3.0](LICENSE)

## MCP ecosystem

Each capability is a separate public stdio MCP server. Use
[`mcp/manifest.json`](mcp/manifest.json) for machine-readable discovery and
[`docs/mcp-integration.md`](docs/mcp-integration.md) for generic client setup.

| MCP server | Capability | License |
| --- | --- | --- |
| [converter](https://github.com/shadowroommusic/rekordbox-serato-bridge) | Rekordbox ⇄ Serato playlists, cues, loops, colors | AGPL-3.0 |
| [audio analysis](https://github.com/shadowroommusic/audio-analysis-dedupe) | analysis, tempo/key, humming, duplicate detection | AGPL-3.0 |
| [set planner](https://github.com/shadowroommusic/set-planner) | set timing and harmonic next-track planning | AGPL-3.0 |
| [music generator](https://github.com/shadowroommusic/shadow-music-generator) | synthesis, arrangements, MIDI, and renders | AGPL-3.0 |
| [stem splitter](https://github.com/shadowroommusic/stem-splitter) | vocals, drums, bass, and other stems | AGPL-3.0 |
| [SoundFont renderer](https://github.com/shadowroommusic/soundfont-renderer) | MIDI rendered through real instruments | AGPL-3.0 |
| [steward](https://github.com/shadowroommusic/steward) | durable memory, summaries, and agent handoffs | AGPL-3.0 |
| [library](https://github.com/shadowroommusic/library) | indexing, metadata, covers, crates, and cues | AGPL-3.0 |
| [ShadowMusicGrabber](https://github.com/shadowroommusic/ShadowMusicGrabber) | probing, decrypting, transcoding, downloading | MIT |

```sh
node tools/bootstrap-ecosystem.mjs
node tools/print-mcp-config.mjs > shadowroom-mcp.json
```

## Status

The desktop application and its web surface are functional. The UI follows the interaction patterns of
DeepSeek Harness: a three-column frame (sidebar with the workspace list and the plugins, the
work surface in the middle, and the conversation dock on the right), built on our own `--sr-*` tokens
— dark by default, light on request. The brand files come straight from
[shadowroom.cn](https://shadowroom.cn) (see `assets/logo/README.md`).

The core asks before it leaves its sandbox: command and file-change approvals show up as a card above
the composer (**拒绝 / 本次会话都允许 / 允许一次**), which is the same surface DeepSeek Harness uses.
Without `pnpm serve:agent` a submit only records the request and adds a 内核未启动 notice. macOS
arm64 packaging is implemented; Windows packaging and signed/notarized public releases are still
being finished. The UI/frontend reference lives in
[docs/ui-reference.md](docs/ui-reference.md) (patterns borrowed from DeepSeek Harness).

## Run it

```sh
pnpm install
pnpm serve        # MCP bridge: spawns the nine ShadowRoom MCP servers, /api on 127.0.0.1:8787
pnpm serve:agent  # agent bridge: drives `codex app-server`, /api/agent on 127.0.0.1:8788
pnpm dev          # the web UI on http://localhost:5173 (proxies /api and /api/agent)
```

With both bridges running the composer runs a real agent turn: the message goes to the Codex core,
the answer streams into the transcript, and every tool the agent calls appears as a row right where
it happened (the same rows listed under **轨迹**), next to the model's folded 思考 rows and a
per-turn token/time line. The nine MCP servers are injected into each thread, so the agent drives the
tools the panels also call by hand.

The composer is the generic agent shape: attach context from **+** (a file or folder path, or a
plugin — it becomes a chip above the draft), pick the model on the right, press Enter. Plugins are not
chosen in the composer; they live on the **插件** page in the sidebar, and picking one opens its panel
as a page in the middle column, next to the conversation. Each panel still runs jobs on its own:

**Studio** (sidebar → Studio) opens on a **project list** — 新建工程, or reopen the last one — and only
then goes into the multi-track workbench: a transport with BPM / key / bar count, a column of track
headers (name, mute, solo, fader, meter) and a bar-ruled lane area where clips can be added by
double-clicking a lane, dragged to move and deleted with Delete. A new project starts empty — named
tracks, no clips — so what is on the timeline is always something you or the agent actually made.

It **plays**: 导入音频 drops a file from disk onto a track (its length comes from the file's real
duration — mp3, m4a, flac and aiff included, not just WAV), the transport streams it through the local bridge, clips start and stop as the playhead
crosses them, and mute / solo / the fader move the volume. Clips can be moved, resized from their right
edge, and removed; the ruler seeks; zoom changes the bar width. A clip that carries **notes** (a hum
the melody tool notated, a MIDI clip) plays them through a small built-in synth as well, drawn as a
mini piano roll — nothing on the timeline is silent decoration.

**导出音频** offers three things, and all three are real files: **整首** (the arrangement mixed down),
**分轨** (one file per track) and **MIDI** (a Type-1 file, one track per part, notes taken from MIDI
clips or from clips the hum-to-MIDI flow notated). Sample rate (44.1/48/96 kHz), bit depth (16/24) and
container (**WAV / AIFF / M4A (AAC)**) are selectable — the AAC path uses the encoder the machine
already has (macOS `afconvert`, or ffmpeg), and the dialog says so; only MP3 needs one you install.

All of it is reachable from a sentence as well as from the buttons — ask for a song, a stem export and
a MIDI file in one message and the agent calls `render_song`, `export_stems` and `export_midi` itself.

**Songs, not loops.** *"A 32-bar tech house: intro 8, drop 16, outro 8"* arrives as an arrangement:
the synth renders each part per section (`segments`), the studio draws the song's shape as named
sections above the ruler with boundaries through the lanes, and the clips land one per part for the
whole song. Ask for the MIDI in the same sentence and the render hands back the arrangement as notes
(drums on MIDI's drum channel) — it appears as a **MIDI** track next to the stems, so both exports
come from the same plan.

**Voice** — the microphone button in any page's composer starts a **call**, not a dictation: the
composer turns into a live waveform, the call stays open, and the turns behave like a phone call —
you talk, *stopping* is what sends the turn, the answer is spoken back, and talking over the answer
cuts it off and starts listening again. Each turn carries its own WAV recording (so humming a melody
reaches the agent as audio, not just as text), and the waveform shows what was heard while you speak.
Chrome/Edge only; the button is disabled where the browser has no speech recognition.

Say *把这段哼唱转成 MIDI* and it happens inside the same conversation: the agent calls the melody tool
(`hum_to_midi`, in `audio-analysis-dedupe`) on the recording it was just given, and the detected notes
appear as a clip with a mini piano roll on the open Studio project — no extra button, no second step.

**The dock** (right column) is the conversation: the transcript plus the composer, so you can watch and
type to the agent while the middle column stays on the work — 工作台 (recent projects, recent
conversations, the plugins), Studio, or a plugin panel. Opening a session from the sidebar moves the
transcript into the middle column and folds the dock away, so the same chat is never drawn twice.
Collapsed, the dock is a narrow rail whose button never covers the page buttons. The choice sticks
across reloads.

```sh
pnpm test    # the voice call's two detectors (turn end + barge-in) against synthetic loudness traces
```

| MCP server | What it does |
| --- | --- |
| `rekordbox-serato-bridge` | reads both libraries, previews a conversion (read-only), converts a playlist into an output folder, or writes back to Rekordbox (dry-run by default) |
| `set-planner` | times an ordered set: cue segments, overlaps, warnings, total runtime |
| `audio-analysis-dedupe` | analysis of one file, or a duplicate scan of a folder (read-only) |
| `shadow-music-generator` | queues a generation job (dry-run — no model is executed) and reads it back |
| `stem-splitter` | separates a finished song into vocals, drums, bass, and other |
| `soundfont-renderer` | renders notes or MIDI through real SoundFont instruments |
| `steward` | durable event ledger, summaries, and agent handoffs |
| `library` | fingerprint-incremental indexing, BPM/key metadata, crates, and cues |
| `ShadowMusicGrabber` | probes, decrypts, transcodes, and downloads audio |

The bridge finds the plugin checkouts under `~/Documents/ShadowRoom` by default; set
`SHADOWROOM_HOME` if yours live elsewhere. `SHADOWROOM_PYTHON`, `SHADOWROOM_BRIDGE_PORT` and
`SHADOWROOM_CALL_TIMEOUT_MS` are also configurable — see [docs/internals.md](docs/internals.md).

## Direct MCP use

Every server remains independently usable. Clone the ecosystem into sibling directories, generate a
standard `mcpServers` configuration, and point Codex, Claude Desktop, Cursor, Cline, Roo Code, or any
other MCP client at it. See [docs/mcp-integration.md](docs/mcp-integration.md) and the
[machine-readable manifest](mcp/manifest.json).

The product already spans Studio, DJ, Library, conversion, split-stem work, agent handoffs, and the
floating butler. See [docs/mcp-integration.md](docs/mcp-integration.md) for using each server outside
this application.

## Plan

1. Integrate all nine MCP servers behind one desktop surface. ✅
2. Studio, DJ, library, conversion, generation, and agent workflows. ✅
3. Generic MCP discovery and client configuration. ✅
4. Signed macOS and Windows public releases. ← *in progress*

## License

AGPL-3.0 — see [LICENSE](LICENSE).
