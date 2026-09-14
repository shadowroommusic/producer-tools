# Agent notes — ShadowRoom

Repo conventions and the current roadmap, for anyone (human or agent) picking this up later.

## Repo map

One MCP plugin = one repository.

These MCPs are the **tool layer**: each one is useful on its own (any MCP-capable agent can drive
it), and together they are the toolkit that `producer-tools` bundles into one app and
`shadow-producers` drives as an agent.

| Repo | What it is | Status |
| --- | --- | --- |
| `rekordbox-serato-bridge` | Rekordbox ⇄ Serato library conversion (cues, loops, colors, playlists) | published; real-machine tested |
| `audio-analysis-dedupe` | Audio analysis + duplicate detection | published; not yet user-tested |
| `set-planner` | Set timing + next-track suggestions | published; not yet user-tested |
| `shadow-music-generator` | Queue for local AI music generation pipelines | published; not yet user-tested |
| `producer-tools` | the app that collects these tools into one product | web UI, MCP bridge, agent bridge (real Codex turns) and persisted sessions; all four plugin panels wired; approvals UI and desktop packaging next |
| `shadow-producers` (planned) | the AI agent | not started |

## House rules

- **License:** AGPL-3.0 everywhere (see `LICENSE`).
- **README:** user-facing only — features / requirements / install / configuration / tools / usage /
  safety / troubleshooting / license. The **intro is bilingual** (one English sentence + the same
  sentence in Chinese), and so is the GitHub repository description; the rest of `README.md` stays
  English with the full Chinese text in `README.zh-CN.md`. Implementation notes belong in
  `docs/internals.md`. See `CONTRIBUTING.md`.
- **Commits:** `feat(scope):`, `fix(scope):`, `docs(scope):`, `chore(scope):`; author
  `shadowroommusic <shadowroommusic@users.noreply.github.com>` (set per repo via
  `git config user.name` / `user.email`).
- **No guessing about vendor formats.** Only behaviour that was measured or verified on a real
  machine goes into code, docs or tests.
- **Real-machine verification** (Rekordbox, Serato, the actual hardware) is required before calling a
  conversion feature done.

## Decisions

- **2026-09-14 — UI/frontend reference.** `producer-tools` follows the UI/frontend patterns of
  DeepSeek Harness (pnpm workspaces, React + Vite + CSS Modules, token-based theming, plugin-style
  `ui-*` packages with slots and docks, per-package i18n) with our own `--sr-*` tokens and brand
  colours. The agent core is the Codex harness (bundled `codex` binary + `app-server` protocol).
  Details: `producer-tools/docs/ui-reference.md`.

- **2026-09-14 — harness evaluation (Codex vs DeepSeek).** The Codex harness (`openai/codex`,
  Apache-2.0) **can** be used inside Shadow Producers: bundle the `codex` binary and drive it in
  `app-server` mode through its protocol/control socket (`codex-rs/app-server*` crates,
  `codex-app-server-protocol` is published on crates.io; the same pattern the Codex desktop app
  uses). Linking the Rust crates directly would require vendoring the workspace, because
  `codex-core` / `codex-app-server` are **not** published. Codex natively speaks MCP, so the four
  ShadowRoom plugins drop straight in. `deepseek-ai/deepseek-harness` (MIT, everything-is-a-plugin)
  works as a reference or alternative, but is a developer preview with breaking changes.
  Reference checkouts live in `~/Documents/ShadowRoom/_reference/{codex,deepseek-harness}`.

- **2026-09-14 — the UI is shaped like DeepSeek Harness, not like a dashboard.** The shell is DSH's
  three-column frame: sidebar (280 default, 264–420 drag, 56px rail below 1024) | conversation |
  right dock (≥300, 45% on first open), both borders draggable. The conversation column owns a 76px
  header (crumbs + view tabs), a scrolling transcript, and a composer card (22px capsule, mode chips,
  34px send circle) that is centred as the hero in an empty session and sticky at the bottom once a
  session runs. The sidebar lists workspaces — 工作台 / 曲目库 / Studio / DJ / 设置 — and then the
  **plugins** (the four MCP servers); the dock shows the selected plugin's panel, it is not a server
  list. Colours, marks and copy are ours; only the layout, geometry and interaction patterns are
  taken from DSH. `apps/web/src/shell/AppFrame.tsx` holds the frame, `styles/*.css` the geometry.

