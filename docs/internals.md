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
- **Registry.** The nine servers are listed in `REGISTRY` with the ids the UI uses
  (`converter`, `analysis`, `planner`, `generator`, `splitter`, `soundfont`, `steward`, `library`,
  `grabber`). Adding a plugin means adding one registry entry and its scope projection.

## The UI ↔ agent boundary

Sessions live in `apps/web/src/lib/sessions.ts` and are persisted under `shadowroom.sessions.v1`:

```ts
type SessionKind = "butler" | "studio" | "dj" | "library";
type Session = { id, kind, scope: { workspaceId }, title, createdAt, lastActiveAt, messages: ChatMessage[], calls: ToolCall[] }
type SessionStore = { sessions, activeButlerId?, activeWorkerIds? }
type ChatMessage =
  | { role: "user"; text; scope?: { workspaceId, label?, projectId?, setId?, revision? } }
  | { role: "assistant"; text }
  | { role: "notice"; title; text }   // dim status row, e.g. 内核未接入
  | { role: "tool"; callId }          // rendered from `calls`, so one row drives both views
```

- The sidebar and `/conversation` show **butler topics only**. “新对话” creates a butler topic; it
  never creates a second Studio/DJ/library worker.
- Studio, DJ and library each own exactly one hidden worker session. A page worker is not split per
  project/Set yet; the current object travels as explicit message scope and context instead.
- The floating orb always submits to butler, from every page. A page dock submits only to that page's
  worker. Their drafts are separate, so a sentence typed in Studio cannot leak into the butler panel.
- **A tool a panel runs is written twice**: into `calls` (the 轨迹 tab) and into `messages` as a
  `tool` row, so it also appears in the transcript where the request was made — the same place the
  Codex core will write its own steps.
- `App.tsx` updates the session for the selected scope (`butler` / page worker), creating it on the
  fly when empty. Switching pages never changes the butler's selected topic.

## The agent bridge (`tools/agent-bridge.mjs`)

