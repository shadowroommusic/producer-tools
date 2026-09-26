# 桌面端打包方案（ADR-018 落地路径）

日期：2026-09-25 ｜ 作者：ZCode（GLM-5.3）｜ 任务：desktop-packaging（总线 #78 派单）
状态：**§1–4 调研定稿 → §5 第一刀已落地验收（2026-09-25，commit `2084148`，③⑤⑥⑦ + Codex 复验
1/2/4 全过）→ §6 第二刀方案待评审（2026-09-26，未动码）**

**结论先行**：用 **Electron 44 + electron-builder**。三个关键主张都已在真机验证过，
不是推测：

1. **不需要独立的 Node 运行时**——Electron 44 内置 node v24.21.0（与开发机 v24.19.0 同代），
   `ELECTRON_RUN_AS_NODE=1` 直接把 `tools/mcp-bridge.mjs` 连同 9 个 Python 插件全部拉起，
   **9/9 ready、68 个工具**（实测，2026-09-25）。
2. **前端零改动进壳**——vite `dist` 经 `app://` 自定义协议伺服、`/api` 与 `/api/agent`
   在协议层代理到两个桥（GET 断言 7/7 + POST 带 body 转发，含前缀路由顺序与路径穿越拒绝）。
3. **桥零改动换家**——两个桥的全部外部依赖都是环境变量旋钮：`SHADOWROOM_HOME`（插件源码与
   `_venvs` 根）、`SHADOWROOM_PYTHON_<ID>`、`SHADOWROOM_BRIDGE_PORT` / `SHADOWROOM_AGENT_PORT`、
   `SHADOWROOM_CODEX`。Electron 主进程设好环境变量即可，一行桥代码都不用改。

---

## 1. 方案对比

四个候选，按我们的六条硬约束打分。打分依据全部是可复现的事实（命令与版本号见文末证据索引）。

| 约束 | Electron + electron-builder | Electron Forge | Tauri 2 | 自研 Node 壳 |
| --- | --- | --- | --- | --- |
| spawn 两个 .mjs 桥 | ✅ **实测**：内置 node 24.21.0，RUN_AS_NODE 跑通全链 | ✅ 同左（同为 Electron） | ⚠️ 桥是 Node 脚本，必须把 node ~50MB 当 sidecar 另带，Rust 侧再写进程管理 | ✅ 但要自己写进程生命周期/重启/日志轮转 |
| spawn 9 个 Python 插件 | ✅ child_process + env 旋钮（现状机制原样） | ✅ 同左 | ⚠️ 可行（sidecar），但插件解释器派发逻辑要用 Rust 重写一遍 | ⚠️ 同左，全部自写 |
| macOS 签名 + 公证 | ✅ `afterSign` 钩子 + `@electron/notarize` 3.1.1（npm 实查）一条流水线配齐 | ✅ 官方也支持（自配钩子） | ✅ 支持 | ❌ 全部手搓（产品级 Gatekeeper 处理很容易做错） |
| 自动更新（可复用 Grabber 的 GitHub Releases + sha256 思路） | ✅ electron-updater 6.8.9：**blockmap 差分更新**（>300MB 包刚需）+ GitHub Releases provider；digest 校验原则与 Grabber `updater.py`（sha256 + 大小，`1cf8f03`）同源 | ⚠️ Squirrel 为主，差分弱；官方免费通道 update.electronjs.org 只服务公开仓库 | ⚠️ 有 updater 插件，但差分/通道都要另配 | ❌ 从零写 |
| Windows 安装包 | ✅ nsis（差分更新可用）+ msi 都是内置 target | ✅ Squirrel.Windows / MSI | ✅ nsis/msi | ❌ 手搓或拼 WiX |
| 渲染引擎与已验证行为一致 | ✅ **自带 Chromium**：多轨同步 0.064ms、AudioWorklet、录音链路全部在 Chrome 真机验过（STATUS 2026-09-16），Electron 同引擎直接继承 | ✅ 同左 | ❌ 系统 WebView（mac=WKWebView，win=WebView2）：我们的音频栈**没在 WKWebView 上验过**，回归面不可控 | 取决于选哪个 WebView（等于重新选型） |

**为什么是 electron-builder 而不是 Forge**：我们的仓库是私有的（`git@github.com:shadowroommusic/producer-tools.git`），
Forge 的官方更新通道只吃公开仓库；差分更新对 300MB+ 的包不是锦上添花而是必须。electron-builder
26.15.3（npm 实查）把 dmg + 公证 + nsis/msi + 差分更新收在一个配置文件里，社区事实标准。

**为什么不是 Tauri**：省下的是 Chromium 那 ~130–300MB，但我们反正要带 Python + 可选 torch
（win CPU wheel 一个就 198.5MB），壳的体积占比小；而它换来的是 (a) 把已验证的 Chrome 音频行为
押到没验过的 WKWebView 上，(b) 桥的进程管理要用 Rust 重写，团队栈里没有 Rust。省的体重不值冒的险。

**为什么不是自研壳**：等于自己重造 Tauri 的坑（两个平台的 WebView 差异 + 进程管理 + 更新器 + 公证），
且每一件都是一次性工程，没有社区维护。

体积参考（实测）：Electron 44.4.5 发行 zip——darwin-arm64 **130.4MB**、win32-x64 **158.2MB**
（GitHub Releases API）；解包后 Electron.app **296MB**（本机实测）。Tauri 壳号称 3–10MB，
但必须另带 node sidecar 才能跑我们的桥。

---

## 2. 运行形态：Python 插件怎么随包走

### 2.1 现状盘点（全部本机实测，2026-09-25）

9 个插件的依赖分三档（依赖声明来自各仓 `pyproject.toml`）：

| 档 | 插件 | 依赖 | 本机 venv 实测 |
| --- | --- | --- | --- |
| 轻量（numpy 系） | analysis / generator / library / steward / planner | numpy 或零依赖 | 8.9M / 8.9M / —(系统 py) / —(单文件) / —(零依赖) |
| 中量 | converter（pyrekordbox）、grabber（yt-dlp/mutagen/pycryptodome/requests）、soundfont（pyfluidsynth + fluidsynth C 库） | 各自小依赖树 | —(系统 py) / 32M / 42M |
| 重量 | splitter（`demucs[local]`） | torch 2.2.2 + demucs 4.0.1 | **381M**（torch 266M + numpy 46M + sympy 29M + …） |

模型/外部二进制（不在 venv 里）：htdemucs 权重 **80MB**（`~/.cache/torch/hub/checkpoints/955717e8-8726e21a.th`
实测；ft 版 ~700MB 不用）；ffmpeg 静态二进制（imageio-ffmpeg 0.6.0 的 mac arm64 wheel 实测
21.1MB，内含静态 ffmpeg）；GeneralUser GS 音色库（现状就是首次使用时下载）。

### 2.2 解释器：vendored python-build-standalone（推荐）

三个选项：

| 方式 | 体积（压缩） | 首启体验 | 失败模式 | 判定 |
| --- | --- | --- | --- | --- |
| **A. vendored python-build-standalone** | mac arm64 **25.3MB**、win x64 **47.5MB**（stripped 22.0MB），cpython 3.13.15，tag `20260924`（GitHub API 实查，昨天仍在发版） | 秒起，离线可用 | 几乎没有；只占体积 | ✅ **推荐** |
| B. 首启联网装 Python + 依赖 | 0 | 首启 2–10 分钟，要进度 UI | 断网/代理/公司防火墙/GitHub 限速（本机实测 GitHub 直连 ~1MB/2min）| 备选，只用于重依赖 |
| C. 系统 Python | 0 | — | macOS 只保证 CLT 的 3.9、Windows 根本没有；用户机器等于抽奖 | ❌ 否掉 |

**可搬迁性已实测**：python-build-standalone 是 uv 用的同一族构建。本机 uv 缓存里的
cpython 3.12.13（aarch64）拷到 `/tmp` → 跑通 → **目录改名再跑仍通**（ssl/sqlite3/zlib 全 OK，
`python -m venv` 也正常）。这族发行版用相对 RPATH，不锁绝对路径——venv 做不到这一点
（`pyvenv.cfg` 与 shebang 里写死绝对路径）。

### 2.3 插件环境：打包期离线建 env，按三档走

- **核心 8 个插件**（除 splitter 的 torch）：打包时用 vendored Python 建**一个共享 env**
  （numpy 系互相无冲突；pyrekordbox/yt-dlp/pyfluidsynth 都是小依赖树），`pip install --no-index
  --find-links wheels/` 从随包 wheel 目录装。桥侧不感知：Electron 主进程给每个插件设
  `SHADOWROOM_PYTHON_<ID>=<Resources>/python-runtime/bin/python`（机制现成，`mcp-bridge.mjs:46`）。
  也可以保保守按插件分 env——体积差主要是 numpy 重复几份，建议 v1 先共享、有冲突再拆。
  *（注意：这档要把 9 个插件仓的 `src` 复制进 extraResources，或打成 wheel 随包——桥是按
  `SHADOWROOM_HOME/<repo>/mcp_server.py` 找源码的。）*
