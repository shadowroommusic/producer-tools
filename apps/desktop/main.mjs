// 桌面壳：伺服 web dist + 拉起两个桥。桥不改一行——全部通过环境变量旋钮接入。
import { app, protocol, net, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { homedir } from "node:os";
import { resolveDesktopHome, syncPluginSources } from "./home.mjs";
import { ensureCoreEnv, ensureSoundfontEnv } from "./env.mjs";

const DEV = !app.isPackaged;
// 打包态的 HOME（userData 或用户覆写），由 resolveDesktopHome 在起桥前解析；
// dev 态保持 undefined——桥沿用自己的默认 ~/Documents/ShadowRoom，dev 工作流零变化。
let HOME_DIR;

// 单实例锁：两个实例抢 18787/18788 时，后起的桥会 EADDRINUSE 崩掉、UI 变哑巴
// （2026-09-26 实测撞过一次：并行复验的实例先起 3 秒，后起实例两桥全崩）。
// 第二个实例直接退出；再点图标时把已有窗口带到前台。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[main] another instance is running, quitting");
  app.quit();
}
let win = null;
app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
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
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1",
    SHADOWROOM_BRIDGE_PORT: MCP_PORT, SHADOWROOM_AGENT_PORT: AGENT_PORT, ...extra };
  if (HOME_DIR !== undefined) env.SHADOWROOM_HOME = HOME_DIR;
  // 包内 pbs runtime 的位置：stem-splitter 首次分轨自举 venv 时优先用它（3.12，torch 有
  // cp312 车轮）；dev 态不设，装完插件沿用系统解释器。桥与插件进程都从环境里读。
  if (!DEV) env.SHADOWROOM_PYTHON_RUNTIME = join(process.resourcesPath, "python-runtime");
  return env;
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

app.whenReady().then(async () => {
  if (!gotLock) return;
  // 第二刀第 1 步：打包态先定家（可能弹首启向导/跑迁移），再同步插件源码，
  // 最后才起桥开窗——桥和 UI 看到的必须是同一个新家。dev 态完全跳过。
  // 覆写模式（managed=false）下不同步源码：用户指定的地方（如 ~/Documents/ShadowRoom）
  // 里的 <repo> 是他自己的检出，rm+覆盖等于删他的工作区。
  if (!DEV) {
    const { home, managed } = await resolveDesktopHome();
    HOME_DIR = home;
    if (managed) {
      ensureCoreEnv(HOME_DIR);        // 先建 env（慢路径含离线 pip install），再同步源码
      // soundfont env 失败只降级（插件 error、其余照常）——它重建自包内 wheels，
      // 不像 .core 那样一坏就整 app 起不来（§6.4 第 3 步的取舍）。
      try {
        ensureSoundfontEnv(HOME_DIR);
      } catch (error) {
        console.error(`[env] soundfont env failed (degraded): ${error?.message ?? error}`);
      }
      syncPluginSources(HOME_DIR);
    }
  }
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

  win = new BrowserWindow({ width: 1600, height: 1000, title: "ShadowRoom" });
  win.loadURL("app://sr/index.html");
});
