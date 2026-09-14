# Internals

Implementation notes for this repository. Users do not need any of this — see the README.

## What exists

| Path | Role |
| --- | --- |
| `apps/web` | The UI. Vite + React, no CSS framework; geometry lives in `src/styles/*.css`. |
| `apps/web/src/shell` | The three-column frame and its column solve. |
| `packages/ui-tokens` | `--sr-*` tokens: static ramp, semantic aliases, shell geometry, motion. |
| `tools/mcp-bridge.mjs` | `pnpm serve`: runs the MCP servers and exposes them to the UI over HTTP. |

## The bridge (`tools/mcp-bridge.mjs`)

The web app cannot drive a stdio MCP server, so the bridge owns that and the UI only ever talks to
two endpoints:

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /api/servers` | — | every configured server (`connected`, `status`, `error?`, cached `tools`) plus `home` and `workspaces`, so the UI can build absolute path defaults — a browser cannot expand `~` |
| `POST /api/call` | `{ server, tool, arguments }` | `{ result, isError, ms }` — `result` is the tool's text content |

Details that matter:

- **Transport.** Each ShadowRoom `mcp_server.py` frames messages as *one JSON object per line* and
  reads `sys.stdin` line by line, so the bridge parses stdout line by line and matches replies by
  `id`. No `Content-Length` framing, no dependencies — Node builtins only.
- **Lazy start.** A server is spawned on the first `/api/servers` or `/api/call` that needs it, then
  kept alive for the process's lifetime. The handshake is `initialize` → `notifications/initialized`
  → `tools/list`, each under `SHADOWROOM_HANDSHAKE_TIMEOUT_MS` (8s default).
- **Timeouts.** Tool calls default to `SHADOWROOM_CALL_TIMEOUT_MS` (120s) because analysis and
  conversion jobs are slow; a timeout rejects that one call and leaves the server running.
- **Failure shape.** A missing checkout, a crashed server or a non-zero exit all land in the
  snapshot's `error` field with the last few stderr lines, so the UI can show why a plugin is dark.
  Tool-level failures come back as `isError: true` with the message as `result`.
- **Config.** `SHADOWROOM_HOME` (default `~/Documents/ShadowRoom`) holds the plugin checkouts;
  `SHADOWROOM_PYTHON` (default `python3`) and `SHADOWROOM_BRIDGE_HOST`/`_PORT` (default
  `127.0.0.1:8787`) round it out.
- **Registry.** The four servers are listed in `REGISTRY` with the ids the UI uses
  (`converter`, `analysis`, `planner`, `generator`). Adding a plugin means adding one entry.

## The UI ↔ agent boundary

Sessions live in `apps/web/src/lib/sessions.ts` and are persisted under `shadowroom.sessions.v1`:

```ts
type Session = { id, title, createdAt, messages: ChatMessage[], calls: ToolCall[] }
type ChatMessage =
  | { role: "user"; text }
  | { role: "assistant"; text }
  | { role: "notice"; title; text }   // dim status row, e.g. 内核未接入
  | { role: "tool"; callId }          // rendered from `calls`, so one row drives both views
```

- A session is titled from its first user message and listed in the sidebar with a relative time.
- **A tool a panel runs is written twice**: into `calls` (the 轨迹 tab) and into `messages` as a
  `tool` row, so it also appears in the transcript where the request was made — the same place the
  Codex core will write its own steps.
- `App.tsx` only ever updates the active session (`withActiveSession`), creating one on the fly when
  the hero is still empty. When the Codex `app-server` core lands it writes the same two arrays; no
  layout code has to move.

## The agent bridge (`tools/agent-bridge.mjs`)

`pnpm serve:agent` spawns the `codex` binary in `app-server` mode and speaks its JSON-RPC over
stdio (one JSON object per line). The browser gets three endpoints:

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /api/agent/health` | — | `ok`, `model`, `userAgent`, `cwd`, `sandbox`, `approval`, injected `plugins` |
| `POST /api/agent/send` | `{ sessionId, text }` | an SSE stream of the turn: `turn`, `item`, `delta`, `reasoning`, `done`, `error` |
| `POST /api/agent/interrupt` | `{ sessionId }` | `{ ok: true }` after `turn/interrupt` |

What was measured and matters:

