# UI & frontend reference (from DeepSeek Harness)

`producer-tools` takes its UI/frontend patterns from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, MIT). This note records
what we borrow, what we replace with our own, and how the agent core plugs in.

> 中文摘要：UI／前端参考 DeepSeek Harness 的技术栈与架构模式（pnpm + React + Vite + CSS Modules +
> token 化设计体系 + 插件化 `ui-*` 包 + slots/docks）；品牌与配色用我们自己的（`--sr-*` token，
> 暗色优先，品牌色 `#0B0B0F`）；agent 内核按已定方案接入 —— 内置 `codex` 二进制 + app-server 协议。

## What DSH does

| Area | DSH choice |
| --- | --- |
| Monorepo | pnpm workspaces (`pnpm@11`) |
| Web app | `apps/web`: React + Vite + TypeScript |
| Desktop | `apps/desktop`: Electron (+ electron-builder / electron-updater) |
| Styling | CSS Modules per component (no Tailwind) |
| Design system | `packages/client/ui-theme`: token platform — `--dsw-static-*` colour ramps plus `--dsw-alias-*` semantic tokens, with extra layers for base, corner-shape, gradient/shadow, scrollbar and code highlighting |
| Primitives | `packages/client/ui-primitives`: Button, Input, Menu, Modal, Switch, Pill, HoverCard, DiffBlock, JsonTree, SearchBlock, StateDot, … |
| App shell | `ui-layout` + `ui-sidebar`, `ui-sidebar-right`, `ui-dockkit` |
| Feature surfaces | one package each: `ui-chat`, `ui-conversation`, `ui-tool`, `ui-trajectory`, `ui-plan`, `ui-jobs`, `ui-schedule`, `ui-skill`, `ui-subagent`, `ui-settings*`, … |
| Extensibility | the UI itself is plugin-based: packages register into **slots** (`ui-slots`), so surfaces can be added or removed |
| i18n | every package carries `.i18n.yaml` (+ a Chinese variant) and uses `packages/client/locale` |

## What `producer-tools` adopts

- **Same stack**: pnpm workspaces, React + Vite + TypeScript, CSS Modules, Vitest; Electron for the
  desktop shell.
- **Same architecture**: small `ui-*` packages per surface, slots for extension points, docks for
  secondary panels — one panel per MCP tool:

  | MCP server | Panel |
  | --- | --- |
  | `rekordbox-serato-bridge` | conversion & preview: playlists, cues/loops/colors, dry-run reports |
  | `audio-analysis-dedupe` | library analysis and duplicate groups (keep / review) |
  | `set-planner` | set timeline plus next-track suggestions with score breakdown |
  | `shadow-music-generator` | generation jobs: queue, stages, artifacts, license notes |

- **Our own tokens**: `--sr-*` namespace, dark-first, brand colour `#0B0B0F`; keep DSH's
  static/alias split and the auxiliary layers (scrollbar, code highlight) as structure, not as
  colours.
- **Bilingual by default** (zh/en), following our repository rule: bilingual README intro and
  GitHub description, full Chinese text alongside English.
- **Agent core**: the app is a shell around the Codex harness (see below); panels talk to the MCP
  servers, not to vendor formats.

## Agent core integration (decided 2026-09-14)

- Bundle the **`codex` binary** and run it in **`app-server` mode**; the UI talks to it over its
  protocol / control socket — the same pattern the Codex desktop app uses (`codex-rs/app-server*`,
  `codex-app-server-protocol`).
- The four ShadowRoom MCP servers are registered with that harness, so every panel above is backed
  by the same tools that are already published as standalone MCP servers.
- Pin the Codex version, and ship the Apache-2.0 `NOTICE` with the app.

## Status

Built so far:

- pnpm workspace (`apps/*`, `packages/*`) with `packages/ui-tokens`: static ramp + semantic aliases +
  shell geometry, dark first, light behind `<html data-theme="light">`.
- `apps/web`, shaped like DSH's shell rather than like a dashboard:

  | DSH | ours |
  | --- | --- |
  | `ui-layout` three-column frame, drag handles, rail collapse | `src/shell/AppFrame.tsx` + `shell/columns.ts` |
  | `ui-sidebar` brand row, New Session, panel rows, rail | `src/components/Sidebar.tsx` — workspaces (工作台 / 曲目库 / Studio / DJ / 设置) then the **plugins** |
  | `ui-conversation` header, view tabs, hero phase, sticky composer | `src/components/Conversation.tsx`, `Composer.tsx` |
  | `ui-chat` transcript rows, tool-call disclosure | `src/components/ToolCallRow.tsx` |
  | `ui-sidebar-right` right dock | `src/components/DockPanel.tsx` — hosts the selected plugin |

- Brand: files taken from shadowroom.cn, applied through `components/BrandMark.tsx` and
  `apps/web/public/brand/`.
- First runnable panel: `SetPlannerPanel` calls `plan_set` through `/api/call`; `tools/mcp-bridge.mjs`
  (`pnpm serve`) is the HTTP shim that spawns the plugin and speaks MCP over stdio. Runs are recorded
  as tool-call rows under the 轨迹 tab.

Next: `tools/mcp-bridge.mjs` (the `pnpm serve` script) so the panels talk to MCP over stdio, then the
Codex `app-server` core behind the composer, then the `ui-*` package split and `apps/desktop`.
