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
  global config. An approvals UI is the next step; until then the header chips show the mode.
- **Binary.** `SHADOWROOM_CODEX` points at the codex binary; the default is the one shipped inside
  the Codex desktop app (`/Applications/ChatGPT.app/Contents/Resources/codex`).

## Browser storage keys

| Key | Owner | Contents |
| --- | --- | --- |
| `shadowroom.sessions.v1` | `lib/sessions.ts` | every session: title, messages, tool calls, active id |
| `shadowroom.chat.width` | `components/Conversation.tsx` | dragged transcript width in px (absent = adaptive clamp) |
| `shadowroom.converter.paths` | `components/ConverterPanel.tsx` | Rekordbox database/dir and Serato database paths |

## Transcript width handles

The conversation column keeps one width axis (`--sr-content-width`, an adaptive
`clamp(640px, 62%, 880px)`). Two 40px strips sit 24px outside it; dragging either one writes a
symmetric preference (outward travel widens by 2× the pointer distance), clamped to
`[640px, column − 176px]`, and double-clicking a strip clears it. When the column cannot hold
`inset + strip + safe zone` the computed strip width is 0 — the DSH behaviour, so a narrow column
never carries a mispositioned hit area.
