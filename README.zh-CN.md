# Producer Tools

把 ShadowRoom 的四个 MCP 服务器打包成一个面向 DJ / 制作人的桌面应用。

The desktop application that bundles the ShadowRoom MCP servers into one product for DJs and
producers.

[English](README.md) · 许可证：[AGPL-3.0](LICENSE)

## 当前状态

进行中。Web UI 外壳已经能跑起来，布局与交互参考 DeepSeek Harness：三栏框架（侧栏放工作区和插件、
中间是会话与输入框、右侧是当前插件的面板），全部基于我们自己的 `--sr-*` token —— 默认暗色，
需要时才切浅色。品牌文件直接取自 [shadowroom.cn](https://shadowroom.cn)（见 `assets/logo/README.md`）。

内核要离开沙箱时会先问：命令执行和文件修改的审批会以卡片出现在输入框上方（**拒绝 / 本次会话都允许 /
允许一次**），跟 DeepSeek Harness 用的是同一个位置。没跑 `pnpm serve:agent` 的时候，提交仍然只把需求
记进会话，并加一条"内核未启动"的状态行。还没做的：`stage_serato_cues` 的界面，以及把应用打包成
`apps/desktop`。UI／前端参考写在 [docs/ui-reference.md](docs/ui-reference.md)（模式参考 DeepSeek
Harness）。

## 跑起来

```sh
pnpm install
pnpm serve        # MCP bridge：拉起四个 ShadowRoom MCP 服务器，/api 在 127.0.0.1:8787
pnpm serve:agent  # agent bridge：驱动 `codex app-server`，/api/agent 在 127.0.0.1:8788
pnpm dev          # Web UI，http://localhost:5173（/api 与 /api/agent 都代理到 bridge）
```

两个 bridge 都起着的时候，输入框跑的是真实的 agent 轮次：消息交给 Codex 内核，回答流式写进会话，
智能体调用的每个工具都在发生的位置出现一行（与 **轨迹** 里是同一批），旁边还有折起来的"思考"行和
每一轮的 token／耗时。四个插件会注入到每个线程，所以智能体用的就是面板手动调用的那批工具。

输入框是通用 agent 的形态：左边 **+** 里附加上下文（文件／文件夹路径，或某个插件，会变成草稿上方的
chip），右边选模型，回车发送。**插件不在输入框里选** —— 它们在侧栏的 **插件** 页面上，选中哪个就把
哪个的面板开到右边。面板本身也照旧能单独跑任务：

**Studio**（侧栏 → Studio）先给你**工程列表** —— 新建工程，或者打开上次那个 —— 打开之后才进入多轨工作区：
上面一条走带（BPM／调性／小节数），左边一列轨道头（名字、静音、独奏、推子、电平），右边是带小节线的
排列区 —— 双击空白处加片段、拖动移动、Delete 删除。

它**真的会响**：导入音频把磁盘上的文件放到轨道（长度按文件真实时长算），走带通过本地 bridge 流式播放，
播放头划过片段就开始/停下，静音、独奏、推子直接控制音量。片段可以拖动、拖右边缘改长度、删除；点小节尺
可以定位；缩放能改每小节宽度。

**语音** —— 任意页面输入框上的麦克风按钮点一下就是**通话**，不是听写：输入框整块变成实时的声波，通话
一直开着，每说完一句就带着这一段 WAV 一起发给智能体（所以你哼的旋律是以音频形式给到它的，不只是文字），
回答会被念回来，然后继续听。仅 Chrome/Edge；浏览器不支持语音识别时按钮是灰的。

说一句"把这段哼唱转成 MIDI"，这件事就在同一次对话里完成：智能体对刚拿到的录音调用旋律工具
（`hum_to_midi`，在 `audio-analysis-dedupe` 里），识别出的音符会作为片段（带迷你钢琴卷）直接出现在当前
Studio 工程里 —— 没有额外的按钮，也没有第二步。

**右侧栏**有两个标签：**对话**（会话流 + 输入框，在 Studio 里也能一边看一边打字）和当前 **插件面板**。
侧栏收起时，页面右上角有一个"对话 ›"按钮把它展开。

| 面板 | 做什么 |
| --- | --- |
| `rekordbox-serato-bridge` | 读两个曲库、只读预览、把播放列表转换到输出目录，或写回 Rekordbox（默认 dry-run） |
| `set-planner` | 给有序 set 计时：cue 段长、衔接、警告、总时长 |
| `audio-analysis-dedupe` | 单文件分析，或整个文件夹查重（只读，不删文件） |
| `shadow-music-generator` | 登记生成任务（dry-run，不跑模型），并能读回任务 |

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
2. 接上 bridge（`pnpm serve`），让各个面板能真的跑任务。✅ *四个面板都接好了（`stage_serato_cues`
   还没有界面）*
3. 接入 Codex harness（内置 `codex` 二进制 + `app-server` 协议），并把四个 MCP 服务器注册进去。
4. 桌面外壳（`apps/desktop`）。

## 许可证

AGPL-3.0，见 [LICENSE](LICENSE)。