- **splitter 的重依赖（torch+demucs+htdemucs）不进主包**，首用下载到用户数据目录
  （`app.getPath('userData')/heavy/demucs-env`），下载源用我们自己的 GitHub Releases 资产
  （ Grabber 更新器同款口径：sha256 + 大小双校验）。理由：
  - 体积：torch 2.2.2 **win CPU wheel 198.5MB** / mac arm64 **59.7MB**（PyPI 实查）+ htdemucs 80MB；
    进主包则 Windows 包瞬间 +270MB，而**不是每个用户都分轨**；
  - 已有退路：插件本来就支持 `STEM_SPLIT_COMMAND` 远端命令模式（无 torch 也能编进去）；
  - demucs 4.1.0（PyPI 最新）要求 `torch>=2.1`，与现有 2.2.2 兼容。
  - 反方案"预装进包"留给将来出"完全体"安装包再评估，机制不变只是资产位置变。
- **ffmpeg**：`extraResources/bin/ffmpeg(.exe)` 放静态二进制。桥的 `findFfmpeg()` 本来就先看
  `<WORKSPACES>/bin/`（`agent-bridge.mjs:89`），把 `SHADOWROOM_HOME` 指到 userData 下的运行时目录、
  首启把 extraResources 里的 bin 拷过去（或直接 symlink）即可，零桥改动。
  来源直接用 imageio-ffmpeg 的 wheel 内二进制（已实测可用）或官网静态构建，mac/win 各一份。

### 2.4 codex（agent 桥的大脑）——独立决策项

agent 桥要 spawn `codex app-server`，默认路径 `/Applications/ChatGPT.app/Contents/Resources/codex`
（可用 `SHADOWROOM_CODEX` 覆盖）。实测：本机这个二进制是 `codex-cli 0.154.0-alpha.6.2`、
`app-server` 子命令在（标 experimental）、**212MB**（arm64）。npm 上 `@openai/codex` 最新
0.157.0。三个选项：

| 选项 | 代价 | 判定 |
| --- | --- | --- |
| 随包带 codex | +212MB/平台（win x64 体积未测，待测） | 内测版可以先带，公开版太重 |
| 首用下载（GitHub Releases 资产，同 sha256 口径） | 首用要联网 + 进度 UI | ✅ 推荐 |
| 检测已装 ChatGPT.app / 已装 codex CLI，没有再下载 | 零体积、体验最好 | ✅ 与上一条合并做 |

**没找到 codex 时桥的行为**：`agent-bridge.mjs:946` 抛 `codex binary not found`——桌面壳必须把这个
状态 surfaced 成 UI（"对话能力未就绪，点这里下载"），不能让用户看到一个哑巴输入框。

### 2.5 打包后的进程树（目标形态）

```
ShadowRoom.app (Electron 44)
├─ 主进程 (main.mjs)
│   ├─ 注册 app:// 协议（伺服 dist + 代理 /api→MCP桥, /api/agent→agent桥）
│   ├─ spawn: [self, ELECTRON_RUN_AS_NODE=1] tools/mcp-bridge.mjs   ← 内置 node 跑，实测 9/9
│   ├─ spawn: [self, ELECTRON_RUN_AS_NODE=1] tools/agent-bridge.mjs ← 同上；再由它 spawn codex
│   └─ 端口：SHADOWROOM_BRIDGE_PORT/SHADOWROOM_AGENT_PORT 用高位端口（如 18787/18788），
│      避免和开发机常驻的 8787/8788 打架；renderer 只见 app:// 相对路径，端口无感
├─ mcp-bridge → spawn 9 × python (Resources/python-runtime，或 userData/heavy 里的 demucs env)
└─ agent-bridge → spawn codex app-server（随包/首用下载/检测已装，见 2.4）
```

崩溃隔离现状即答案：插件本来就是**每插件一个子进程**、桥对 error 状态有标记与重启逻辑
（`mcp-bridge.mjs` 的 `McpServer.start/stop` 与 error 快照），一个插件死不连坐——这条直接继承。

---

## 3. 构建流水线

### 3.1 本机最小可行（macOS，出未签名 .app 与 dmg）

目录方案（**不动根 package.json**；`pnpm-workspace.yaml` 本来就 glob `apps/*`，新包自动纳入）：

```
producer-tools/
├─ apps/web/            （不动）
├─ apps/desktop/        （新增，第一刀的全部代码住这里）
│  ├─ package.json      （main: main.mjs；devDeps: electron@44.4.5, electron-builder, electron-updater）
│  ├─ main.mjs
│  └─ electron-builder.yml
```

命令（一步步）：

```sh
export PATH="/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
cd producer-tools
corepack enable pnpm            # 若 pnpm 未启用（root 声明 packageManager pnpm@11.19.0）

# 1) 前端产物（已有脚本，dist 实测 1.4MB）
pnpm --filter @shadowroom/web build

# 2) 桌面壳依赖（新包，不影响 web）
pnpm --filter @shadowroom/desktop install
# 国内网络：Electron 二进制走镜像（本机实测 GitHub 直连被限速到 ~1MB/2min，镜像几秒 124MiB）
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 3) 快速本地验：不起打包，直接在壳里跑（加载 dist + 拉起两桥）
pnpm --filter @shadowroom/desktop start

# 4) 出未签名 .app（秒级，不碰证书，用于真机自测）
pnpm --filter @shadowroom/desktop exec electron-builder --dir

# 5) 出 dmg + zip（mac 公证双格式：dmg 装机、zip 给 electron-updater 用）
pnpm --filter @shadowroom/desktop exec electron-builder --mac dmg zip
```

签名 + 公证要的环境变量（第 5 步加上才生效；没有就走 ad-hoc 未签名路径）：

```sh
export CSC_LINK=~/certs/DeveloperIDApplication.p12   # Developer ID Application 证书
export CSC_KEY_PASSWORD=...
export APPLE_ID=...           # 三选一（推荐 App Store Connect API key，不受 2FA 卡壳）
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
# 或：
export APPLE_API_KEY=AuthKey_XXXX.p8
export APPLE_API_KEY_ID=...
export APPLE_API_ISSUER=...
```

`electron-builder.yml` 骨架（mac 公证 + win nsis 都在一份里）：

```yaml
appId: cn.shadowroom.producer-tools
productName: ShadowRoom
directories: { output: release }        # 产物 release/mac-arm64/…、release/*.dmg
files: [ "main.mjs", "package.json" ]
extraResources:
  - from: ../web/dist                   # vite 产物随包（另一份拷进 app://伺服根）
    to: web-dist
  - from: ../../tools                   # 两个桥
    to: tools
  # 插件源码与 python-runtime 的打包清单见 2.3，第一刀可暂缺（见第 5 节）
mac:
  target: [{ target: dmg }, { target: zip }]
  category: public.app-category.music
  hardenedRuntime: true                 # 公证硬性要求
  entitlements: build/entitlements.plist
  notarize: true                        # electron-builder 内置走 @electron/notarize
win:
  target: [nsis]                        # 差分更新可用；msi 可加但更新器不吃 msi
nsis: { oneClick: false, allowToChangeInstallationDirectory: true }
publish: { provider: github, owner: shadowroommusic, repo: producer-tools }
```

### 3.2 Windows（本机是 mac，出 win 包 = 交叉打包）

Electron 应用**没有原生 node 模块**（我们的 native 世界全在 Python/ffmpeg，不在 node-gyp），
所以 mac 上交叉出 Windows 包可行：`electron-builder --win nsis`（自动下 win32-x64 Electron 158.2MB）。
Python 侧资产（pbs win zip + win wheels）要在 CI 或本机提前备好塞进 extraResources。
真验证必须落在真 Windows 机器上（虚拟机或实体机），首启路径/杀毒软件/路径分隔符只有实测才算数。

### 3.3 GitHub Actions

```yaml
# .github/workflows/desktop-release.yml（producer-tools 仓库）
name: desktop-release
on:
  push: { tags: ["desktop-v*"] }
  workflow_dispatch:
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: macos-15,  platform: mac-arm64 }   # macos-15=arm64；macos-latest 已是 macOS 26 arm64
                                                     # 要 Intel mac 就加 macos-26-intel / macos-15-intel
          - { os: windows-2025, platform: win-x64 }  # windows-latest 现指 Server 2025 (x64, VS2026)
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.19.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
        env: { ELECTRON_MIRROR: https://npmmirror.com/mirrors/electron/ }   # runner 在海外可不设
      - run: pnpm --filter @shadowroom/web build
      - run: pnpm --filter @shadowroom/desktop exec electron-builder --publish never
        env:
          CSC_LINK: ${{ secrets.MAC CSC base64 }}          # 仅 mac 需要
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}      # 公证（App Store Connect API key）
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}            # publish 用
      - uses: actions/upload-artifact@v4
        with: { name: shadowroom-${{ matrix.platform }}, path: apps/desktop/release/*.{dmg,zip,exe,blockmap} }
```

