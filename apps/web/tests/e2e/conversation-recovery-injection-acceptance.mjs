/**
 * After the bridge/core restarts, the first turn for a UI session receives a bounded text-only tail;
 * later turns rely on the live thread and must not duplicate that recovery block.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.SCOPE_E2E_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const messages = Array.from({ length: 8 }, (_, index) => ({
  id: `m${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text: `TURN-${index}`,
  at: index + 1,
}));
messages.splice(3, 0, { id: "think", role: "reasoning", text: "DO-NOT-RECOVER", at: 4 });
messages.splice(6, 0, { id: "tool", role: "tool", callId: "call", at: 7 });
const session = {
  id: "butler-recovery",
  kind: "butler",
  scope: { workspaceId: "butler" },
  title: "恢复上下文",
  createdAt: 1,
  lastActiveAt: 1,
  calls: [],
  messages,
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
const sends = [];
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
        instanceId: "bridge-after-restart",
        threads: 0,
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
    sends.push(request.postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        'data: {"type":"delta","text":"收到","itemId":"answer"}\n\n' +
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
  localStorage.setItem("shadowroom.sessions.v1", JSON.stringify({
    sessions: [seed],
    activeButlerId: seed.id,
    activeWorkerIds: {},
  }));
  localStorage.removeItem("shadowroom.dock.by-view.v1");
}, session);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);

for (const text of ["第一轮", "第二轮"]) {
  const sent = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/agent/send",
  );
  await page.locator(".sr-composer-input").fill(text);
  await page.locator(".sr-composer-input").press("Enter");
  await sent;
  await page.waitForFunction(
    () => document.querySelector(".sr-send")?.getAttribute("aria-label") === "发送",
    undefined,
    { timeout: 3000 },
  );
}

const first = sends[0]?.text ?? "";
const second = sends[1]?.text ?? "";
check(
  "① 重启后的第一轮注入最近正文且不包含 reasoning/tool",
  first.includes("[recent_conversation]") &&
    first.includes("TURN-7") &&
    !first.includes("DO-NOT-RECOVER") &&
    !first.includes("TURN-0"),
  first.slice(0, 320).replace(/\n+/g, " | "),
);
check(
  "② 同一 bridge 的下一轮不重复恢复块",
  second.includes("第二轮") && !second.includes("[recent_conversation]"),
  second.slice(0, 180).replace(/\n+/g, " | "),
);
check("③ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
