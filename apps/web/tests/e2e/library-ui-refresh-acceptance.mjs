/**
 * Library workspace refresh acceptance (2026-10-19).
 *
 * Checks the user-facing catalog layout against the real local library: overview stats, one ingest
 * toolbar, a fixed table header, 80-row paging, clear title/artist/BPM/key/time columns and zero
 * horizontal overflow at the app's compact desktop size.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.LIBRARY_UI_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/library-ui-20261019";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1092, height: 605 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.addInitScript(() => localStorage.setItem("shadowroom.view", "library"));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-lib-row", { timeout: 15000 });
await page.waitForTimeout(400);

const metrics = await page.evaluate(() => {
  const root = document.querySelector(".sr-lib");
  return {
    stats: document.querySelectorAll(".sr-lib-stat").length,
    toolbar: document.querySelectorAll(".sr-lib-toolbar").length,
    headers: document.querySelectorAll(".sr-lib-table-head > span").length,
    rows: document.querySelectorAll(".sr-lib-row").length,
    more: document.querySelectorAll(".sr-lib-loadmore").length,
    overflow: root === null ? -1 : root.scrollWidth - root.clientWidth,
  };
});
check(
  "① 概览、单一入库工具栏、表头与 80 行首屏",
  metrics.stats === 4 &&
    metrics.toolbar === 1 &&
    metrics.headers === 6 &&
    metrics.rows === 80 &&
    metrics.more === 1 &&
    metrics.overflow <= 1,
  JSON.stringify(metrics),
);

const first = await page.locator(".sr-lib-row").first().evaluate((row) => ({
  title: row.querySelector(".sr-lib-row-title")?.textContent ?? "",
  artist: row.querySelector(".sr-lib-row-artist")?.textContent ?? "",
  bpm: row.querySelector(".sr-lib-row-bpm")?.textContent ?? "",
  key: row.querySelector(".sr-lib-row-key")?.textContent ?? "",
  time: row.querySelector(".sr-lib-row-time")?.textContent ?? "",
  cover: row.querySelector(".sr-lib-row-cover") !== null,
}));
check(
  "② 行内字段固定分栏，标题/艺人/数字扫描路径清楚",
  first.title !== "" && first.artist !== "" && first.bpm !== "" && first.key !== "" && first.time !== "" && first.cover,
  JSON.stringify(first),
);

await page.locator(".sr-lib-loadmore").scrollIntoViewIfNeeded();
await page.locator(".sr-lib-loadmore").click();
await page.waitForFunction(() => document.querySelectorAll(".sr-lib-row").length > 80, null, { timeout: 10000 });
const loaded = await page.locator(".sr-lib-row").count();
check("③ 加载更多不会把第 81 首以后藏死", loaded >= 160, `rows=${loaded}`);

await page.locator('input[aria-label="搜索标题、艺人、专辑"]').fill("deep-house");
await page.waitForTimeout(600);
const filtered = await page.locator(".sr-lib-row").count();
check("④ 搜索仍走真实服务端过滤", filtered > 0 && filtered < loaded, `filtered=${filtered} / loaded=${loaded}`);

await page.screenshot({ path: `${SHOTS}/library-1092.png` });
check("⑤ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