runner 镜像现状（actions/runner-images README，2026-09 查）：`macos-latest` = **macOS 26 arm64**、
`macos-15` = arm64、Intel 用 `macos-26-intel`；`windows-latest` = **Server 2025 x64**。
公证在 runner 上跑没问题（notarytool 等 Apple 服务器，通常 2–10 分钟）。
mac 与 win 各自产出后由一个 `release` job 汇总 `gh release upload`（draft 先行）。

### 3.4 更新通道

- `electron-updater` 6.8.9 + GitHub Releases provider：dmg/zip/exe + `.blockmap` 差分下载，
  大包只下差异块。私有仓库需要带 `GH_TOKEN`（或改用 generic provider 指向自己的静态服务器）——
  发布通道公开与否是产品决策，见风险表。
- Grabber `updater.py` 的口径（固定仓库、sha256+大小双校验、API 限流退回 releases/latest 页）
  在这里复用其**原则**：electron-updater 本身校验签名（mac 签名 app 强制）+ blockmap 哈希；
  额外资产（重依赖包、codex 包）沿用 updater.py 的双校验思想自己下载。
- **macOS 上 electron-updater 只更新已签名+公证的 app**——所以"先发未签名内测版"阶段，
  自动更新在 mac 上不可用（手动下载新 dmg），Windows 未签名也能差分更新。这不是缺陷，是分期。

---

## 4. 风险清单

| # | 风险 | 影响 | 缓解 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | **公证三件套没着落**：Apple Developer Program（$99/年）、Developer ID Application 证书、App Store Connect API key | 没有 = 用户首启右键打开/系统设置放行，且 mac 自动更新不可用 | 尽早申请证书（1–2 天审批）；开发期先 `--dir` 未签名自测；`notarize: true` 配好即全自动 | notarytool 为现行唯一路径（altool 2023 起退役）；公证要求 hardened runtime + 全部嵌套二进制都签名（含 python 的 .so/.dylib——electron-builder 会递归重签） |
| 2 | **Windows 不签名**（明示可先不签） | SmartScreen "未知发布者" 蓝框；企业环境可能直接拦 | 安装页给一行"更多信息→仍要运行"指引；后续买 EV/OV 代码签名证书（EV 立刻消 SmartScreen，OV 需信誉积累） | — |
| 3 | **包体积预算** | 决定下载弃用率 | 见下表；重依赖不进主包已把 Windows 主包压到 ~330MB 级 | 全部实测/实查数字 |
| 4 | **首启体验**（重依赖下载） | 断网/限速（本机实测 GitHub 直连 ~1MB/2min）导致分轨首次使用失败 | 下载走我们 Releases 资产 + 国内可加镜像 URL 备选；失败保留 `STEM_SPLIT_COMMAND` 退路；下载器要有断点续传与 sha256 校验 | Grabber updater 同款问题已解过（`1cf8f03`） |
| 5 | **更新通道公开 vs 私有** | 私有 = 每个用户要 token，不现实；公开 = 代码可见 | 产品决策：主程序仓库公开（AGPL-3.0 反正要开源），或 generic provider 自托管静态服务器；重依赖资产无所谓 | 9 仓已全部公开发布（STATUS 2026-09-22） |
| 6 | **插件崩溃隔离** | 一个 Python 插件死不能拖死 app | 现状即满足：每插件独立子进程、桥有 error 标记/重启；Electron 侧只需把 server 状态（`/api/servers` 已有 `status` 字段）在 UI surfaced | `mcp-bridge.mjs` McpServer 生命周期；实测 9/9 ready 的同一条链 |
| 7 | **soundfont 插件的 fluidsynth 原生库**（Windows） | mac 版 42M venv 是 conda-forge 的 dylib；Windows 要 fluidsynth.dll | conda-forge 有 win64 包可提取 DLL，或用 FluidSynth 官方 win64 构建放 extraResources + PATH；**待 Windows 真机验证**（未实测，不猜） | mac 侧现状 42M 实测 |
| 8 | **Electron 44 最低系统版本未书面确认** | 太老的 macOS/Windows 装不上或起不来 | **已实测（2026-09-25 第一刀）**：`plutil` 读出 `LSMinimumSystemVersion = 13.0`（macOS Ventura 起）；宣传口径按 **macOS 13+**。Windows 侧 Electron 22 起不再支持 Win7/8（官方文档确认），44 只面向 Win10+ x64 | 本机 `release/mac-arm64/ShadowRoom.app/Contents/Info.plist` 实读 |
| 9 | **端口冲突**（开发机常驻 8787/8788） | 桌面包和 dev 实例互踩 | 主进程用 `SHADOWROOM_BRIDGE_PORT`/`SHADOWROOM_AGENT_PORT` 设高位端口（机制现成）；renderer 走 app:// 相对路径无感 | 桥源码 + 本机实测（18787 成功起过全套） |
| 10 | **杀毒软件误报**（未签名的 python.exe + 脚本子进程，Windows 高发） | 装完起不来 | 短期：文档 FAQ + 用户加白；长期：签名（与 #2 同解） | 经验项，未实测，标注为预期风险 |
| 11 | **TCC「文件与文件夹」弹窗**（第一刀实测，2026-09-25）：插件住在 `~/Documents/ShadowRoom`，双击/`open` 起的 app 读文稿文件夹要过 TCC；弹窗没人点时 python 全部**阻塞在 `open()` 系统调用**（采样栈：`PyFile_OpenCodeObject → open`，CPU 0%），30 秒握手超时 → 9 插件全 error。终端/IDE 拉起的进程继承终端授权，不弹不卡 | 双击首启时 app 像卡死（插件 error），用户点一次「允许」后永久记住 | ① 已加 `NSDocumentsFolderUsageDescription`（弹窗文案）；② 验收/自动化先从终端直启二进制绕开；③ 根治在第二刀：python+插件随包走、运行时数据进 userData，不再碰 ~/Documents | 本机实测：`open` 起 → 9 error + 阻塞栈；同二进制终端起 → 9/9 ready 78 工具 |

体积预算表（压缩口径，mac arm64 / win x64）：

| 项 | mac | win | 来源 |
| --- | --- | --- | --- |
| Electron 44.4.5 | 130.4MB | 158.2MB | GitHub Releases API |
| vite dist | 1.4MB | 1.4MB | 本机实测 |
| pbs cpython 3.13.15 | 25.3MB | 47.5MB（stripped 22.0MB） | GitHub API |
| 核心 env（numpy 系 wheels + pyrekordbox/yt-dlp 等，按现 venv 佔比估压缩后 ~40–60MB） | ~50MB | ~60MB | venv 实测（8.9+8.9+32+42M 未压缩）折算 + 保守 |
| ffmpeg 静态 | ~21MB | 待测（imageio-ffmpeg win wheel） | mac 实测 21.1MB |
| **主包合计（不含重依赖/codex）** | **≈230–260MB** | **≈290–330MB** | 上表相加 |
| 重依赖（torch+demucs+htdemucs，首用下载） | ~140MB | ~280MB | PyPI wheel 实查 + 模型实测 |
| codex（首用下载或检测） | 212MB | 待测 | 本机二进制实测 |

---

## 5. 第一刀（最小可验证的一步）

**范围**：`apps/desktop/` 新增三个文件（`package.json` / `main.mjs` / `electron-builder.yml`），
不碰 `apps/web`、不碰根 `package.json`。插件在第一刀**继续用本机已有的 venv 与系统 python**
（`SHADOWROOM_HOME` 默认就是 `~/Documents/ShadowRoom`，桥什么都不用改）——先把"壳 + 前端 + 桥 +
插件"这条链在 .app 里跑通，Python 装箱（第 2 节）是第二刀。

> **执行记录（2026-09-25，ZCode）**：第一刀已落地并完成验收 ③⑤⑥⑦（9/9 ready · 78 工具；
> 端口 18787/18788 与 dev 5173/8787/8788 并存；⌘Q 与 SIGKILL 主进程两条退出路径均 0 残留；
> LSMinimumSystemVersion=13.0）。相对本节初稿的四处实测修正：① 工具数基准 68→**78**
> （library 二期后端 17→27）；② main.mjs 的桥拉起方式改为 **stdin 守护壳**（原版对主进程
> `kill -TERM` 会漏进程，见 §5.1 注）；③ package.json 需要补 `version`/`author`/`description`
> 与 `pnpm.onlyBuiltDependencies:["electron"]`（pnpm 11 默认拦 electron 的 postinstall）；
> ④ Info.plist 加 `NSDocumentsFolderUsageDescription`（TCC 弹窗文案，见风险 #11）。
> 新发现已入风险清单 #11：**双击/`open` 首启会弹文稿文件夹权限窗**，未批准前 python 全部
> 阻塞在 `open()`、插件 30 秒超时全 error；终端直启二进制不触发。窗口/协议/Studio 三项
> （验收 1/2/4）由 Codex 复验。

### 5.1 文件内容（main.mjs 已随第一刀落地仓库并真机复验：拉起两桥 + 9 插件 + codex、
GET/POST 代理、⌘Q/SIGKILL 两条退出路径干净；以下代码与 `apps/desktop/main.mjs` 同步）

`apps/desktop/package.json`：

