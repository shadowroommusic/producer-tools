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
| `producer-tools` | the app that collects these tools into one product | web UI + MCP bridge run today, three of four plugin panels wired; conversion panel and Codex core next |
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
