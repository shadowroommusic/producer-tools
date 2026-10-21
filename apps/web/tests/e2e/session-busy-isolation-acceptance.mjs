/**
 * A butler turn must stay visibly busy on the orb without painting "正在运行" into the Studio
 * worker's dock. The two threads share a bridge, not a busy flag.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.SCOPE_E2E_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const session = (id, kind, text) => ({
  id,
  kind,
  scope: { workspaceId: kind },
  title: kind === "butler" ? "管家" : "Studio 助手",
  createdAt: 1,
  lastActiveAt: 1,
  calls: [],
  messages: text === "" ? [] : [{ id: `${id}-m`, role: "user", text, at: 2 }],
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
let releaseButler;
let sendStarted;
const sendStartedPromise = new Promise((resolve) => {
  sendStarted = resolve;
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === "GET" && url.pathname === "/api/servers") {
    await route.fulfill({ json: { servers: [], home: "/tmp", workspaces: "/tmp" } });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/api/agent/health") {
    await route.fulfill({
      json: {
        ok: true,
        threads: 1,
        cwd: "/tmp",
        sandbox: "workspace-write",
        approval: "never",
        plugins: [],
      },
    });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/api/agent/models") {
    await route.fulfill({ json: { models: [] } });
    return;
  }
  if (request.method() === "POST" && url.pathname === "/api/agent/send") {
    sendStarted();
    await new Promise((resolve) => {
      releaseButler = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        'data: {"type":"delta","text":"完成","itemId":"answer"}\n\n' +
        'data: {"type":"done","turn":{"status":"completed"}}\n\n',
    });
    return;
  }
  if (request.method() === "POST" && url.pathname === "/api/call") {
    await route.fulfill({ json: { result: "{}" } });
    return;
  }
  await route.fulfill({ status: 204, body: "" });
});

await page.addInitScript((seed) => {
  localStorage.setItem("shadowroom.view", "conversation");
  localStorage.setItem("shadowroom.sessions.v1", JSON.stringify(seed));
  localStorage.removeItem("shadowroom.dock.by-view.v1");
}, {
  activeButlerId: "butler-busy",
  activeWorkerIds: { studio: "studio-busy" },
  sessions: [
    session("butler-busy", "butler", ""),
    session("studio-busy", "studio", "STUDIO-ONLY"),
  ],
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(350);
await page.locator(".sr-composer-input").fill("帮我看一下全局状态");
await page.locator(".sr-composer-input").press("Enter");
await sendStartedPromise;
await page.waitForTimeout(100);

check(
  "① 管家线程开始后只有悬浮球进入 working",
  (await page.locator(".sr-orb").getAttribute("data-mode")) === "working",
  `orb=${await page.locator(".sr-orb").getAttribute("data-mode")}`,
);

await page.getByRole("button", { name: "Studio", exact: true }).click();
await page.waitForTimeout(300);
await page.locator(".sr-dock-rail-btn").click();
await page.waitForTimeout(250);
const dockText = await page.locator(".sr-dock").innerText();
const sendLabel = await page.locator(".sr-dock .sr-send").getAttribute("aria-label");
check(
  "② Studio worker dock 不继承管家 busy",
  dockText.includes("STUDIO-ONLY") &&
    !dockText.includes("正在运行") &&
    sendLabel === "发送",
  `text=${dockText.replace(/\n+/g, " | ").slice(0, 180)} · send=${sendLabel}`,
);
check(
  "③ 页面切换期间悬浮球仍保持管家线程 working",
  (await page.locator(".sr-orb").getAttribute("data-mode")) === "working",
  `orb=${await page.locator(".sr-orb").getAttribute("data-mode")}`,
);

releaseButler();
await page.waitForTimeout(250);
check(
  "④ 管家结束后回到 idle，Studio worker 仍无串台状态",
  (await page.locator(".sr-orb").getAttribute("data-mode")) !== "working" &&
    !(await page.locator(".sr-dock").innerText()).includes("正在运行"),
  `orb=${await page.locator(".sr-orb").getAttribute("data-mode")}`,
);
check("⑤ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