```json
{
  "name": "@shadowroom/desktop",
  "private": true,
  "main": "main.mjs",
  "scripts": {
    "start": "electron .",
    "dist:dir": "electron-builder --dir",
    "dist:mac": "electron-builder --mac dmg zip"
  },
  "devDependencies": {
    "electron": "44.4.5",
    "electron-builder": "26.15.3"
  }
}
```

`apps/desktop/main.mjs`：

```js
// 桌面壳：伺服 web dist + 拉起两个桥。桥不改一行——全部通过环境变量旋钮接入。
import { app, protocol, net, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { homedir } from "node:os";

const DEV = !app.isPackaged;
// 开发机 8787/8788 常被 dev 实例占用，桌面包用高位端口；renderer 只见 app:// 相对路径。
const MCP_PORT = "18787";
const AGENT_PORT = "18788";

const DIST = DEV
  ? join(import.meta.dirname, "../web/dist")             // 仓库内：vite build 产物
  : join(process.resourcesPath, "web-dist");             // 打包后 extraResources
const TOOLS = DEV ? join(import.meta.dirname, "../../tools") : join(process.resourcesPath, "tools");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".wav": "audio/wav", ".mp3": "audio/mpeg" };

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 用 Electron 自己的内置 node 跑桥（本机实测 node v24.21.0，9/9 插件 ready），
// 这样包里不用再塞一个 node 运行时。
function bridgeEnv(extra) {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1",
    SHADOWROOM_BRIDGE_PORT: MCP_PORT, SHADOWROOM_AGENT_PORT: AGENT_PORT, ...extra };
}
const children = [];
// 桥的守护壳：主进程怎么死都必须带走桥。实测（2026-09-25）：osascript quit / ⌘Q 走
// before-quit 干净退出，但对主进程直接 kill -TERM 不经过 JS 退出钩子，漏过一个
// mcp-bridge（AGENTS.md 资源泄漏军规）。所以除了钩子，再加一条**不依赖主进程**的通道：
// 守护壳的 stdin 接的是主进程的管道，主进程一消失（含 SIGKILL）管道即 EOF，守卫
// SIGTERM 桥、3 秒后 SIGKILL 兜底（兜底也覆盖瘫在不可中断阻塞里的 python 插件）。
// 桥自身的 SIGTERM 处理器（mcp-bridge.mjs 的 #kill）会带走它的 python 子进程。
const GUARD = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [process.argv[1]], { stdio: ["ignore", "inherit", "inherit"] });
  const die = () => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); };
  process.stdin.resume();
  process.stdin.on("end", die);
  process.on("SIGTERM", die);
  child.on("exit", (c) => process.exit(c ?? 0));
`;
function startBridge(script) {
  const child = spawn(process.execPath, ["-e", GUARD, join(TOOLS, script)],
    { env: bridgeEnv({}), stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (d) => console.log(`[${script}] ${d}`.trim()));
  child.stderr.on("data", (d) => console.error(`[${script}] ${d}`.trim()));
  children.push(child);
  return child;
}

// 所有退出路径都要停子进程（AGENTS.md 资源泄漏军规）：正常退出、窗口全关、崩溃。
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.quit());
app.on("before-quit", () => { for (const c of children) c.kill(); });
app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  // 转发必须按 fetch 的 (url, init) 口径拆开传；带 body 时还要 duplex:"half"，
  // 否则 RequestInit 直接抛 TypeError（真机窗口里前端第一个 POST 就踩到，GET-only 冒烟测不出）。
  const proxyInit = (request) => {
    const init = { method: request.method, headers: request.headers };
    if (request.body) { init.body = request.body; init.duplex = "half"; }
    return init;
  };
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    // 顺序敏感：/api/agent 必须在 /api 之前判（实测两桥 200）。
    if (path.startsWith("/api/agent"))
      return net.fetch(`http://127.0.0.1:${AGENT_PORT}${path}${url.search}`, proxyInit(request));
    if (path.startsWith("/api"))
      return net.fetch(`http://127.0.0.1:${MCP_PORT}${path}${url.search}`, proxyInit(request));
    let rel = normalize(path).replace(/^([/\\.])+/, "");
    if (rel === "") rel = "index.html";
    const file = join(DIST, rel);
    if (!file.startsWith(DIST) || !existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(file),
      { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
  });

  startBridge("mcp-bridge.mjs");
  startBridge("agent-bridge.mjs");

  const win = new BrowserWindow({ width: 1600, height: 1000, title: "ShadowRoom" });
  win.loadURL("app://sr/index.html");
});
```

`apps/desktop/electron-builder.yml`：用第 3.1 节骨架即可（第一刀把 `notarize: true` 改 `false`、
`win/nsis/publish` 三段先删）。

### 5.2 执行步骤

```sh
export PATH="/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
cd ~/Documents/ShadowRoom/producer-tools
corepack enable pnpm
pnpm --filter @shadowroom/web build                      # dist 1.4MB
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" pnpm install
pnpm --filter @shadowroom/desktop start                  # 开发态先看一眼
pnpm --filter @shadowroom/desktop exec electron-builder --dir   # 出 release/mac-arm64/ShadowRoom.app
open release/mac-arm64/ShadowRoom.app                    # 双击路径
```

### 5.3 验收标准（逐条可执行，全过才算数）

1. **能起**：`open release/mac-arm64/ShadowRoom.app` 后 ≤5 秒出窗口，标题 `ShadowRoom`，
   地址栏协议为 `app://`（devtools 里 `location.protocol === "app:"`）。
2. **前端是 build 产物**：devtools console 里 `document.querySelector('script[type=module]').src`
   指向 `/assets/index-*.js`（哈希名，证明吃的是 dist 不是 dev server）。
3. **9 插件全通**：devtools console：
   `fetch("/api/servers").then(r=>r.json()).then(d=>console.log(d.servers.map(s=>s.id+":"+s.status)))`
   → 9 个 id 全 `ready`。**工具数基准 78（2026-09-25 实测：7+8+3+15+4+3+4+27+7）**；
   早前写的 68（library=17）是曲目库二期后端落地前的旧数，library 现在 27 个工具。
4. **Studio 可用**：侧栏进 Studio，时间线渲染、建一条鼓轨双击进卷帘（用浏览器验收同款操作），
   截图留档。
5. **端口不踩 dev**：app 跑着的同时 dev 实例照常工作（app 用 18787/18788）。
6. **退出干净**：⌘Q 后 `ps aux | grep -E "mcp-bridge|agent-bridge|Electron" | grep -v grep` 为 0 行
   （AGENTS.md 资源泄漏军规）。
7. **系统门槛读数**：`plutil -p release/mac-arm64/ShadowRoom.app/Contents/Info.plist |
   grep LSMinimumSystemVersion` → 把读到的版本写回本文档第 4 节 #8。

已知豁免：agent 桥依赖 `SHADOWROOM_CODEX`（默认找 ChatGPT.app）；本机有，所以第一刀可用。
没有 codex 的机器上对话功能降级但不影响 1–7 验收（2.4 是后续项）。

---

## 6. 第二刀方案（TCC 根治 + Python 装箱 + 出包签名）——**待评审，未动任何码**

日期：2026-09-26 ｜ 作者：ZCode（GLM-5.3）｜ 前置：第一刀已验收（§5 执行记录 + Codex 复验 1/2/4 全过）

目标：① 双击首启零 TCC 弹窗、插件即开即用；② 换一台干净机器（无 venv / 无 Xcode python /
无 ~/Documents/ShadowRoom）装上就能跑；③ 一条命令出 dmg+zip，证书到位后签名公证全自动进 CI。

**先纠三处本档旧账**（2026-09-26 实测，§2.1 的假设有错，第二刀按实测走）：

| # | 旧假设（§2.1） | 实测真相 | 对方案的影响 |
| --- | --- | --- | --- |
| 1 | analysis / generator 是"轻量 numpy 档"（各自 8.9M venv） | 两仓 venv 是**空壳**：`bin/python` 软链进 `stem-splitter` venv，实际一直骑在 381M torch 环境上跑（numpy 1.26.4） | 装箱后它们要有自己的 numpy，不能指望"已经很轻" |
| 2 | 核心 8 插件"建一个共享 env"（§2.3） | 现机器同时存在 **三个 numpy**：splitter/analysis/generator 1.26.4、系统面 2.0.2（用户 site）、soundfont 2.5.3。共享单 env 必然动某家的版本 | 分档 env：core + soundfont + splitter 三个，机制上仍是 `_venvs/<repo>` 布局，只是分组物化 |
| 3 | converter / library "系统 py / 单文件，基本零依赖" | 真依赖装在用户 site（`~/Library/Python/3.9/...`）：pyrekordbox 0.4.4（连带 sqlalchemy、construct、dateutil）、mutagen、Pillow、send2trash、psutil；scipy 1.13.1 也在但**没有任何仓库声明它**（残留，不装箱） | core env 的 manifest 以**各仓 pyproject 声明 + 实测冻结双核对**，两者都在下面列表里 |

### 6.1 TCC 根治：插件与数据的新家

