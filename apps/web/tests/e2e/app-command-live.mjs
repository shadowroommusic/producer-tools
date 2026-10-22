/**
 * Real-model acceptance for the butler's typed app command.
 *
 * This intentionally hits the running app bridges. It verifies that the model actually chooses
 * `navigate` for a page-only request, then `dispatch` for a Studio task, and that the latter reaches
 * exactly one Studio worker with a durable handoff.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.APP_COMMAND_LIVE_BASE ?? "http://localhost:5173";
const BRIDGE = process.env.APP_COMMAND_LIVE_BRIDGE ?? "http://127.0.0.1:8787";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function callTool(server, tool, args) {
  const response = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server, tool, arguments: args }),
  });
  const data = await response.json();
  if (!response.ok || data.isError === true) throw new Error(String(data.result ?? response.statusText));
  return typeof data.result === "string" ? JSON.parse(data.result) : data.result;
}

async function handoffCount() {
  const result = await callTool("steward", "handoff_list", { limit: 50 });
  return Array.isArray(result.handoffs) ? result.handoffs.length : 0;
}

const butler = {
  id: `butler-live-app-command-${Date.now()}`,
  kind: "butler",
  scope: { workspaceId: "butler" },
  title: "App command live",
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  messages: [],
  calls: [],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.addInitScript((session) => {
  localStorage.setItem("shadowroom.view", "dj");
  localStorage.setItem("shadowroom.sessions.v1", JSON.stringify({
    sessions: [session],
    activeButlerId: session.id,
    activeWorkerIds: {},
  }));
  localStorage.removeItem("shadowroom.dock.by-view.v1");
  localStorage.removeItem("shadowroom.studio.projects.v1");
  localStorage.removeItem("shadowroom.studio.open");
}, butler);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator(".sr-dj").waitFor({ state: "visible", timeout: 20_000 });

async function sendButler(text) {
  if ((await page.locator(".sr-orb-panel").count()) === 0) {
    await page.locator(".sr-orb-ball").focus();
    await page.locator(".sr-orb-ball").press("Enter");
  }
  const input = page.locator('.sr-orb-input .sr-input[aria-label="给悬浮球的一句话"]');
  await input.fill(text);
  await page.waitForTimeout(80);
  await input.press("Enter");
}

function storeSnapshot() {
  return page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
    const workerMessages = {};
    for (const kind of ["studio", "dj", "library"]) {
      const session = store.sessions?.find((entry) => entry.kind === kind);
      workerMessages[kind] = session?.messages?.filter((message) => message.role === "user").length ?? 0;
    }
    const butlerSession = store.sessions?.find((entry) => entry.kind === "butler");
    return {
      view: localStorage.getItem("shadowroom.view"),
      workerMessages,
      calls: butlerSession?.calls?.map((call) => ({
        name: call.name,
        status: call.status,
        detail: call.detail,
      })) ?? [],
    };
  });
}

const handoffsBeforeNavigation = await handoffCount();
await sendButler("切到 Studio");
await page.locator(".sr-page-title").filter({ hasText: "Studio" }).waitFor({ state: "visible", timeout: 90_000 });
await page.waitForTimeout(1200);
const afterNavigation = await storeSnapshot();
const navigationCalls = afterNavigation.calls.filter((call) => call.name === "app_command");
check(
  "L1 真模型把纯换页识别成 app_command.navigate",
  afterNavigation.view === "studio" &&
    navigationCalls.length === 1 &&
    navigationCalls[0]?.detail?.includes('"op": "navigate"'),
  JSON.stringify({
    view: afterNavigation.view,
    appCommands: navigationCalls.length,
    call: navigationCalls[0]?.detail?.slice(0, 240),
  }),
);
check(
  "L2 真模型导航没有派任何 worker、没有新增 handoff",
  Object.values(afterNavigation.workerMessages).every((count) => count === 0) &&
    (await handoffCount()) === handoffsBeforeNavigation,
  JSON.stringify({
    workerMessages: afterNavigation.workerMessages,
    handoffsBefore: handoffsBeforeNavigation,
    handoffsAfter: await handoffCount(),
  }),
);

const handoffsBeforeDispatch = await handoffCount();
await sendButler("做一段 2 小节、120 BPM 的鼓，放进当前 Studio 工程。");
let dispatched;
const dispatchDeadline = Date.now() + 120_000;
while (Date.now() < dispatchDeadline) {
  await page.waitForTimeout(1000);
  dispatched = await storeSnapshot();
  if (dispatched.workerMessages.studio > 0) break;
}
await page.waitForTimeout(800);
dispatched ??= await storeSnapshot();
const dispatchCommands = dispatched.calls.filter((call) => call.name === "app_command");
check(
  "L3 真模型把领域任务识别成 app_command.dispatch",
  dispatchCommands.some((call) => call.detail?.includes('"op": "dispatch"')),
  JSON.stringify(dispatchCommands.map((call) => call.detail?.slice(0, 260))),
);
check(
  "L4 dispatch 只把任务交给 Studio worker 一次，且没有混进别的 worker",
  dispatched.workerMessages.studio === 1 &&
    dispatched.workerMessages.dj === 0 &&
    dispatched.workerMessages.library === 0 &&
    (await handoffCount()) === handoffsBeforeDispatch + 1,
  JSON.stringify({
    workerMessages: dispatched.workerMessages,
    handoffsBefore: handoffsBeforeDispatch,
    handoffsAfter: await handoffCount(),
  }),
);
check(
  "L5 真模型两轮都没有调用已退役的 route_intent",
  dispatched.calls.every((call) => call.name !== "route_intent"),
  JSON.stringify(dispatched.calls.map((call) => call.name)),
);
check("L6 live 页面零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await page.screenshot({ path: "/tmp/shadowroom-app-command-live.png" });
await context.close();
await browser.close();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