- **2026-09-14 — the bridge is an HTTP shim over stdio MCP.** `tools/mcp-bridge.mjs` (`pnpm serve`)
  spawns each plugin's `mcp_server.py`, speaks MCP over stdio (one JSON object per line — that is how
  every ShadowRoom plugin frames messages), and exposes `GET /api/servers` plus `POST /api/call` to
  the web app. Node builtins only, lazy start, per-call timeouts, and stderr kept in the snapshot so
  the UI can say why a plugin is dark. Tool calls the UI runs are recorded as rows under the 轨迹
  tab. Notes: `docs/internals.md`.

- **2026-09-14 — paths are absolute, and the plugin expands `~`.** The conversion panel starts
  from the standard macOS locations under the `home` the bridge reports, and the bridge plugin now
  calls `expanduser()` on every path argument — MCP clients send plain strings, so no shell is
  there to expand a tilde (found by using the panel: `~/Library/...` failed with
  FileNotFoundError).

- **2026-09-14 — the agent core is the Codex harness, driven by `tools/agent-bridge.mjs`.**
  `pnpm serve:agent` spawns `codex app-server`, speaks its stdio JSON-RPC (initialize →
  thread/start → turn/start) and streams the turn to the UI as SSE; one UI session maps to one
  Codex thread. The four plugins are injected per thread with
  `default_tools_approval_mode: "approve"` — without it every MCP call is refused under
  `approvalPolicy: never`. Threads run `workspace-write` in `~/Documents/ShadowRoom`, which is
  narrower than the user's global `danger-full-access`; an approvals UI is the next step.
  Notes: `docs/internals.md`.

- **2026-09-14 — approvals are answered by the UI, not waved through.** The agent bridge now
  defaults to `approvalPolicy: on-request` and answers the core's server requests
  (`execCommandApproval` / `applyPatchApproval` and their v2 spellings) from a card above the
  composer; every other server request is refused with `-32601` so a turn can never hang on us.
  Measured: with `workspace-write`, writes inside the workspace and `/tmp` still run unattended
  and a home-directory write raises the prompt. The MCP plugins keep
  `default_tools_approval_mode: "approve"`.

- **2026-09-14 — the new-session screen is a generic agent, not a plugin picker.** Codex and DSH
  both put the model in the composer and keep plugins on a page: our sidebar is workspaces + a
  插件 entry + **对话** (the sessions), the composer's **+** attaches a file/folder path or a
  plugin (as a context chip and a `mention` input item), the chip on the right is the **model
  picker**, and the plugins page lists the installed cards. Reasoning is folded into 思考 rows and
  every turn ends with a `tokens · seconds` line.

- **2026-09-14 — no header chrome, and Studio is a DAW.** The conversation column carries no
  breadcrumbs, status chips or view tabs (the 轨迹 tab is gone with them); the transcript and the
  composer are the whole surface. Studio is the multi-track page — transport (BPM / key / bars),
  per-track header (name, mute, solo, fader, meter), a bar-ruled lane area with draggable clips, and
  the same composer docked underneath with a microphone button (Web Speech in, `speechSynthesis`
  out). Mode chips are 标准 / 极简 only.

- **2026-09-14 — voice is a call, and Studio has projects.** The microphone button starts a live
  session: the composer becomes a waveform, the mic stays open, each finished phrase is sent with its
  own WAV (browser-encoded, uploaded to `/api/agent/audio`, saved under `~/Documents/ShadowRoom/recordings`),
  the answer is spoken, then listening resumes. Studio opens on a project list and only then shows the
  multi-track workbench; the projects, the open project and the current page are all remembered.

- **2026-09-14 — everything is a plugin, and talk is the interface.** The user's direction: capabilities
  arrive as plugins (the DeepSeek Harness model), and the workbench stays voice-first. Concretely: the
  four MCP servers plus the melody tool (`hum_to_midi` in `audio-analysis-dedupe`) are the tool layer;
  the UI absorbs what tools produce (`absorbMelody` turns a `hum_to_midi` result into a Studio clip
  without a button); the agent is told the house rules per thread through `developerInstructions`; and
  typing happens in the dock's 对话 tab while the main page stays the work surface. Next candidates, in
  this shape: groove/drum recognition (polyphonic — basic-pitch, Apache-2.0), audio trim/edit tools, and
  splitting melody detection out into its own plugin repository.