**新家 = `app.getPath("userData")` = `~/Library/Application Support/ShadowRoom`**（mac 上无 TCC 保护，
非沙盒 app 直接读写，弹窗问题从根上消失）。布局（沿用桥现有的 `SHADOWROOM_HOME` 约定，**桥零改动**）：

```
~/Library/Application Support/ShadowRoom/          ← 打包态 SHADOWROOM_HOME（main.mjs 设置）
├─ <9 个插件仓目录>/mcp_server.py + src/           ← 每次启动从 Resources/plugins/<repo> 同步
│                                                     （stamp=git rev，几 MB 秒级；只增不删用户文件）
├─ _library/  recordings/  exports/  _soundfonts/  ← 用户数据（迁移，见下）
├─ _venvs/
│   ├─ .core/                       ← 共享 core env（真目录）
│   ├─ converter → .core 等软链 ×7   ← pythonFor() 找 _venvs/<repo>/bin/python，软链即命中，桥无感
│   ├─ soundfont-renderer/          ← 独立 env（numpy 2.5.3，不与 core 混）
│   └─ stem-splitter/               ← 重 env，首用下载后落地
├─ bin/ffmpeg  bin/fpcalc           ← 从 Resources/bin 物化为真文件（现 bin/ffmpeg 是指向用户 site 的
│                                       机器特定软链，实测；装箱后不再依赖它）
└─ .migrated.json  ENV_STAMP  .source-stamps     ← 迁移标记 / env 版本戳 / 源码版本戳

ShadowRoom.app/Contents/Resources/   ← 随包只读
├─ python-runtime/     （python-build-standalone cpython 3.12.x，§2.2 已实测可搬迁）
├─ wheels/core/  wheels/soundfont/   （wheel 原文件，首启离线建 env 用）
├─ plugins/<9 repo>/   （源码快照，共 ~4.2MB 实测）
└─ bin/ffmpeg(21.1MB 实测)  bin/fpcalc(2.6MB 实测)
```

**与现在 SHADOWROOM_HOME 的关系**：桥的默认值仍是 `~/Documents/ShadowRoom`——dev 工作流
（`pnpm serve` / `pnpm serve:agent`）一个字都不用改。只有打包态 main.mjs 把 HOME 指到 userData。
设置页加一个「数据目录」覆写（写配置 + 重启生效），高级用户/开发者可指回
`~/Documents/ShadowRoom`（该路径会弹 TCC，属预期，文案写明；同时警告 dev 实例与桌面 app
**数据分叉**——两份 library.db 会各自演化）。

**打包态插件解释器解析链**：就是桥现有的 `pythonFor()` fallback 链
（`SHADOWROOM_PYTHON_<ID>` env → `_venvs/<repo>/bin/python` → `<repo>/.venv` → PATH 的 python3）。
第二刀只往 `_venvs/<repo>` 放东西：core 七件套用软链指向 `.core`，soundfont / splitter 各占真目录。
`SHADOWROOM_PYTHON_<ID>` 保留为逃生舱（比如某插件要单独换版本）。

**老用户数据迁移**（首启向导，三选一）：

- 触发：检测 `~/Documents/ShadowRoom` 存在 且 新家是 virgin 且 无 `.migrated.json` → 弹选择：
  **(a) 迁移（默认推荐）**、(b) 全新开始、(c) 继续用旧工作区（高级，见上）。
- 迁移清单（体积 2026-09-26 实测落地版）：`_library/` 0.4M（208 件）、`recordings/` 457.6M（240 件）、
  `exports/` 107.6M（110 件）、`_soundfonts/` 29.8M、`_steward/` 0.1M、`stems/` 139.5M（25 件）、
  `_stems-cache/` 242.3M（28 件）、`stem-splitter-jobs/`（9 件）、`imports/` 69.3M（29 件）
  —— 合计 **651 件 / 1046.7MB**（初稿只列了四样，_steward/stems/_stems-cache/jobs/imports 是
  落地盘点补上的；**封闭清单**，绝不整体拷贝——旧家里有 github-recovery-codes.txt、AGENTS.md、
  _bus/_backups 这类工作区文件）。
- **venv 过渡策略（第 1 步实测落地）**：方案原写"不迁移、按新 runtime 重建"是第 2 步到位后的形态；
  第 1 步不搬 venv 插件就起不来，又**不能软链回旧家**（软链解析后的真实路径仍在 ~/Documents 下，
  open 起的进程读它会再次踩 TCC）。所以整目录 clonefile 复制（实测 5 个 venv + bin 共 706M、秒级），
  跳过 `mamba-root`（336M 无引用遗留），并把指向旧家的绝对软链改写到新家（实测改写 2 条：
  audio-analysis/generator 的 bin/python；比较前须 realpath 归一——`cp -c -R` 会把软链目标存成
  `/private/tmp/...` 形式，字面前缀比对会漏）。Xcode python / 用户 site 的外部绝对链保持原样
  （不在 ~/Documents 下，TCC 不拦）。
- 实现：APFS 同卷用 **clonefile 拷贝**（`cp -c -R`，实测 1.05GB 数据 + 706M venv 共 **6 秒**）；
  拷贝前 `statfs` 预检剩余空间（需 ≥ 迁移量 ×1.05），不足则引导改选 (b)/(c)；
  逐目录 console 进度 + 完成弹窗汇总。
- 标记与幂等：成功后写 `.migrated.json`（源路径、日期、各目录文件数/字节数）；二次启动不再触发。
- **失败回退**：拷贝是**复制不是移动**——旧家永远完好，这就是回退底座。中途失败（进程被杀/磁盘满）：
  删新家半成品数据目录、不写标记、报错可重试；最坏情况 app 以全新数据跑，旧数据原样在 Documents。
  实测注：kill -9 主进程后，正在跑的 `cp` 子进程会自己跑完才退（spawnSync 子进程不随父死）——
  无害，重试语义本来就是"先清半成品再拷"。

**验收 6.1（每条可执行）**：

1. **干净新账号**（本机新建 macOS 用户：无 `~/Documents/ShadowRoom`、无 venv、无 Xcode）双击 app
   → 首启 env 构建（离线）→ `/api/servers` **8/8 ready、工具合计 74**，全程 ≤90s，零 TCC 弹窗。
2. **迁移正确性**：预置 fixture（library.db 已知行数 + recordings 10 个已知 md5 文件）→ 选 (a) →
   userData 内 db 行数相等、文件数相等、抽 3 个文件 md5 一致；**旧家逐字节复核未动**；重启不再弹向导。
3. **中断回退**：迁移到 ~50% 时 kill 迁移进程 → 旧家完好、新家无 `.migrated.json`、重启可重试且成功。
4. **(c) 模式**：设置数据目录指回 Documents → 重启后桥日志 HOME=旧家、正常 ready（弹一次 TCC 属预期）。
5. 全程（默认路径）`open` 起的 app 内插件 ready——首刀的失败签名是「open 起 → 9 error + python 阻塞
   在 open()」，反向即证 TCC 已根除。

> **执行记录（2026-09-26，ZCode，第 1 步已落地）**：`apps/desktop/{home.mjs(新), main.mjs, electron-builder.yml,
> package.json}`，验收 **2/3/4/5 本机全过、1 留给干净账号复验**（见下）。实测数字：
> **②** fixture 54 件 → db 行数 7==7、九目录件数逐一相等、3 文件 md5 一致、旧家树 md5 前后一致
> （`22491a2a…`）、重启零向导行（log 直接 `plugins from <userData>`）；**③** 3030 件 fixture 在 1693 件时
> kill -9 → 标记未写、旧家 md5 不变、重试后 3030/3030 + 标记落盘；**④** (c) 写 `shadowroom-config.json`
> + 重启 `config-override` 生效（桥 plugins from=旧家）、**覆写模式禁源码同步**（fixture 抓到 sync 会
> rm 用户 git 检出的雷，已修 + 复验旧家 md5 不变）；**⑤** 真迁移（651 件/1046.7MB + 5 venv 706M，
> **6 秒**）后 `open` 起的 app **9/9 ready、78 工具**，python 全部从
> `~/Library/Application Support/ShadowRoom/_venvs/` 起——首刀失败签名消失；⌘Q 退出 0 进程 0 孤儿。
> 关于验收 1：第 1 步没带 python 装箱（§6.4 第 2 步），干净账号上预期是"app 正常起、向导可走、
> 插件 error（无 venv）、零 TCC 弹窗"；**8/8 ready ≤90s 要等第 2 步**。本机等价证据 = ⑤。
> 落地时踩的坑（都进了代码注释/本档）：package.json 必须加 `productName:"ShadowRoom"`，否则
> userData 变成 `…/@shadowroom/desktop`；`files` 必须含 home.mjs；electron-builder 必须用
> `pnpm run dist:dir` 跑（直调 .bin 时无 `npm_config_user_agent`，collector 兜底识别成 npm→ENOENT）；
> 测试缝 `SHADOWROOM_LEGACY_HOME` + `SHADOWROOM_MIGRATE_CHOICE=a|b|c`（后者同时让向导弹窗静默，
> 否则 showMessageBoxSync 卡死自动化）。

