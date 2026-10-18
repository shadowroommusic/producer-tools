/**
 * Global butler route-confirmation card: classification stays in the butler thread, execution lands
 * in the chosen page worker only after the user confirms.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.ROUTE_E2E_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const routeDecision = {
  accept: true,
  target: "studio",
  action_summary: "把当前工程的 bass 改暗",
  required_context: ["projectId"],
  confidence: 0.94,
  context_satisfied: true,
  missing_context: [],
};
const butler = {
  id: "butler-route",
  kind: "butler",
  scope: { workspaceId: "butler" },
  title: "把 bass 改暗",
  createdAt: 1,
  lastActiveAt: 1,
  messages: [
    { id: "u-route", role: "user", text: "把当前工程的 bass 改暗", at: 2 },
    { id: "tool-route", role: "tool", callId: "route-1", at: 3 },
  ],
  calls: [
    {
      id: "route-1",
      server: "steward",
      name: "route_intent",
      status: "ok",
      summary: "94%",
      detail: JSON.stringify({
        arguments: { target: "studio", action_summary: routeDecision.action_summary, confidence: 0.94 },
        result: { content: [{ type: "text", text: JSON.stringify(routeDecision) }] },
      }),
    },
  ],
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
  localStorage.setItem("shadowroom.view", "workbench");
  localStorage.setItem("shadowroom.sessions.v1", JSON.stringify({
    sessions: [session],
    activeButlerId: session.id,
    activeWorkerIds: {},
  }));
  localStorage.removeItem("shadowroom.dock.by-view.v1");
}, butler);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
await page.locator(".sr-dock-rail-btn").click();
await page.waitForTimeout(300);

const card = page.locator(".sr-route-card");
check(
  "① 管家对话显示结构化路由卡",
  (await card.count()) === 1 && (await card.innerText()).includes("Studio") && (await card.innerText()).includes("94%"),
  (await card.innerText()).replace(/\n+/g, " | "),
);

await card.getByRole("button", { name: "打开并继续" }).click();
await page.waitForTimeout(450);
const after = await page.evaluate(() => ({
  view: localStorage.getItem("shadowroom.view"),
  docks: JSON.parse(localStorage.getItem("shadowroom.dock.by-view.v1") ?? "{}"),
  draft: document.querySelector(".sr-composer-input")?.value ?? "",
  studioWorker: JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}").sessions?.find((entry) => entry.kind === "studio")?.id,
}));
check(
  "② 确认后才切到 Studio worker、打开 dock 并填入草稿",
  after.view === "studio" &&
    after.docks.studio === true &&
    after.draft === routeDecision.action_summary &&
    typeof after.studioWorker === "string",
  JSON.stringify(after),
);
check("③ 路由确认流程零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
