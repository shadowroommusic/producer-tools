# Producer Tools

把 ShadowRoom 的四个 MCP 服务器打包成一个面向 DJ / 制作人的桌面应用。

The desktop application that bundles the ShadowRoom MCP servers into one product for DJs and
producers.

[English](README.md) · 许可证：[AGPL-3.0](LICENSE)

## 当前状态

进行中。Web UI 外壳已经能跑起来，布局与交互参考 DeepSeek Harness：三栏框架（侧栏放工作区和插件、
中间是会话与输入框、右侧是当前插件的面板），全部基于我们自己的 `--sr-*` token —— 默认暗色，
需要时才切浅色。品牌文件直接取自 [shadowroom.cn](https://shadowroom.cn)（见 `assets/logo/README.md`）。

还没做的，按顺序是：让 UI 真正调起四个 MCP 服务器的 bridge，以及把输入框里的需求变成一次真实会话的
Codex 内核。UI／前端参考写在 [docs/ui-reference.md](docs/ui-reference.md)（模式参考 DeepSeek Harness）。

## 会包含什么

| 工具 | 界面 |
| --- | --- |
| `rekordbox-serato-bridge` | 转换与预览：播放列表、cue/loop/颜色、dry-run 报告 |
| `audio-analysis-dedupe` | 资料库分析与查重分组 |
| `set-planner` | set 时间轴与下一首推荐 |
| `shadow-music-generator` | 生成任务：队列、阶段、产物、许可证 |

四个工具仍然各自可以单独作为 MCP 服务器使用；这个应用是把它们装进来、统一设置、给 DJ 一个入口的外壳。

## 计划

1. UI 层（按 `docs/ui-reference.md` 的参考）。← *进行中*
2. 接上 bridge（`pnpm serve`），让各个面板能真的跑任务。
3. 接入 Codex harness（内置 `codex` 二进制 + `app-server` 协议），并把四个 MCP 服务器注册进去。
4. 桌面外壳（`apps/desktop`）。

## 许可证

AGPL-3.0，见 [LICENSE](LICENSE)。