- **2026-09-14 — Studio is the first page we call done, and it is done by playing.** The plan agreed
  with the user: build the UI surface by surface, but each surface has to *work* against the real
  tool layer before moving on. Studio therefore got audio playback (`GET /api/agent/file` with Range
  support, one `<audio>` per clip, fader/mute/solo driving volume), import-from-disk with the real
  file duration, clip move/resize/delete, ruler seek and zoom. Lesson recorded in the code: Studio
  edits are functional updates — a captured snapshot silently reverted an import once.

- **2026-09-15 — 工作台 is a page again, and the dock is the chat everywhere else.** The user's
  report ("面板按钮根本就没啥用，右侧对话栏在主工作台中不显示"): 工作台 rendered the conversation,
  and selecting it closed the dock, so the work page had no chat beside it and the same transcript
  appeared twice. Now 工作台 is `WorkbenchHome` (recent projects / conversations / plugins entry) with
  the conversation dock open on the right; opening a session moves the transcript into the centre
  column and folds the dock; the open/closed choice is remembered (`shadowroom.dock`). The plugin
  page's empty 面板 section is gone, and the plugin panel's back pill no longer stretches across the
  header (a grid item's inline default is `stretch`). A frame too narrow for a dock column (below
  ~760px) draws the open dock as a 420px drawer over the centre column instead of a zero-width track
  — measured 1px wide, with its close button off-screen, before that.

- **2026-09-15 — the voice call is turn-based, like a phone call.** "你说话停下来 → 他回答 →
  你说话可以打断他". Implemented as two pure detectors in `lib/voice.ts` (`createTurnDetector`,
  `createBargeIn`), because the recognizer's own phrase ends are unreliable and the answer leaks into
  the microphone. Three races were found by scripted tests and fixed with tokens (see
  `docs/voice-call.md`): a stopped recognizer's `onend` re-opened the turn (one phrase became two
  messages), a replaced session wrote the previous turn's words into the next, and a canceled
  answer's `onend` resumed listening twice. `pnpm test` drives both detectors with synthetic
  loudness traces; the real-speaker thresholds are still unverified.

- **2026-09-15 — every claim in this repo has a way to be checked again.** `pnpm typecheck` for the
  web app, `pnpm test` for the call's detectors, `python3 -m unittest discover -s tests -q` in each
  MCP repo, Playwright scripts under `/tmp/sp-shots` for the browser runs. The studio transport's
  action group (音轨 / 导入音频 / 导出音频) is one flex block so a narrow centre column wraps it as a
  row instead of orphaning 导出音频 above the timeline.

- **2026-09-14 — generator backend (option B).** `shadow-music-generator` stays backend-less for
  now: it is used as a job record + request manager (prompts, lyrics, parameters, license notes,
  dry-run by default). The real provider wiring happens later inside `producer-tools`. The YuE2
  adapter in `src/shadow_music_generator/adapters/` is kept as ready groundwork for whenever a
  machine or API is chosen — YuE2 itself needs Linux + an NVIDIA GPU (BF16, 24 GB), so it normally
  runs remotely (local GPU box, ssh, or a cloud API).

## Roadmap

1. Publish each MCP as its own public repository. ✅ *(done)*
2. **Test and optimise every MCP and the software gradually** — plugin by plugin, on the real
   machine, revisiting behaviour, edge cases and UX as we go.
3. Build `producer-tools`: the application that collects these MCPs into one product.
4. Build `shadow-producers`: the AI agent repository.
5. Open-source both when they are ready.

## Local environment (maintainer machine)

- Working copies live in `~/Documents/ShadowRoom/<repo>`; those are the git repos that push to
  GitHub.
- GitHub: `https://github.com/shadowroommusic/*`, pushed over SSH (`~/.ssh/id_ed25519`, key titled
  "shadowroom-automation (Codex)"). 2FA is enabled on the account.
- The Codex plugin marketplace named `shadowroom` currently points at an older monorepo checkout;
  the repositories above are the source of truth.
