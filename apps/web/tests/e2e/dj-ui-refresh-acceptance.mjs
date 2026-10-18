/**
 * DJ workspace refresh acceptance (2026-10-19): compact desktop split, quiet row actions, and the
 * secondary import/export commands remain reachable through the More menu.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.DJ_UI_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/dj-ui-20261019";
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
await page.addInitScript(() => localStorage.setItem("shadowroom.view", "dj"));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-library .sr-dj-row", { timeout: 15000 });
await page.waitForTimeout(700);

const metrics = await page.evaluate(() => {
  const root = document.querySelector(".sr-dj");
  const main = document.querySelector(".sr-dj-main");
  const board = document.querySelector(".sr-dj-board")?.getBoundingClientRect();
  const deck = document.querySelector(".sr-dj-deck")?.getBoundingClientRect();
  return {
    overflow: root === null ? -1 : root.scrollWidth - root.clientWidth,
    columns: main === null ? [] : getComputedStyle(main).gridTemplateColumns.split(" ").filter(Boolean),
    board: board === undefined ? null : { top: board.top, bottom: board.bottom, width: board.width },
    deckHeight: deck?.height ?? -1,
    heroMeta: document.querySelectorAll(".sr-dj-hero-meta > span").length,
  };
});
check(
  "① 1092×605：曲目库与 Set 板双栏，Set 板在首屏",
  metrics.overflow <= 1 &&
    metrics.columns.length === 2 &&
    metrics.board !== null &&
    metrics.board.top < 400 &&
    metrics.board.bottom <= 605,
  JSON.stringify(metrics),
);
check(
  "② 顶部 Set 概览与空 deck 收成紧凑条",
  metrics.heroMeta === 3 && metrics.deckHeight <= 60,
  `heroMeta=${metrics.heroMeta} deckHeight=${metrics.deckHeight}`,
);

const action = page.locator(".sr-dj-library .sr-dj-row").first().locator(".sr-page-action").first();
check("③ 行动作默认不抢视觉", (await action.evaluate((el) => getComputedStyle(el).opacity)) === "0", `opacity=${await action.evaluate((el) => getComputedStyle(el).opacity)}`);
await page.locator(".sr-dj-library .sr-dj-row").first().hover();
await page.waitForTimeout(180);
check("④ 悬停后行动作可用", (await action.evaluate((el) => getComputedStyle(el).opacity)) === "1", `opacity=${await action.evaluate((el) => getComputedStyle(el).opacity)}`);

await page.getByRole("button", { name: "更多 Set 操作" }).click();
const moreText = await page.locator(".sr-dj-more-menu").innerText();
check("⑤ 低频操作收进 More，导入/导出仍可达", moreText.includes("导入 set") && moreText.includes("导出 m3u"), moreText.replace(/\n+/g, " | "));

await page.screenshot({ path: `${SHOTS}/dj-1092.png` });
check("⑥ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
