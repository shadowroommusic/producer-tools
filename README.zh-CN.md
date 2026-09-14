# Producer Tools

把 ShadowRoom 的四个 MCP 服务器打包成一个面向 DJ / 制作人的桌面应用。

The desktop application that bundles the ShadowRoom MCP servers into one product for DJs and
producers.

[English](README.md) · 许可证：[AGPL-3.0](LICENSE)

## 当前状态

进行中。Web UI 外壳已经能跑起来，布局与交互参考 DeepSeek Harness：三栏框架（侧栏放工作区和插件、
中间是会话与输入框、右侧是当前插件的面板），全部基于我们自己的 `--sr-*` token —— 默认暗色，
需要时才切浅色。品牌文件直接取自 [shadowroom.cn](https://shadowroom.cn)（见 `assets/logo/README.md`）。

还没做的：把输入框里的需求变成一次真实会话的 Codex 内核，以及另外三个插件的面板。UI／前端参考写在
[docs/ui-reference.md](docs/ui-reference.md)（模式参考 DeepSeek Harness）。

## 跑起来

```sh
pnpm install
pnpm serve   # MCP bridge：拉起四个 ShadowRoom MCP 服务器，在 127.0.0.1:8787 提供 /api
pnpm dev     # Web UI，http://localhost:5173（/api 代理到 bridge）
```

bridge 起着的时候，侧栏里的插件显示为已连接，`set-planner` 面板跑的是真实任务：点 **运行 plan_set**，
时间轴、衔接和小节信息从插件返回，这一次调用同时记进 **轨迹** 标签页。

bridge 默认到 `~/Documents/ShadowRoom` 找插件；路径不同就设 `SHADOWROOM_HOME`（另外还有
`SHADOWROOM_PYTHON`、`SHADOWROOM_BRIDGE_PORT`、`SHADOWROOM_CALL_TIMEOUT_MS`）。细节见
[docs/internals.md](docs/internals.md)。

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
2. 接上 bridge（`pnpm serve`），让各个面板能真的跑任务。← *bridge 和第一个面板（`set-planner`）
   已经能跑，另外三个面板接着做*
3. 接入 Codex harness（内置 `codex` 二进制 + `app-server` 协议），并把四个 MCP 服务器注册进去。
4. 桌面外壳（`apps/desktop`）。

## 许可证

AGPL-3.0，见 [LICENSE](LICENSE)。
