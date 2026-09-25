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
