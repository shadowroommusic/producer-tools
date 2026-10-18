/**
 * Session-scope acceptance: butler topics, hidden page workers, page-local dock memory.
 *
 * All state is seeded in a throwaway browser profile; no real conversation or project is written.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.SCOPE_E2E_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/session-scope";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const session = (id, kind, title, text) => ({
  id,
  kind,
  scope: { workspaceId: kind },
  title,
  createdAt: 1,
  lastActiveAt: 1,
  calls: [],
  messages: [{ id: `${id}-m`, role: "user", text, at: 2 }],
});

await page.addInitScript((seed) => {
  if (!sessionStorage.getItem("scope-seeded")) {
    sessionStorage.setItem("scope-seeded", "1");
    localStorage.setItem("shadowroom.view", "workbench");
    localStorage.setItem("shadowroom.sessions.v1", JSON.stringify(seed));
    localStorage.removeItem("shadowroom.dock.by-view.v1");
    localStorage.removeItem("shadowroom.setdraft");
  }
}, {
  activeButlerId: "butler-1",
  activeWorkerIds: { studio: "studio-1", dj: "dj-1", library: "library-1" },
  sessions: [
    session("butler-1", "butler", "管家专属", "BUTLER-ONLY"),
    session("studio-1", "studio", "Studio 助手", "STUDIO-ONLY"),
    session("dj-1", "dj", "DJ 助手", "DJ-ONLY"),
    session("library-1", "library", "曲目库助手", "LIBRARY-ONLY"),
  ],
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(600);

check(
  "① 侧栏只显示管家话题，不显示页面 worker",
  (await page.locator(".sr-session-row").count()) === 1 &&
    (await page.locator(".sr-session-row", { hasText: "管家专属" }).count()) === 1 &&
    (await page.locator(".sr-session-row", { hasText: "Studio 助手" }).count()) === 0,
  `session rows=${await page.locator(".sr-session-row").count()}`,
);
check(
  "② 首次进入工作台 dock 默认收起",
  (await page.locator(".sr-dock").count()) === 0 && (await page.locator(".sr-dock-rail-btn").count()) === 1,
  `dock=${await page.locator(".sr-dock").count()} rail=${await page.locator(".sr-dock-rail-btn").count()}`,
);

await page.getByRole("button", { name: "Studio", exact: true }).click();
await page.waitForTimeout(500);
check(
  "③ 进入 Studio 不自动弹 dock，且不出现第二套通话入口",
  (await page.locator(".sr-dock").count()) === 0 &&
    (await page.locator(".sr-dock-rail-btn").count()) === 1 &&
    (await page.getByRole("button", { name: "语音输入" }).count()) === 0,
  `dock=${await page.locator(".sr-dock").count()} rail=${await page.locator(".sr-dock-rail-btn").count()} mic=${await page.getByRole("button", { name: "语音输入" }).count()}`,
);
await page.locator(".sr-dock-rail-btn").click();
await page.waitForTimeout(300);
const studioText = await page.locator(".sr-dock").innerText();
check(
  "④ Studio dock 只显示 Studio worker 历史",
  studioText.includes("STUDIO-ONLY") &&
    !studioText.includes("DJ-ONLY") &&
    !studioText.includes("BUTLER-ONLY") &&
    (await page.locator(".sr-dock .sr-voice").count()) === 0,
  `${studioText.replace(/\n+/g, " | ").slice(0, 180)} · mic=${await page.locator(".sr-dock .sr-voice").count()}`,
);
writeFileSync(`${SHOTS}/studio-worker.png`, await page.screenshot());

await page.getByRole("button", { name: "DJ", exact: true }).click();
await page.waitForTimeout(500);
check(
  "⑤ 从 Studio 到 DJ：dock 状态按页隔离，DJ 仍收起",
  (await page.locator(".sr-dock").count()) === 0 && (await page.locator(".sr-dock-rail-btn").count()) === 1,
  `dock=${await page.locator(".sr-dock").count()}`,
);
await page.locator(".sr-dock-rail-btn").click();
await page.waitForTimeout(350);
const djText = await page.locator(".sr-dock").innerText();
check(
  "⑥ DJ dock 只显示 DJ worker 历史",
  djText.includes("DJ-ONLY") && !djText.includes("STUDIO-ONLY") && !djText.includes("BUTLER-ONLY"),
  djText.replace(/\n+/g, " | ").slice(0, 180),
);
writeFileSync(`${SHOTS}/dj-worker.png`, await page.screenshot());

await page.getByRole("button", { name: "Studio", exact: true }).click();
await page.waitForTimeout(350);
check(
  "⑦ 返回 Studio 恢复该页手动打开的 dock",
  (await page.locator(".sr-dock").count()) === 1 && (await page.locator(".sr-dock").innerText()).includes("STUDIO-ONLY"),
  `dock=${await page.locator(".sr-dock").count()}`,
);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(450);
check(
  "⑧ 刷新后 Studio dock 状态和 worker 历史都恢复",
  (await page.locator(".sr-dock").count()) === 1 && (await page.locator(".sr-dock").innerText()).includes("STUDIO-ONLY"),
  `dock=${await page.locator(".sr-dock").count()}`,
);

await page.getByRole("button", { name: "新对话", exact: true }).click();
await page.waitForTimeout(350);
const store = await page.evaluate(() => JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}"));
const butlers = (store.sessions ?? []).filter((entry) => entry.kind === "butler");
const activeButler = butlers.find((entry) => entry.id === store.activeButlerId);
check(
  "⑨ “新对话”只创建管家话题",
  butlers.length === 2 && activeButler?.title === "新对话" && (await page.getByRole("textbox").count()) > 0,
  `butlers=${butlers.length} active=${activeButler?.title ?? "(none)"}`,
);

check("⑩ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