### 6.2 Python 运行时与 9 插件装箱

**运行时：单一 pbs cpython 3.12.x**（tag 实现时锁定，§2.2 已实测这族可搬迁、venv 可建）。选型依据：
soundfont 现役就是 3.12（numpy 2.5.3 要求 ≥3.11）；torch 2.2.2 有 cp312 mac arm64 wheel（**实测存在，
59,678,388 字节**）；不能用 3.13（torch 2.2.2 无 cp313，升 torch 是另一个项目，不猜）；不必用 3.9
（soundfont 的 numpy 2.5.3 装不上）。

**分档**（依赖清单 = 各仓 pyproject 声明 ∩ 实测冻结集；标〔实测〕的是本机现役版本）：

| 档 | 插件（工具数） | env | 依赖冻结集 | wheel 体积 | 进包方式 |
| --- | --- | --- | --- | --- | --- |
| core | converter(7) analysis(8) planner(3) generator(15) steward(4) library(27) grabber(7) | `.core`（软链 ×7） | numpy 1.26.4〔实测〕、mutagen 1.47.0〔实测〕、Pillow 11.x、send2trash 2.1.0、pyrekordbox 0.4.4〔实测〕（连带 sqlalchemy/construct/dateutil/packaging）、yt-dlp 2025.10.14〔实测〕、pycryptodome 3.23.0〔实测〕 | ≈30–40MB〔估，实现时按实际 wheel 相加〕 | **随包**（Resources/wheels/core） |
| soundfont | soundfont(3) | `soundfont-renderer` | numpy 2.5.3〔实测〕、pyfluidsynth 1.4.0〔实测〕、**fluidsynth dylib 闭包**（现 venv lib/ 是 42M 的 conda 系全量 dylib〔实测〕；实现时 `otool -L` 递归闭包压缩，预期 ≤15M〔估〕） | wheels ~15M + dylib 闭包 ≤20M | 闭包 ≤20M 则**随包**；超了就改首用下载 |
| splitter | splitter(4) | `stem-splitter` | demucs 4.0.1 全树〔实测 30 包 freeze：torch 2.2.2 + torchaudio + numpy 1.26.4 + soundfile/lameenc/julius/omegaconf/…〕 + htdemucs 权重 80MB〔实测〕 | wheels ≈80MB（torch cp312 arm64 56.9MB 实测 + 树 ~20MB 估） + 模型 80MB | **首用下载 ~160MB**（我们 Releases 资产 + 镜像 URL 备选 + sha256+大小双校验〔Grabber updater 口径〕 + 断点续传 + 进度 UI + 失败退 `STEM_SPLIT_COMMAND`） |

**env 物化**：首启（或 `ENV_STAMP`{python build id + wheels 清单 hash} 变更时，即 app 升级）
`python-runtime/bin/python -m venv _venvs/<env>` → `pip install --no-index --find-links=Resources/wheels/<env>/`
——**全程离线**，不需要网。预估耗时 30–60s（〔估〕验收上限 90s），配进度 UI。

**预装 vs 首启下载**：core+soundfont 选预装——代价是包体积 +50–90MB，换来"装完即用、断网可用"；
splitter 选首用——160MB 不是人人要分轨，且 torch win 版 198.5MB（§2 已实测）会把 Windows 包顶爆。

**"最小可用集是不是轻五件"**：不必。轻五（analysis/generator/library/steward/planner = 57 工具）够
Studio/DJ/曲库基础，但 converter+grabber（+14 工具）是曲库导入链（rekordbox 转换 / 在线下载）的核心，
而它们的 wheel 增量只有 ~8MB；真正贵的只有 soundfont（dylib）和 splitter（torch）。
**建议主包带 8 插件 74 工具**，工具数阶梯：57（轻五）→ 71（+converter+grabber）→ 74（+soundfont）→
78（+splitter 首用后）。UI 对未装的 splitter 显示「未安装 · 点击安装分轨组件」。

**版本迁移风险与 gate**：core 统一 numpy 1.26.4（analysis/generator 现役版本〔实测〕；library 声明
numpy 但 src 无 import〔实测 grep〕）；8 个插件从 python 3.9 换到 3.12。**gate = 9 仓单测在 3.12 全绿
+ 每插件 1 条真机工具调用冒烟**（分轨 6s 片段 / 生成 1 小节 / 导入 1 曲 / sf2 渲染 / cue 转换……），
不过就分 env 降级（机制支持任意分法）。

**验收 6.2**：

1. 断网全新首启：core env 离线建成，**8/8 ready、74 工具、≤90s**；
2. 包体积：unpacked .app ≤ **450MB**（现 289M + pbs ~70M〔§2.2 实测解包〕+ wheels ~40M + 源 4.2M +
   bin 24M ≈ 427M〔构成表随实测填〕）；dmg 产物 ≤ **220MB**〔估，实测为准〕；
3. splitter 首用：下载→env→**78 工具**；断网中断后重连续传成功；预置 sha256 不符的坏资产被拒；
4. 9 仓单测在 pbs 3.12 下全绿（各自通过数实现时填入）；冒烟 5 条全过；
5. app 升级（wheels stamp 变化）：首启自动重建 env，用户数据不动（db 行数不变）。

> **执行记录（2026-09-26，ZCode，第 2 步已落地；实现由 Codex 代存于 wip `ec23348`，收尾 commit 见总线）**：
> 落地 = `wheels-core.json`（pins 9 条，实测从 7 补到 9：grabber 的 `requests`/`imageio-ffmpeg` 是
> 声明依赖但旧 venv 从未装过的子集，单测逼出）+ `scripts/fetch-runtime.mjs`（构建期抓取：
> pbs 走 npmmirror 24MB、wheels 走 PyPI 直连〔实测 15MB/1.2s，无需镜像〕，幂等 stamp）+
> `env.mjs`（首启**离线**建 `_venvs/.core`：venv + `pip --no-index` + 七件套软链；`ENV_STAMP` =
> runtime build-id + wheels 集合 hash，变更自动重建、healthy 探针自愈——.app 被挪动导致解释器
> 路径失效的场景也覆盖）+ yml extraResources + main.mjs 接线（建 env 先于源码同步）。
> 实测数字：**pbs cpython 3.12.14+20260924**（解包 75M）+ **22 wheels 50M**（imageio-ffmpeg 内置
> ffmpeg 占 ~26M）；.core 构建 **4.4–4.8s**；stamp 幂等命中 ~150ms。
> **① 干净模拟**（mv 走整个 _venvs + `open`）：**7 秒**就绪 **8/9 ready / 75 工具**——优于预估的
> 7/7/71：splitter 的 mcp_server 顶层不 import torch，桥的 pythonFor 兜底系统 python3 即可列工具
> （真正分轨才需要 torch，第 3 步首用下载补）；soundfont error 预期内（mcp_server 顶层 import
> fluidsynth）。全程零 TCC 弹窗。**② 单测**（.core 3.12，core 七仓）：audio **65 OK** / planner
> **48 OK** / library **74 OK** / steward 无 tests 目录；grabber **132 用例 8 挂**（3.9 基线 87 用例
> 22 挂——**零回归**，多解放 45 个用例；剩 8 个与基线逐条相同：tkinter GUI ×2、Windows 路径断言
> ×1、POSIX X_OK 假件 ×2、BitDepth 夹具 ×3）；converter **57 用例 2 挂** + generator **125 用例
> 4 挂** = **6 个 3.12 新失败，全部是测试前提绑定 3.9 行为**（修复都在插件仓测试里、各 1–2 行，
> 不在本步范围，见证据索引与回执）。**③ dmg/zip 对账**：`dist:mac` 出 dmg **200M** / zip **201M**
> （≤220MB 估达标）；.app = zip = dmg 三方 + resources-src 源头**四方全等**（22 whl 集合 md5
> `69f9d85a…` + runtime build-id 逐字节同）。**④ 退出**：⌘Q 0 进程 0 孤儿；**单实例锁**新增并实测
> （来由：与 Codex 并行复验的两个实例抢 18787/18788，后起实例两桥 EADDRINUSE 全崩、UI 变哑巴——
> 第二实例现在打印 quitting 即退、锁焦点交还）。
> 构建顺序注意：`node scripts/fetch-runtime.mjs` → `pnpm run dist:dir/dist:mac`（fetch 只写
> resources-src，**必须重打包** wheels 才进 .app；ENV_STAMP 重建吃的是包内 wheels）；打包后
> `git checkout -- pnpm-workspace.yaml pnpm-lock.yaml`（§5 老坑仍在）。

### 6.3 出包与签名

**不签名最小路径（今天就能跑，零用户输入）**：

```sh
export PATH="<codex node bin>:<fallback pnpm bin>:$PATH"
cd producer-tools/apps/web && node node_modules/vite/bin/vite.js build
cd ../desktop && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
  pnpm exec electron-builder --mac dmg zip --publish never
# 产物：release/ShadowRoom-<ver>-arm64.dmg + release/mac-arm64/ShadowRoom-<ver>-arm64-mac.zip(+.blockmap)
```

