/**
 * Library primary-action acceptance for the previously hidden analyze_missing path.
 *
 * Real playlist data is used, but analyze_missing/stats are served from a deterministic fixture so
 * this test never mutates the user's library. It verifies the button is in the main toolbar, the
 * bounded 4x25 loop stops once candidates reach zero, and stats/list/detail receive a final refresh.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.LIBRARY_ACTION_BASE ?? "http://127.0.0.1:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/library-analyze-20261020";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

let analyzeCalls = 0;
let statsCalls = 0;
let listCalls = 0;
const baseStats = {
  tracks: 51,
  bpm_rate: 1,
  key_rate: 1,
  with_bpm: 51,
  with_key: 51,
  missing_analysis: 0,
  analysis_complete_rate: 1,
  crates: 0,
  db_bytes: 1024,
};
const envelope = (result) => ({ result: JSON.stringify(result), isError: false, ms: 1 });

await page.route("**/api/call", async (route) => {
  const request = route.request();
  const body = request.postDataJSON();
  if (body.server === "library" && body.tool === "analyze_missing") {
    analyzeCalls += 1;
    const result =
      analyzeCalls === 1
        ? {
            candidates: 7,
            analysed: 7,
            failed: 0,
            missing_files: 0,
            key_skipped_low_confidence: 0,
            errors: [],
            ms: 420,
          }
        : {
            candidates: 0,
            analysed: 0,
            failed: 0,
            missing_files: 0,
            key_skipped_low_confidence: 0,
            errors: [],
            ms: 4,
          };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope(result)) });
  }
  if (body.server === "library" && body.tool === "stats") {
    statsCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          ...baseStats,
          key_rate: analyzeCalls > 0 ? 1 : 0.86,
          with_key: analyzeCalls > 0 ? 51 : 44,
          missing_analysis: analyzeCalls > 0 ? 0 : 7,
        }),
      ),
    });
  }
  if (body.server === "library" && body.tool === "list_tracks") {
    listCalls += 1;
  }
  return route.continue();
});

await page.addInitScript(() => {
  localStorage.setItem("shadowroom.view", "library");
  localStorage.removeItem("shadowroom.orb.position");
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-lib-commandbar", { timeout: 30000 });
await page.waitForTimeout(700);

const button = page.locator('.sr-lib-commandbar [data-slot="analyze-pending"]');
check(
  "① 主操作区出现带剩余数的主动分析按钮",
  (await button.count()) === 1 && (await button.innerText()).includes("7") && await button.isEnabled(),
  await button.innerText().catch(() => "(missing)"),
);

const listCallsBefore = listCalls;
await button.click();
await page.waitForFunction(
  () => document.querySelector(".sr-lib-analyze-note")?.textContent?.includes("分析完成"),
  null,
  { timeout: 10000 },
);
const note = await page.locator(".sr-lib-analyze-note").innerText();
const after = await page.evaluate(() => ({
  stats: [...document.querySelectorAll(".sr-lib-hero-stats .sr-lib-stat")].map((node) => node.textContent?.trim()),
  button: document.querySelector('[data-slot="analyze-pending"]')?.textContent?.trim(),
  disabled: document.querySelector('[data-slot="analyze-pending"]')?.hasAttribute("disabled"),
}));
check(
  "② analyze_missing 有界循环完成，待分析归零并保留完成说明",
  analyzeCalls === 1 &&
    note.includes("分析完成") &&
    note.includes("补全 7") &&
    after.disabled &&
    after.button?.includes("0"),
  `calls=${analyzeCalls} note=${note} button=${after.button}`,
);
check(
  "③ 分析结束后 stats 与曲目列表都重新读取",
  statsCalls >= 2 && listCalls > listCallsBefore,
  `stats=${statsCalls} list=${listCallsBefore}->${listCalls}`,
);

await page.setViewportSize({ width: 1092, height: 605 });
await page.waitForTimeout(200);
const compact = await page.evaluate(() => {
  const bar = document.querySelector(".sr-lib-commandbar");
  const btn = document.querySelector('[data-slot="analyze-pending"]');
  return {
    overflow: bar === null ? -1 : bar.scrollWidth - bar.clientWidth,
    visible: btn instanceof HTMLElement && btn.getBoundingClientRect().width > 0,
    rect: btn instanceof HTMLElement
      ? { x: btn.getBoundingClientRect().x, right: btn.getBoundingClientRect().right }
      : null,
  };
});
check("④ 1092×605 下按钮可见且不横向溢出", compact.overflow <= 1 && compact.visible, JSON.stringify(compact));
await page.screenshot({ path: `${SHOTS}/library-analyze-complete.png`, fullPage: true });
check("⑤ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await context.close();
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