`pnpm serve:agent` spawns the `codex` binary in `app-server` mode and speaks its JSON-RPC over
stdio (one JSON object per line). The browser gets three endpoints:

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /api/agent/health` | — | `ok`, `model`, `userAgent`, `cwd`, `sandbox`, `approval`, injected `plugins` |
| `POST /api/agent/send` | `{ sessionId, text, scope, projectId?, setId? }` | an SSE stream of the turn: `turn`, `item`, `delta`, `reasoning`, `done`, `error` |
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
- **Plugins and scopes.** All nine servers exist in the bridge, but every thread is projected through
  `SCOPE_TOOL_ALLOWLIST`: butler sees only steward; Studio sees generator/soundfont/splitter/analysis
  plus a read-only library slice; DJ sees planner/analysis plus read-only library; library sees
  library/analysis/grabber plus splitter status. DJ intentionally has no converter, Studio no
  converter/planner, library no generator. The same allow-list is enforced again at execution time
  (`scopeAllowsTool`), not merely hidden from the model schema.
- **Chat-provider adapter.** Codex cannot route namespaced plugin calls produced by a chat model.
  The loopback adapter executes those MCP calls itself, returns the result to the model, and sends a
  thread-scoped `mcpToolCall` item to the UI side channel. It does **not** replay a Responses
  `function_call` (doing so made Codex execute a second time and answer `unsupported call`). The
  chat model receives only `mcp__*` namespaces; Codex's shell, subagent, goal and MCP-resource tools
  are filtered out of this adapter schema. MiniMax-style `<think>…</think>` blocks are removed by a
  streaming filter, including tags split across deltas, so internal reasoning never becomes the
  user-visible message.
- **Ownership.** A turn carries a hidden `[shadowroom_owner]` JSON envelope. The adapter strips it
  before the provider sees the conversation, then uses it to stamp tool/media events with
  `sessionId`, `scope`, `projectId` and `setId`. Studio absorption also checks that the turn's
  project is still the open project; switching projects mid-turn keeps the card but refuses to write
  into the new project.
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

## The voice call: what it says, and in what order

The call used to read the whole answer (thinking tags included) and cut sentences off when the next
delta arrived. Three pure modules now own the parts that can be tested without a microphone:

| Module | Rule |
| --- | --- |
| `lib/speech-turn.ts` | Only the assistant message created **for this turn** may be spoken. The effect keys on the last assistant message, and between "user stopped" and `submit` that is still the previous answer — that is how an old long answer got read again. |
| `lib/speech-text.ts` | The spoken version is derived, not the transcript: `<think>`, fenced code, tables, URLs, absolute paths and tool-log lines are stripped; `brief` = ≤2 sentences / ≤70 chars, `detail` = ≤8 / ≤360 (hard ceiling 420). Over budget it retreats to a clause boundary; with no punctuation at all it clips and ends with `……` — the one place a fragment is allowed, because there is no legal boundary to stop at. |
| `lib/tts-queue.ts` | One speaker, strictly serial, 120 ms between sentences, `clear()` idempotent. Pushing a sentence never cancels the one playing (that was the truncation); a late `onEnd` after `clear()` cannot start the next one (epoch). A sentence that never calls back times out (30 s) so the call cannot stick in "speaking". |

`lib/speech-plan.ts` answers "which voice" exactly once: `system` reads `shadowroom.voice`, a
configured TTS role reads `shadowroom.tts.voice`, and the plan's `key` (`bridge:provider:model:credential:voice`)
is what callers compare to rebuild the provider. Settings' 试听 uses the same plan (with
`planWithVoice()` for an unselected row), so preview and call cannot diverge again. `speak()` no
longer cancels implicitly, and synthesis failures surface through `onError` with the provider's
message instead of a silent `onEnd`.

**Wired (S4b/S5, 2026-10-21).** The old speaking effect, `currentTTS()`/`currentVoiceId()`,
`speechText()`, `spokenUpTo`/`speakingToken`/`awaitingSpeakEndRef` are gone — one answer per
question. The only path into the speaker is this turn's deltas: `feedVoiceDelta` → feeder (stable
sentences only) → queue. `bind` locks the first itemId; a second segment of the same turn is
refused. `onIdle` is gated by the submit-in-flight flag, so a momentary queue drain keeps the call
in speaking; the turn ends only when the model finished *and* the queue is idle
(`finishVoiceTurn`). A bridge synthesis failure trips one fallback (keyed by plan.key): clear →
notice with the provider's reason → failed sentence + unplayed remainder re-pushed once on the
system voice; a system failure only notifies. `submit` injects `[voice_turn] mode/budget` on voice
turns (typed turns included — they also go thinking→speaking→listening now), and
`developerInstructionsFor` carries `VOICE_CALL_RULES` for every scope.

**The orb listens live (2026-10-21).** `GlassSphere` takes `level: number | (() => number)`; the
canvas rAF reads the getter each frame, so a ref-held level actually reaches the pixels (the old
render-time read never updated). Listening maps the RMS perceptually — `smoothstep(clamp(level*2))`
— and drives particle brightness/radius, the tick ring, the plasma core and the CSS aura
(`--orb-voice`). Silence rests at 78% of the lit body; speech lifts the whole organism plus two
pressure rings, so the alpha contrast is measured rather than inferred from the level variable.
Speaking's waveform morph is untouched.

**Busy and routing are per session (2026-10-21).** `App` keeps running session ids and abort
controllers in maps, not one window-wide boolean. The butler, Studio, DJ and library can run in
parallel; each composer and transcript reads only its own busy state, and Stop interrupts only that
thread. The orb reads the butler thread, never whichever worker happens to be visible.

`route_intent` is a proposal, not a page switch. Safe, high-confidence work executes directly:
the originating text and `Mention` list persist on the stored tool row (`routeSource`), a steward
handoff gets the stable `butler-route:<routeId>` idempotency key, and the target worker receives the
original request plus attachment paths as soon as both sessions are idle. No confirmation click is
required for generation, analysis, export, or ordinary edits. Delete, clear, overwrite, move,
rename, low-confidence, and missing-target work keeps an explicit `确认执行` card.

Duplicate events share the same route id, so they execute once; `routeConsumed` prevents a handled
route from replaying after reload. A Studio request with no open project creates a fresh zero-track
project automatically, then sends its real `projectId` to the worker. That is what makes “生成一首
歌” work from any page without a setup detour.

Steward v2 adds `handoff_create`, `handoff_claim`, `handoff_finish`, `handoff_get` and
`handoff_list` on top of the event ledger. Handoffs are mutable current work; events remain
append-only history. `situation_report` includes bounded active/recent handoff summaries, which is
how the butler can answer “Studio 刚才做了什么” without receiving worker transcripts.

If the bridge/core/provider restarts, the next turn for that UI session receives at most six recent
user/assistant text messages (1,800 characters total) as `[recent_conversation]`. Reasoning, tools,
and the longer stored transcript are excluded; later turns rely on the live thread and do not repeat
the block.

The live product acceptance (`tests/e2e/studio-natural-language-live.mjs`) starts with an empty
Studio project. One sentence creates a 122 BPM, four-bar Drums/Bass/Chords project backed by three
real audio files and leaves it playable. A second sentence asks to darken and lift only the Bass;
`regenerate_part` replaces that Bass source while the other sources and track set stay unchanged.

**Why no framework.** The turn length, the sentence budget and the voice switch are the actual
complaints; Pipecat/LiveKit would add a Python media service or a LiveKit server and a second turn
contract, Moshi would replace the Codex brain with a 7B speech model, TEN's licence is unidentified
(`NOASSERTION`). All were reviewed as references only: `pipecat-ai/pipecat` (BSD-2-Clause),
`livekit/agents` (Apache-2.0), `kyutai-labs/moshi` (Apache-2.0), `TEN-framework/ten-framework`
(licence unclear), `huggingface/speech-to-speech` (Apache-2.0), `FireRedChat` (Apache-2.0),
`KoljaB/RealtimeVoiceChat` (no LICENSE file in the repository — ideas only, no code). **No code was
copied from any of them.** The interfaces (`STTProvider`, `TTSProvider`, the turn/barge-in detectors)
stay the seam if a media framework is ever adopted.

## Browser storage keys

| Key | Owner | Contents |
| --- | --- | --- |
| `shadowroom.sessions.v1` | `lib/sessions.ts` | butler topics + three page workers; active butler id and per-page worker ids |
| `shadowroom.chat.width` | `components/Conversation.tsx` | dragged transcript width in px (absent = adaptive clamp) |
| `shadowroom.converter.paths` | `components/ConverterPanel.tsx` | Rekordbox database/dir and Serato database paths |
| `shadowroom.model` | `App.tsx` | the model picked in the composer |
| `shadowroom.studio.v1` | `lib/studio.ts` | the Studio project: tracks, clips, tempo, key, bars |
| `shadowroom.studio.projects.v1` | `lib/studio.ts` | every Studio project |
| `shadowroom.studio.open` | `lib/studio.ts` | which project was open last |
| `shadowroom.view` | `App.tsx` | the page a reload should land on (workbench / conversation / plugins / plugin / studio / dj / library / settings) |
| `shadowroom.dock.by-view.v1` | `App.tsx` | dock open/closed independently for workbench / studio / dj / library |
| `shadowroom.voice` | `lib/speech-plan.ts` | system voice for calls (`voiceURI` or name) |
| `shadowroom.tts.voice` | `lib/speech-plan.ts` | provider voice id; part of the provider instance key |

## Where things live in the UI

- **Sidebar** — workspaces (工作台 / 曲目库 / Studio / DJ / 设置), one **插件** entry that opens the
  plugins page, then **对话**: butler topics only. Page workers never appear as extra sidebar rows.
  Butler topics with zero messages are hidden except for the currently selected one, so old empty
  “新对话” rows do not accumulate forever.
- **Composer** — the generic agent shape: an attach menu (**+**) for a file/folder path or a plugin
  (which becomes a context chip and a `mention` input item), mode chips, a **model picker** on the
  right, and the send/stop circle. No plugin picker and no microphone here: calling is a single
  global action owned by the orb, so page workers cannot expose a second call entry.
- **Transcript** — user bubbles, streamed answers, folded 思考 rows (`ReasoningRow`, DSH's geometry),
  tool rows in the order they happened, notice rows, and a per-turn `tokens · seconds` line.
- **Pages** — 工作台 (`WorkbenchHome`: recent projects, recent conversations, the plugins entry — the
  landing page), the plugins page (`PluginsPage`), and a plugin's panel (`PluginPanelPage`). Picking
  a plugin card opens its panel as a page in the centre column.
- **Studio** (`StudioPage` + `styles/studio.css`) — identity row (project name, track/clip count,
  project length / 10-minute cap), then the transport row. Temporary engine controls live under More;
  scratch and sound browser are 44px rail buttons that open overlay drawers without changing timeline
  width. A zero-track project renders a centred creation card instead of an empty track-header gutter.
- **DJ** (`DjPage` + `styles/dj.css`) — Set identity/overview at the top, then a two-pane workspace:
  scrolling library and Set board. Row preview/add actions are quiet until hover/focus; import/export
  live in More. An empty deck collapses to a status strip.
- **Library** (`LibraryPage` + `styles/library.css`) — overview stats, a compact command surface for
  ingest and search, advanced filters on demand, then a fixed-header scrolling catalog. The list loads
  80 tracks at a time and offers explicit “load more” instead of claiming a permanent 200-row ceiling.
- **Butler orb** (`OrbGlass` + `styles/orb-refine.css`) — a particle/plasma energy form rather than a
  glass bubble: hard rims/reflections are removed, while the particle core, trails, state motion and
  speaking waveform remain.
- **Dock** — the current page's worker conversation plus its composer. Studio / DJ / library are
  collapsed on first visit; each page remembers its own state. Collapsed it becomes a 44px rail.
  A global butler route suggestion appears as a temporary route card on the current page; confirming
  it is what opens the target page's dock and fills that worker's draft.
- **Plugin panels** are pages in the centre column (`PluginPanelPage`), opened from the plugins page.
- **Agent-driven UI side effects** — when `hum_to_midi` completes in a session, `App.absorbMelody`
  reads the tool result and appends a clip (with its notes) to the open Studio project. That is the
  pattern for "the agent does the work, the workbench just shows it": tools write, the UI absorbs.
  A `render_song` result does the same for a whole arrangement: one clip per stem, the project's BPM
  and bar count follow the render, `sections` become the ruler's section strip, and a `midi_path`
  lands on its own **MIDI** track (a clip pointing at the `.mid`, which `export_midi` reads).

## Notated clips are played, not just drawn

`lib/synth.ts` is a ~90-line Web Audio voice: one shared `AudioContext` (created on the first
play — browsers want a gesture), one triangle oscillator per note with a short attack/release
envelope, everything scheduled ahead of time so it lands on the grid instead of following the
animation frame. `StudioPage.syncPlayers` treats a clip with `notes` like a clip with audio: entering
it starts a voice (with `leadSeconds` telling the synth how far into the clip the playhead already
is, so a seek does not replay what has passed), leaving it or pausing stops the voice. Mix level is
the track's fader, muted/soloed as usual, and kept under the rendered audio on purpose.
`apps/web/tests/synth.test.mjs` drives it against a stub `AudioContext` (measured in the browser too:
four notes in a clip → four oscillators started, context running).

## A song, from one sentence (measured 2026-09-15)

`render_song` now takes `sections` + per-part `segments` (see the generator's `docs/internals.md`), so
the sentence "做一首 12 小节的 deep house：intro 4 小节只有 hats 和和弦，drop 6 小节进 kick+clap+贝斯，
outro 2 小节只留和弦，顺便把 MIDI 也写出来" produces:

| Evidence | Value |
| --- | --- |
| stems on the timeline | 鼓 12 小节 · 贝斯 12 小节 · 和弦 12 小节 · MIDI 12 小节 |
| sections drawn on the ruler | intro 4 · drop 6 · outro 2 |
| exported mix (48 kHz, via the dialog) | intro 0.098 · drop 0.252 · outro 0.105 RMS per section |
| exported MIDI (via the dialog) | 148 notes, tempo 122, kick/clap/hat + bass + chords |

Exports are not limited to PCM either: `container: "m4a"` goes through the same decoder/encoder the
mixdown reads with (afconvert or ffmpeg), and a clip the decoder cannot read comes back in the
export's `warnings` instead of vanishing from the bounce.

The before-picture is worth keeping: a drum part used to render one bar of audio followed by silence
(`night-drive-drums.wav`: bar 1 = 0.108 RMS, bars 2–8 = 0.000), because `_render_drums` placed its
step row once instead of tiling it. That bug is fixed in the generator, with a test.

## Exports (measured 2026-09-14)

| What | Tool | Notes |
| --- | --- | --- |
| 整首 | `mix_arrangement` | places every clip on the bar grid, resamples, applies track/clip gain, `tanh` soft clip; WAV 16/24-bit or AIFF, 44.1/48/96 kHz |
| 分轨 | `export_stems` | one file per track (`<name>-<NN>-<track>.<ext>`), empty tracks skipped |
| MIDI | `export_midi` | Type-1 with a conductor track (tempo + 4/4); notes come from `clip.notes` or a parsed `.mid` clip, audio-only clips land in `skipped` |

Lossy containers are rejected by the tool (`container must be wav or aiff`) rather than silently
written as WAV. The UI's 导出音频 dialog picks the tool by 内容 and disables rate/depth/format for MIDI.

One sentence, end to end: *做一首 4 小节 124 BPM 的鼓 + 贝斯，然后把分轨导出到 /tmp/nl-out/stems
（24-bit 48k WAV），再导出一份 MIDI 到 /tmp/nl-out/song.mid* → the agent called `render_song`,
`export_stems`, `export_midi`; the disk held `nl-groove-01-drums.wav` / `nl-groove-02-bass.wav`
(48 kHz, 24-bit, 7.74 s = 4 bars at 124 BPM) and `song.mid` (Type-1, 56 notes, tempo 124).

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
