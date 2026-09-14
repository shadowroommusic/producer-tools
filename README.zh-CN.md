# Producer Tools

把 ShadowRoom 的四个 MCP 服务器打包成一个面向 DJ / 制作人的桌面应用。

The desktop application that bundles the ShadowRoom MCP servers into one product for DJs and
producers.

[English](README.md) · 许可证：[AGPL-3.0](LICENSE)

## 当前状态

骨架阶段。UI／前端参考已经写在 [docs/ui-reference.md](docs/ui-reference.md)（模式参考 DeepSeek
Harness）；agent 内核按已定方案接入 —— 内置 `codex` 二进制，走它的 `app-server` 协议。

## 会包含什么

| 工具 | 界面 |
| --- | --- |
| `rekordbox-serato-bridge` | 转换与预览：播放列表、cue/loop/颜色、dry-run 报告 |
| `audio-analysis-dedupe` | 资料库分析与查重分组 |
| `set-planner` | set 时间轴与下一首推荐 |
| `shadow-music-generator` | 生成任务：队列、阶段、产物、许可证 |

四个工具仍然各自可以单独作为 MCP 服务器使用；这个应用是把它们装进来、统一设置、给 DJ 一个入口的外壳。

## 计划

1. UI 设计（按 `docs/ui-reference.md` 的参考）；
2. 应用骨架：pnpm workspace、`apps/desktop`、`ui-*` 包、`--sr-*` 设计 token；
3. 接入 Codex harness（内置 `codex` 二进制 + `app-server` 协议），并把四个 MCP 服务器注册进去。

## 许可证

AGPL-3.0，见 [LICENSE](LICENSE)。
