# Producer Tools

把九个开源的 ShadowRoom MCP 服务器连接成一套面向 DJ / 制作人的桌面体验，同时保持每个服务器都可被
任意 MCP 客户端独立调用。

The desktop application that bundles the ShadowRoom MCP servers into one product for DJs and
producers.

[English](README.md) · 许可证：[AGPL-3.0](LICENSE)

## MCP 生态

每项能力都是独立、公开的 stdio MCP 服务器。机器可读清单在
[`mcp/manifest.json`](mcp/manifest.json)，通用客户端接入方法见
[`docs/mcp-integration.md`](docs/mcp-integration.md)。

| MCP 服务器 | 能力 | 许可证 |
| --- | --- | --- |
| [converter](https://github.com/shadowroommusic/rekordbox-serato-bridge) | Rekordbox ⇄ Serato 播放列表、Cue、Loop、颜色 | AGPL-3.0 |
| [audio analysis](https://github.com/shadowroommusic/audio-analysis-dedupe) | 音频分析、BPM/调性、哼唱、查重 | AGPL-3.0 |
| [set planner](https://github.com/shadowroommusic/set-planner) | Set 排序、衔接计时与和声推荐 | AGPL-3.0 |
| [music generator](https://github.com/shadowroommusic/shadow-music-generator) | 合成、编曲、MIDI 与渲染 | AGPL-3.0 |
| [stem splitter](https://github.com/shadowroommusic/stem-splitter) | 人声、鼓、贝斯和其它分轨 | AGPL-3.0 |
| [SoundFont renderer](https://github.com/shadowroommusic/soundfont-renderer) | MIDI 转真实乐器音色 | AGPL-3.0 |
| [steward](https://github.com/shadowroommusic/steward) | 持久账本、摘要与 Agent 交接 | AGPL-3.0 |
| [library](https://github.com/shadowroommusic/library) | 曲目索引、元数据、封面、分类库与 Cue | AGPL-3.0 |
| [ShadowMusicGrabber](https://github.com/shadowroommusic/ShadowMusicGrabber) | 探测、解密、转码与下载 | MIT |

```sh
node tools/bootstrap-ecosystem.mjs
node tools/print-mcp-config.mjs > shadowroom-mcp.json
```

## 当前状态

进行中。Web UI 外壳已经能跑起来，布局与交互参考 DeepSeek Harness：三栏框架（侧栏放工作区和插件、
中间是工作区、右侧是对话栏），全部基于我们自己的 `--sr-*` token —— 默认暗色，
需要时才切浅色。品牌文件直接取自 [shadowroom.cn](https://shadowroom.cn)（见 `assets/logo/README.md`）。

内核要离开沙箱时会先问：命令执行和文件修改的审批会以卡片出现在输入框上方（**拒绝 / 本次会话都允许 /
允许一次**），跟 DeepSeek Harness 用的是同一个位置。没跑 `pnpm serve:agent` 的时候，提交仍然只把需求
记进会话，并加一条"内核未启动"的状态行。还没做的：`stage_serato_cues` 的界面，以及把应用打包成
`apps/desktop`。UI／前端参考写在 [docs/ui-reference.md](docs/ui-reference.md)（模式参考 DeepSeek
Harness）。

## 跑起来

```sh
pnpm install
pnpm serve        # MCP bridge：拉起九个 ShadowRoom MCP 服务器，/api 在 127.0.0.1:8787
pnpm serve:agent  # agent bridge：驱动 `codex app-server`，/api/agent 在 127.0.0.1:8788
pnpm dev          # Web UI，http://localhost:5173（/api 与 /api/agent 都代理到 bridge）
```

两个 bridge 都起着的时候，输入框跑的是真实的 agent 轮次：消息交给 Codex 内核，回答流式写进会话，
智能体调用的每个工具都在发生的位置出现一行（与 **轨迹** 里是同一批），旁边还有折起来的"思考"行和
每一轮的 token／耗时。九个 MCP 服务器会注入到每个线程，所以智能体用的就是面板手动调用的那批工具。

输入框是通用 agent 的形态：左边 **+** 里附加上下文（文件／文件夹路径，或某个插件，会变成草稿上方的
chip），右边选模型，回车发送。**插件不在输入框里选** —— 它们在侧栏的 **插件** 页面上，选中哪个就把
哪个的面板开到中间主区（右边仍然是对话）。面板本身也照旧能单独跑任务：

**Studio**（侧栏 → Studio）先给你**工程列表** —— 新建工程，或者打开上次那个 —— 打开之后才进入多轨工作区：
上面一条走带（BPM／调性／小节数），左边一列轨道头（名字、静音、独奏、推子、电平），右边是带小节线的
排列区 —— 双击空白处加片段、拖动移动、Delete 删除。新工程是空的（只有命名好的轨道，没有片段），
时间线上的东西永远是你或智能体真的做出来的。

它**真的会响**：导入音频把磁盘上的文件放到轨道（长度按文件真实时长算；mp3、m4a、flac、aiff 都行，
不只是 WAV），走带通过本地 bridge 流式播放，
播放头划过片段就开始/停下，静音、独奏、推子直接控制音量。片段可以拖动、拖右边缘改长度、删除；点小节尺
可以定位；缩放能改每小节宽度。带**音符**的片段（哼唱转出来的旋律、MIDI 片段）会用内置的小合成器发声，
并在片段里画出迷你钢琴卷 —— 时间线上没有"看得见却听不到"的东西。

**导出音频**有三件事，全部是真文件：**整首**（按你的排布混成一个）、**分轨**（每条轨道一个文件）、
**MIDI**（Type-1，一条轨道对应一个声部；音符来自 MIDI 片段，或来自哼唱转 MIDI 记下的音符）。采样率
（44.1/48/96 kHz）、位深（16/24）、格式（**WAV / AIFF / M4A (AAC)**）都能选 —— AAC 用的是机器上已有的
编码器（macOS `afconvert`，或 ffmpeg），界面上也如实写着；只有 MP3 需要你自己装编码器。

这些不只是按钮能用：一句话里同时要"做一首歌 + 导出分轨 + 导出 MIDI"，智能体会自己调 `render_song`、
`export_stems`、`export_midi`。

**是歌，不是循环**："32 小节的 tech house：intro 8、drop 16、outro 8"到手时是一份编曲 —— 合成器按段落
（`segments`）分别渲染每个声部，Studio 把歌曲结构画成小节尺上方的段落块，并在轨道区里画出分界线，每个
声部一整首只落一个片段。同一句话里再要 MIDI，渲染会顺手交出同一份编曲的 MIDI（鼓在 MIDI 鼓通道上），
它作为一条 **MIDI** 轨和分轨并排出现 —— 两种导出都来自同一份计划。

**语音** —— 任意页面输入框上的麦克风按钮点一下就是**通话**，不是听写：输入框整块变成实时的声波，通话
一直开着，轮次像打电话一样 —— 你说话，**停下来**就算说完了，回答被念回来；你打断它，它立刻停下并重新开始
听。每一轮都会带上一段 WAV（所以你哼的旋律是以音频形式给到它的，不只是文字），说话时声波下方还会显示
它听到的内容。仅 Chrome/Edge；浏览器不支持语音识别时按钮是灰的。

说一句"把这段哼唱转成 MIDI"，这件事就在同一次对话里完成：智能体对刚拿到的录音调用旋律工具
（`hum_to_midi`，在 `audio-analysis-dedupe` 里），识别出的音符会作为片段（带迷你钢琴卷）直接出现在当前
Studio 工程里 —— 没有额外的按钮，也没有第二步。

**右侧栏就是对话**：会话流 + 输入框，中间主区始终留给作品 —— 工作台（最近的工程、最近的对话、
插件入口）、Studio、插件面板 —— 都在它旁边。点开侧栏里的某条会话时，会话流会移到中间主区、右侧栏自动
收起，同一份对话不会出现两遍。收起后它是一条窄边栏，那个按钮不会压住页面上的按钮。开合状态会被记住。

```sh
pnpm test    # 通话的两个检测器（何时算说完、何时算打断）用合成响度曲线跑一遍
```

| MCP 服务器 | 做什么 |
| --- | --- |
| `rekordbox-serato-bridge` | 读两个曲库、只读预览、把播放列表转换到输出目录，或写回 Rekordbox（默认 dry-run） |
| `set-planner` | 给有序 set 计时：cue 段长、衔接、警告、总时长 |
| `audio-analysis-dedupe` | 单文件分析，或整个文件夹查重（只读，不删文件） |
| `shadow-music-generator` | 登记生成任务（dry-run，不跑模型），并能读回任务 |
| `stem-splitter` | 把成品歌拆成人声 / 鼓 / 贝斯 / 其它分轨 |
| `soundfont-renderer` | 用真实 SoundFont 乐器渲染音符与 MIDI |
| `steward` | 持久事件账本、摘要与 Agent 交接 |
| `library` | 指纹增量索引、BPM/调性元数据、分类库与 Cue |
| `ShadowMusicGrabber` | 音频探测、解密、转码与下载 |

bridge 默认到 `~/Documents/ShadowRoom` 找插件；路径不同就设 `SHADOWROOM_HOME`（另外还有
`SHADOWROOM_PYTHON`、`SHADOWROOM_BRIDGE_PORT`、`SHADOWROOM_CALL_TIMEOUT_MS`）。细节见
[docs/internals.md](docs/internals.md)。

## 独立 MCP 使用

每个服务器都可以脱离 ShadowRoom 桌面应用独立运行。把九个公开仓库克隆到相邻目录，生成标准的
`mcpServers` 配置后，Codex、Claude Desktop、Cursor、Cline、Roo Code 或任何其它 MCP 客户端都可以接入。
见 [docs/mcp-integration.md](docs/mcp-integration.md) 和
[机器可读清单](mcp/manifest.json)。

## 计划

1. 九个 MCP 服务器接入同一桌面应用。✅
2. Studio、DJ、曲目库、转换、生成与 Agent 链路。✅
3. 通用 MCP 发现与客户端配置。✅
4. 已签名的 macOS 与 Windows 公开发布。← *进行中*

## 许可证

AGPL-3.0，见 [LICENSE](LICENSE)。