- **Handshake.** `initialize` → `thread/start` → `turn/start`. One UI session maps to one Codex
  thread (kept in memory, created on the first message). A turn runs asynchronously, so the SSE
  stream stays open until `turn/completed` arrives; a `SHADOWROOM_AGENT_TURN_TIMEOUT_MS` guard
  (default 15 min) closes it regardless.
- **Events.** The UI needs three of them: `item/agentMessage/delta` (append to the answer),
  `item/started|completed|updated` (tool rows: `mcpToolCall` items carry `server`, `tool`, `status`,
  `arguments`, `result`, `error`, `durationMs`; `commandExecution` items carry the shell command),
  and `turn/completed`. Reasoning deltas are forwarded but not rendered yet.
- **Plugins.** Every thread is started with the four ShadowRoom MCP servers injected through the
  `config` override, each with `default_tools_approval_mode: "approve"`. Without that flag an MCP
  call fails under `approvalPolicy: "never"` with *"MCP tool call requires approval, but approval
  policy is never"* — measured, then fixed by the flag rather than by loosening the sandbox.
- **Permissions.** Threads start with `sandbox: workspace-write` and `approvalPolicy: never` in
  `SHADOWROOM_AGENT_CWD` (default `~/Documents/ShadowRoom`), which is narrower than the user's own
  global config.
- **Approvals.** `SHADOWROOM_AGENT_APPROVAL` defaults to `on-request`: when the core wants to run a
  command or apply a patch outside the sandbox it sends a *server request* back to us
  (`execCommandApproval`, `applyPatchApproval`, or the v2 `item/commandExecution/requestApproval` /
  `item/fileChange/requestApproval`). Those are the only server→client requests we answer; anything
  else is refused with `-32601` so a turn can never hang waiting on us. The request is forwarded to
  the UI as an SSE `approval` event and shown as a card above the composer; the answer comes back on
  `POST /api/agent/approval` and is mapped into the vocabulary the request expects — legacy
  `approved` / `approved_for_session` / `{denied:{rejection}}`, v2 `accept` / `acceptForSession` /
  `decline`. Measured: with `workspace-write`, a `touch` inside the workspace or `/tmp` runs
  unattended (both are writable), while writing to the home directory raises the approval.
- **Binary.** `SHADOWROOM_CODEX` points at the codex binary; the default is the one shipped inside
  the Codex desktop app (`/Applications/ChatGPT.app/Contents/Resources/codex`).
- **Lazy boot.** The child is spawned on first use, so `GET /api/agent/health` *is* the boot: it awaits
  the handshake and only then reports `ok`. (Before that it answered `ok: false` for a healthy bridge
  and the UI took the no-core path — measured, then fixed.)
- **Models.** `GET /api/agent/models` proxies `model/list` (cached) so the composer's picker is the
  core's own list; the chosen model and reasoning effort travel with `turn/start`.

## Browser storage keys

| Key | Owner | Contents |
| --- | --- | --- |
| `shadowroom.sessions.v1` | `lib/sessions.ts` | every session: title, messages, tool calls, active id |
| `shadowroom.chat.width` | `components/Conversation.tsx` | dragged transcript width in px (absent = adaptive clamp) |
| `shadowroom.converter.paths` | `components/ConverterPanel.tsx` | Rekordbox database/dir and Serato database paths |
| `shadowroom.model` | `App.tsx` | the model picked in the composer |
| `shadowroom.studio.v1` | `lib/studio.ts` | the Studio project: tracks, clips, tempo, key, bars |
| `shadowroom.studio.projects.v1` | `lib/studio.ts` | every Studio project |
| `shadowroom.studio.open` | `lib/studio.ts` | which project was open last |
| `shadowroom.view`, `shadowroom.workspace` | `App.tsx` | the page and workspace a reload should land on |

## Where things live in the UI

- **Sidebar** — workspaces (工作台 / 曲目库 / Studio / DJ / 设置), one **插件** entry that opens the
  plugins page, then **对话**: the sessions. Plugins are deliberately not a permanent sidebar list.
- **Composer** — the generic agent shape: an attach menu (**+**) for a file/folder path or a plugin
  (which becomes a context chip and a `mention` input item), mode chips, a **model picker** on the
  right, and the send/stop circle. No plugin picker here.
