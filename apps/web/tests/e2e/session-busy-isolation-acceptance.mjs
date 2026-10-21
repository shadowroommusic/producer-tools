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
const sends = [];
/** One gate per /api/agent/send, in arrival order: 0 = butler, 1 = studio, 2 = butler again. */
const sendGates = [];
let sendStarted;
const sendStartedPromise = new Promise((resolve) => {
  sendStarted = resolve;
});
let studioSendStarted;
const studioSendStartedPromise = new Promise((resolve) => {
  studioSendStarted = resolve;
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
    const body = request.postDataJSON();
    const index = sends.length;
    sends.push(body);
    if (index === 0) sendStarted();
    if (body.scope === "studio") studioSendStarted();
    await new Promise((resolve) => {
      sendGates[index] = resolve;
    });
    await route
      .fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          'data: {"type":"delta","text":"完成","itemId":"answer"}\n\n' +
          'data: {"type":"done","turn":{"status":"completed"}}\n\n',
      })
      .catch(() => undefined);
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
await page.waitForTimeout(450);
const dockText = await page.locator(".sr-dock").innerText();
const sendLabel = await page.locator(".sr-dock .sr-send").getAttribute("aria-label");
check(
  "② Studio worker dock 不继承管家 busy",
  dockText.includes("STUDIO-ONLY") &&
    !dockText.includes("正在运行") &&
    sendLabel === "发送",
  `text=${dockText.replace(/\n+/g, " | ").slice(0, 180)} · send=${sendLabel}`,
);
const composerOverlap = await page.evaluate(() => {
  const orb = document.querySelector(".sr-orb-visual")?.getBoundingClientRect();
  const composer = document.querySelector(".sr-dock-composer")?.getBoundingClientRect();
  if (!orb || !composer) return null;
  return !(
    orb.right <= composer.left ||
    orb.left >= composer.right ||
    orb.bottom <= composer.top ||
    orb.top >= composer.bottom
  );
});
check(
  "②b 悬浮球不遮挡右侧输入卡片",
  composerOverlap === false,
  `overlap=${composerOverlap}`,
);
check(
  "③ 管家 outgoing 只含管家历史，不夹带 Studio worker 正文",
  sends.length === 1 &&
    sends[0]?.sessionId === "butler-busy" &&
    sends[0]?.text?.includes("帮我看一下全局状态") &&
    !sends[0]?.text?.includes("STUDIO-ONLY"),
  `requests=${sends.length} text=${String(sends[0]?.text ?? "").replace(/\n+/g, " | ").slice(0, 220)}`,
);
check(
  "④ 页面切换期间悬浮球仍保持管家线程 working",
  (await page.locator(".sr-orb").getAttribute("data-mode")) === "working",
  `orb=${await page.locator(".sr-orb").getAttribute("data-mode")}`,
);

// 并行：管家还挂着的时候，Studio worker 也能发起自己的回合（两个线程同时运行）。
await page.locator(".sr-dock .sr-composer-input").fill("给 Studio 干点活");
await page.locator(".sr-dock .sr-composer-input").press("Enter");
await studioSendStartedPromise;
await page.waitForTimeout(150);
const studioSend = sends.find((entry) => entry.scope === "studio");
check(
  "⑦ 并行：管家运行中 Studio worker 也能开自己的回合，两边互不阻塞",
  sends.length === 2 &&
    studioSend?.sessionId === "studio-busy" &&
    (await page.locator(".sr-dock .sr-send").getAttribute("aria-label")) === "停止这一轮" &&
    (await page.locator(".sr-orb").getAttribute("data-mode")) === "working" &&
    !String(studioSend?.text ?? "").includes("帮我看一下全局状态"),
  JSON.stringify({
    sends: sends.length,
    studioSession: studioSend?.sessionId,
    dockSend: await page.locator(".sr-dock .sr-send").getAttribute("aria-label"),
    orb: await page.locator(".sr-orb").getAttribute("data-mode"),
  }),
);

// 独立停止：停掉 Studio 的回合，管家的 working 不受影响。
await page.locator(".sr-dock .sr-send").click();
await page.waitForTimeout(300);
check(
  "⑧ 独立停止：Studio 回合被停，管家线程照常 working",
  (await page.locator(".sr-dock .sr-send").getAttribute("aria-label")) === "发送" &&
    (await page.locator(".sr-orb").getAttribute("data-mode")) === "working",
  `dockSend=${await page.locator(".sr-dock .sr-send").getAttribute("aria-label")} orb=${await page.locator(".sr-orb").getAttribute("data-mode")}`,
);

sendGates[0]?.();
await page.waitForTimeout(250);
check(
  "⑤ 管家结束后回到 idle，Studio worker 仍无串台状态",
  (await page.locator(".sr-orb").getAttribute("data-mode")) !== "working" &&
    !(await page.locator(".sr-dock").innerText()).includes("正在运行"),
  `orb=${await page.locator(".sr-orb").getAttribute("data-mode")}`,
);

// worker 历史不进 Butler outgoing：回到管家页再问一句，请求体里不许出现 worker 的任何正文。
await page.locator(".sr-session-row").filter({ hasText: "帮我看一下全局状态" }).first().click();
await page.waitForTimeout(300);
await page.locator(".sr-composer-input").fill("管家第二问");
await page.locator(".sr-composer-input").press("Enter");
await page.waitForTimeout(400);
const butlerSecond = sends.at(-1);
check(
  "⑨ worker 历史不进 Butler outgoing（无 STUDIO-ONLY、无 worker 回合正文、无工程上下文）",
  sends.length === 3 &&
    butlerSecond?.sessionId === "butler-busy" &&
    butlerSecond?.text?.includes("管家第二问") &&
    butlerSecond?.text?.includes("[ui_context]") &&
    !butlerSecond?.text?.includes("STUDIO-ONLY") &&
    !butlerSecond?.text?.includes("给 Studio 干点活") &&
    !butlerSecond?.text?.includes("[arrangement_context]"),
  `sends=${sends.length} text=${String(butlerSecond?.text ?? "").replace(/\n+/g, " | ").slice(0, 260)}`,
);
sendGates[2]?.();
await page.waitForTimeout(200);
check("⑥ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