注意：打包后 `git checkout -- pnpm-workspace.yaml pnpm-lock.yaml`（electron-builder 的 pnpm list 会
污染根文件，第一刀实测踩过，见证据索引）。未签名分发的现实：别人下载 dmg 后需**右键→打开**一次
（Gatekeeper「未知开发者」）；从 dmg 里直接双击运行会被 Gatekeeper 随机化挂载——app 启动时检测自身
路径不在 /Applications 就引导「拖入应用程序文件夹」（一行检测，第二刀顺手做）。

**签名+公证需要用户提供的（一样都少不了）**：

| # | 要什么 | 怎么拿 | 进哪 |
| --- | --- | --- | --- |
| 1 | Apple Developer Program 会员（$99/年，审批 1–2 天） | developer.apple.com 注册 | — |
| 2 | Developer ID Application 证书 | 会员后在 Certificates 页用 Keychain CSR 签发，导出 `.p12` + 自设密码 | Secrets：`CSC_LINK`（p12 的 base64）、`CSC_KEY_PASSWORD` |
| 3 | 公证凭据（三选一，**推荐 a**） | (a) App Store Connect → 用户和访问 → 集成 → 新建**团队密钥 .p8**；(b) Apple ID + app 专用密码（appleid.apple.com → 登录与安全）；(c) 都不要 = 不公证 | a：`APPLE_API_KEY`（p8 base64）/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`；b：`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` |

配置侧恢复 §3.1 骨架：`hardenedRuntime: true` + `entitlements: build/entitlements.plist`（最小清单：
不禁 JIT、allow-unsigned-executable-memory 不开、com.apple.security.cs.allow-dyld-environment-variables
**不需要**——我们不用 DYLD 注入）+ `notarize: true` + `publish: github`。electron-builder 内置走
notarytool，证书+凭据齐了就全自动。

**CI 接法**（§3.3 workflow 的修订点，其余照旧）：

1. 触发：tag `desktop-v*`；
2. **多仓 checkout**：producer-tools + 9 个插件仓（按 tag 锁版本）——extraResources 的插件源码/
   wheels 打包脚本从这里取（打包脚本产出 wheels 清单 = 6.2 的冻结集）；
3. 根 `pnpm install --frozen-lockfile`（**第二刀反转第一刀的局部 lockfile 决策**：desktop 进根
   workspace，CI 一条 install 装全——第一刀隔离是为了不踩 Trae 并行改 web，属当时战术）；
4. build web → `electron-builder --mac dmg zip --publish always`（secrets 见上表 + `GH_TOKEN`）；
5. 产物：draft release 自动挂 dmg/zip/blockmap/latest.yml；公证 2–10 分钟。

**更新通道**：mac 自动更新（electron-updater + blockmap 差分）**只在签名+公证后可用**（§3.4）；
内测期手动下 dmg，Windows 未签名也能差分。此项不阻塞第二刀验收。

**验收 6.3**：

1. 未签名：上面三条命令出 dmg+zip 双产物；本机 `open` dmg 装的 app 跑 6.2 的 74 工具基线；
2. 签名后：`spctl -a -vv ShadowRoom.app` → `accepted, source=Notarized Developer ID`；
   `xcrun stapler validate` 通过；**新账号**下载 dmg 双击直开（免右键、免右键等待）；
3. CI：推 tag → draft release 自动含 dmg+zip+blockmap+latest.yml，全程零手工；
4. Windows nsis：CI 交叉出 exe 仅做产物存在性检查（真机验证另派——§4 #7 fluidsynth win dll 未解）。

### 6.4 实施顺序（每步独立可验收，可中途发内测）

1. **数据迁移 + TCC 根治**（不动 python：仍用本机 venv，只换 HOME）→ ✅ **已落地（2026-09-26，
   验收 2/3/4/5 全过 + 真迁移实测；1 的干净账号复验留待 Codex/用户，"8/8 ready"部分依赖第 2 步）**；
2. **core env 装箱**（pbs + wheels 随包，8 插件 74 工具）→ ✅ **已落地（2026-09-26；干净模拟 7s
   8/9 75 工具零 TCC、稳态 9/9 78、.core 4.4s 离线建成、单测零回归、dmg 200M 四方对账全等；
   6 个 3.12 新测试失败均为插件仓测试前提问题，修复建议已出）**；
3. **soundfont dylib 闭包**（≤20M 随包，否则首用）＋ **splitter 首用下载** → 6.2.3；
4. **dmg/zip 出包**（不签名）→ 6.3.1；——**到这里即可发内测 dmg**；
5. 签名+公证（等用户证书到位）→ 6.3.2；
6. CI 收编（多仓 checkout + secrets）→ 6.3.3。

---

## 证据索引（每个数字的出处；2026-09-25 / 09-26 实查实测，行内自带日期）

| 事实 | 出处 |
| --- | --- |
| electron 44.4.5 / electron-builder 26.15.3 / electron-updater 6.8.9 / @electron/notarize 3.1.1 / @openai/codex 0.157.0 | `registry.npmjs.org/<pkg>/latest` |
| Electron dist zip：darwin-arm64 130.4MB、win32-x64 158.2MB | GitHub API `repos/electron/electron/releases/tags/v44.4.5` |
| Electron.app 解包 296MB；内置 node v24.21.0 | 本机 `/tmp/sr-pack/` 下载解包 + `ELECTRON_RUN_AS_NODE=1 -e` |
| **ELECTRON_RUN_AS_NODE 跑 mcp-bridge → 9/9 ready、68 工具** | 本机实测（`SHADOWROOM_BRIDGE_PORT=18787`，`/api/servers` JSON） |
| **app:// 协议伺服 dist + /api 代理 7/7 GET 断言通过** | 本机实测（`/tmp/sr-pack/app/main.mjs`，含路径穿越 404、/api/agent 前缀路由） |
| **本文档 5.1 的 main.mjs 原样抽出真机跑通**：两桥由壳拉起（18787/18788 都 listening）、agent 桥连上 codex（cwd/sandbox 正常）、9 插件就绪、悬浮球 `steward.focus_change` 经 app://→桥→插件 全链 60ms 完成、POST 带 body 过代理返回 404（修掉 `duplex:"half"` 缺失后零 TypeError）、SIGTERM 退出零残留进程（⚠ 第一刀落地时发现该结论只覆盖了桥自身的 SIGTERM 路径；对**主进程**直发 SIGTERM 会漏，已用守护壳修复，见下两行） | 本机实测（`/tmp/sr-pack/doc-main-test3.log`，2026-09-25；残留进程为 0，日志里用户自己的 dev 实例不算） |
| **第一刀四项验收实测（2026-09-25）**：③ 9/9 ready、工具合计 **78**（converter 7 / analysis 8 / planner 3 / generator 15 / splitter 4 / soundfont 3 / steward 4 / library 27 / grabber 7；library 27 = 二期后端落地后的新基准）；⑤ app 用 18787/18788，同时 dev 实例 5173/8787/8788 照常 9/9 响应；⑥ ⌘Q（quit 事件）与 `kill -9` 主进程两条路径后 `pgrep ShadowRoom.app/Contents/MacOS` 均为 **0**、孤儿 python **0**；⑦ `LSMinimumSystemVersion = 13.0` | 本机实测（打包 app 终端直启，`/tmp/app-final.log`） |
| **SIGTERM 直杀主进程会漏进程**：electron 主进程被 `kill -TERM` 时 JS 的 SIGTERM handler 不一定执行（实测漏过一个 mcp-bridge → 其 python 成孤儿）；修复 = stdin 守护壳（主进程死则管道 EOF → 守卫 SIGTERM 桥、3 秒 SIGKILL 兜底），修复后 ⌘Q 与 SIGKILL 两路径 0 残留 | 本机实测（修复前后对照，2026-09-25） |
| **TCC 文稿权限阻塞**：`open`/双击起的未签名 app，python 插件全部阻塞在 `open()`（采样栈 `PyFile_OpenCodeObject → open`，CPU 0%），30s 握手超时 9 error；同二进制终端起（继承终端授权）9/9 ready | 本机实测（`sample` 三个卡死 python 的调用栈 + `env -i` 对照，2026-09-25） |
| 打包机工具链：fallback pnpm 11.19.0（`--ignore-workspace` 局部安装不动根 lockfile）；pnpm 11 默认拦 electron postinstall（需 `onlyBuiltDependencies:["electron"]`，或手动 `node install.js`）；electron-builder 要求 package.json 有 `version`；electron-builder 裸调 `pnpm`，需在 PATH。**副作用**：它调的 `pnpm list` 会从 apps/desktop 上溯到工作区根，把 desktop 依赖并进根 `pnpm-lock.yaml`、往 `pnpm-workspace.yaml` 写 blocked-build 占位符——打包后要 `git checkout -- pnpm-workspace.yaml pnpm-lock.yaml` 还原（第一刀实测踩过） | 本机实测（第一刀落地过程） |
| python-build-standalone tag 20260924；cpython 3.13.15：mac aarch64 install_only 25.3MB、win x64 47.5MB/22.0MB stripped | GitHub API `repos/astral-sh/python-build-standalone/releases/latest` |
| pbs 可搬迁（改名后仍跑、ssl/sqlite3/zlib OK、venv 可建）；解包 ~70MB | 本机实测（uv 缓存的 cpython 3.12.13 拷至 /tmp 改名重跑） |
| torch 2.2.2：mac arm64 wheel 59.7MB、win cp39 wheel 198.5MB；torch 最新 2.14.0；demucs 4.1.0 依赖 `torch>=2.1` | PyPI JSON API |
| 本机 venv：splitter 381M（torch 266M/numpy 46M/sympy 29M）、analysis 8.9M、generator 8.9M、grabber 32M、soundfont 42M | `du -sh _venvs/*` |
| htdemucs 权重 80MB | 本机 `~/.cache/torch/hub/checkpoints/`（htdemucs_ft ~700MB 为 ft 版，不用） |
| imageio-ffmpeg 0.6.0 mac arm64 wheel 21.1MB（含静态 ffmpeg） | PyPI JSON API |
| codex：codex-cli 0.154.0-alpha.6.2、`app-server` 子命令在、212MB arm64 | 本机 `/Applications/ChatGPT.app/.../codex --version`、`du -sh`、`--help` |
| 桥的环境变量旋钮（HOME/PYTHON(_ID)/BRIDGE_PORT/AGENT_PORT/CODEX） | `tools/mcp-bridge.mjs:29-48`、`tools/agent-bridge.mjs:32-69,946` 源码 |
| GH Actions：macos-latest=macOS 26 arm64、macos-15=arm64、macos-26-intel、windows-latest=Server 2025 x64 | `actions/runner-images` README（2026-09 查） |
| GitHub 直连限速 ~1MB/2min vs npmmirror 秒下 124MiB | 本机实测（同一 zip 两个源） |
| notarytool 为唯一公证路径、Developer ID + hardened runtime + staple | Apple 开发者资源（WWDC22 起 altool 退役）；"Developer ID 证书改一年有效"的传闻**未获证实，不写进结论** |
| Win7/8 自 Electron 22 起不支持；Electron 官方支持最近 3 个主版本 | electronjs.org timelines |
| Tauri 2：系统 WebView、壳 3–10MB、运行时须自行 sidecar | Tauri 官方生态资料 |
| **用户数据体积（迁移清单）**：_library 412K（db 268K+covers）、recordings 458M（240 件）、exports 108M（110 件）、_soundfonts/GeneralUser-GS-1.471.sf2 30M —— 合计 ≈597MB；_venvs 共 822M（mamba-root 336M 为无引用遗留） | 本机 `du` 实测（2026-09-26） |
| **analysis/generator 的 venv 是空壳**：`_venvs/{audio-analysis-dedupe,shadow-music-generator}/bin/python` 软链 → `_venvs/stem-splitter/bin/python`，dist-info 只有 pip/setuptools —— 实际骑 381M torch env 跑（numpy 1.26.4） | 本机 `readlink` + dist-info 清点（2026-09-26） |
| **三个 numpy 并存**：splitter 系 1.26.4（venv freeze）、系统用户 site 2.0.2、soundfont 2.5.3（python 3.12 独立 venv，numpy+pyfluidsynth 1.4.0，lib/ 为 conda 系全量 dylib 42M） | 本机 dist-info 清点（2026-09-26） |
| **converter/library 真依赖在用户 site**（~/Library/Python/3.9）：pyrekordbox 0.4.4、sqlalchemy、construct、dateutil、mutagen 1.47.0、Pillow、send2trash、psutil；scipy 1.13.1 在但无任何仓声明（残留）；library/pyproject 声明 numpy 但 src 零 import（grep）；planner/steward pyproject dependencies=[] | 本机 site-packages 清点 + 各仓 pyproject + grep（2026-09-26） |
| grabber venv 冻结集：mutagen 1.47.0、pycryptodome 3.23.0、yt-dlp 2025.10.14（pyproject 声明的 requests/customtkinter/tkinterdnd2 未装——MCP 面只需轻子集） | 本机 dist-info 清点（2026-09-26） |
| splitter venv 冻结集（30 包）：torch 2.2.2、torchaudio 2.2.2、demucs 4.0.1、numpy 1.26.4、soundfile 0.13.1、lameenc、julius、omegaconf、einops、sympy 1.14.0… | 本机 dist-info 清点（2026-09-26） |
| **torch 2.2.2 cp312 mac arm64 wheel 存在**：`torch-2.2.2-cp312-none-macosx_11_0_arm64.whl` = 59,678,388 字节；无 cp313、无 universal2 | PyPI JSON API 实查（2026-09-26） |
| 9 个插件仓源码体积（去 .git）共 ≈4.2MB（68K–904K/仓）；bin/fpcalc 2.6MB；bin/ffmpeg 是指向 ~/Library/Python/3.9/.../imageio_ffmpeg 的机器特定软链（装箱须改为随包真文件，21.1MB 见 §2.1） | 本机 `du` + `ls -la` 实测（2026-09-26） |
| **第 1 步迁移实测**：真家 651 件/1046.7MB + 5 venv（706M，跳过 mamba-root）clonefile **6 秒**完成；db 行数 196==196；3 文件 md5 逐一相符；audio-analysis/generator 的 bin/python 绝对软链改写进新家 2 条；Xcode/用户 site 外部链保留；旧家树 md5 前后一致 | 本机实测（`/tmp/step1-d.log`，2026-09-26） |
| **open 起 → 9/9 ready 78 工具（TCC 根除反证）**：迁移后 `open` 起的 app，python 全部从 `~/Library/Application Support/ShadowRoom/_venvs/` 起，2 秒内全 ready；⌘Q 后 0 进程 0 孤儿 | 本机实测（2026-09-26；对照首刀同路径 9 error + 阻塞在 open()） |
| **cp -c -R 软链 realpath 行为**：拷贝会把软链目标存成 realpath 形式（/tmp→/private/tmp），软链改写的字面前缀比对会漏——须 realpath 归一后再比（fixture 测试抓到） | 本机实测（2026-09-26） |
| **覆写模式下源码同步是雷**：(c)/env/config 覆写把 HOME 指回用户目录时，sync 会 rm+覆盖用户自己的 git 检出（fixture 抓到：9 个仓被塞进 fixture）——修复为 managed=false 时禁同步，复验旧家 md5 不变 | 本机实测（2026-09-26） |
| electron-builder 直调 `.bin` 时 collector 对包管理器的兜底识别是 npm（`npm_config_user_agent` 缺失），机器无 npm 即 ENOENT 间歇失败；`pnpm run dist:dir`（pnpm 会注入 user agent）稳定命中 pnpm；另 files 列表漏 home.mjs 会让 app 秒退、package.json 缺 `productName` 会让 userData 变 `…/@shadowroom/desktop` | 本机实测（2026-09-26，第 1 步落地过程） |
| **第 2 步装箱实测**：pbs cpython 3.12.14+20260924（npmmirror 24MB→解包 75M，ssl/sqlite3/zlib OK）+ 22 wheels 50M（imageio-ffmpeg 0.6.0 内置 ffmpeg 占 ~26M）；.core 离线构建 4.4–4.8s、stamp 幂等 ~150ms；干净模拟（无 _venvs）`open` 后 **7 秒 8/9 ready 75 工具零 TCC**（splitter 兜底系统 python3 可列工具——mcp_server 顶层不 import torch；soundfont error 预期）；稳态 9/9 78 | 本机实测（2026-09-26） |
| **core 七仓单测（.core 3.12）**：audio 65 OK、planner 48 OK、library 74 OK、steward 无 tests；grabber 132 用例 8 挂 vs 3.9 基线 87 用例 22 挂（零回归，剩 8 与基线逐条同）；converter 2 挂 + generator 4 挂 = 全部 3.12 新失败都是测试前提绑定旧行为：① converter sqlite WAL 副档件断言（3.12 sqlite 行为变化）② generator YUE_COMMAND 模板 `sys.executable` 未加引号（shlex 契约要求引号，路径含空格即炸——userData 带空格才暴露）③ generator wave：**3.12 已能读 WAVE_FORMAT_EXTENSIBLE**，测试前提"wave refuses"失效 | 本机实测（2026-09-26；修复都在插件仓测试，各 1–2 行，待派） |
| **dmg/zip 对账**：`dist:mac` 出 dmg 200M / zip 201M；.app=zip=dmg+源头四方全等（22 whl 集合 md5 `69f9d85a…`、runtime build-id `cpython-3.12.14+20260924` 逐字节同） | 本机实测（2026-09-26） |
| **双实例抢端口**：两个 app 实例并行时后起实例两桥 EADDRINUSE 全崩、UI 哑巴（与 Codex 并行复验时实测相撞）；修复 = `app.requestSingleInstanceLock()`，第二实例即退 + `second-instance` 聚焦已有窗口 | 本机实测（2026-09-26，第 2 步落地过程） |

（完。执行第一刀时如与本文件冲突，以实测为准并回写本文件。）