- **Transcript** — user bubbles, streamed answers, folded 思考 rows (`ReasoningRow`, DSH's geometry),
  tool rows in the order they happened, notice rows, and a per-turn `tokens · seconds` line.
- **Pages** — the plugins page (`PluginsPage`) is the centre column's other occupant; picking a card
  selects that plugin and opens its panel in the dock.
- **Dock** — the conversation only: the shared `Transcript` plus the composer (the main column's
  composer is hidden while it is open, so there is only ever one input). Collapsed it becomes a 44px
  rail of shortcuts (对话 / 插件) — a column of its own, never a floating button over the transport.
- **Plugin panels** are pages in the centre column (`PluginPanelPage`), opened from the plugins page.
- **Agent-driven UI side effects** — when `hum_to_midi` completes in a session, `App.absorbMelody`
  reads the tool result and appends a clip (with its notes) to the open Studio project. That is the
  pattern for "the agent does the work, the workbench just shows it": tools write, the UI absorbs.

## UI audit (2026-09-14)

Checked every page in a real browser at 1600 / 1440 / 1280 / 1100 / 900 / 760, at 1× and 2×, clicking
the controls rather than eyeballing a screenshot. What it turned up and what changed:

- The dock's first-open width was 45% of the frame, which left Studio only 600px at 1600 — it read as
  the panel covering the work surface. The dock now opens at `clamp(28%, 360, 520)`, and the centre
  keeps the room; below ~756px frame width the panel floats over the centre and is styled as a drawer
  (`data-floating` → panel shadow).
- The dock's second tab was labelled with the plugin's name, so "对话" looked like it contained
  "Set 编排". The tabs are now **对话** and **面板**; the plugin's name sits inside the panel body.
- `.sr-input--key` / `.sr-studio-import-track` were declared *before* `.sr-input { width: 100% }`, so
  the tempo/key/bar fields took the full width, the transport wrapped and 导入音频 was clipped at
  1440. Modifiers now follow the base rule; zoom moved to a floating pill on the timeline.
- Sidebar rows for pages that do not exist yet (曲目库 / DJ / 设置) were clickable and *looked* like
  navigation. They are `disabled` now.
- Mode chips do something: 极简 hides the 思考 rows (`Transcript quiet`).
- **Studio** (`StudioPage`) — the DAW-shaped page: transport, a header column per track and a
  bar-ruled lane area. `BAR_PX` (56) is the bar width in both the TSX and the CSS grid, so keep the
  two in step. The playhead runs on `requestAnimationFrame` at the project tempo and loops at the
  bar count.
- **Studio playback** — one `<audio>` per playable clip (kept in a ref map, parked in a hidden host so
  devtools can see them). `GET /api/agent/file?path=…` streams local audio with Range support; the rAF
  loop advances the playhead and starts/stops clips as it crosses their edges, with volume from the
  track's fader / mute / solo. **Every Studio edit goes through an updater** (`onChange(patch)`), never
  a captured snapshot — the first version wrote a stale project back and silently dropped a freshly
  imported clip.
- **Voice** (`lib/voice.ts`) — a *call*: `startCapture()` opens the microphone through Web Audio and
  keeps the PCM (encoded to WAV in the browser, so the Python side needs no ffmpeg), while
  `webkitSpeechRecognition` transcribes. Each finished phrase takes the WAV since the previous phrase,
  uploads it to `POST /api/agent/audio` (the bridge writes it under `SHADOWROOM_RECORDINGS_DIR`,
  default `~/Documents/ShadowRoom/recordings`) and sends the turn with that file attached as a
  mention — that is how a hummed melody reaches the agent as audio. The answer is spoken with
  `speechSynthesis`, and listening resumes when it ends. The analyser level drives the waveform the
  composer turns into (`Composer` + `useVoiceBars`).

There is deliberately **no conversation header**: no breadcrumbs, no status chips, no view tabs. The
header row the conversation used to carry was removed on request; the dock states its own plugin and
carries its own close button.

## Transcript width handles

The conversation column keeps one width axis (`--sr-content-width`, an adaptive
`clamp(640px, 62%, 880px)`). Two 40px strips sit 24px outside it; dragging either one writes a
symmetric preference (outward travel widens by 2× the pointer distance), clamped to
`[640px, column − 176px]`, and double-clicking a strip clears it. When the column cannot hold
`inset + strip + safe zone` the computed strip width is 0 — the DSH behaviour, so a narrow column
never carries a mispositioned hit area.
