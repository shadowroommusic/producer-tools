import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "dj");
  if (!window.sessionStorage.getItem("__s2b")) {
    window.localStorage.removeItem("shadowroom.setdraft");
    window.sessionStorage.setItem("__s2b", "1");
  }
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });
await page.waitForTimeout(2500);

const dockOpen = (await page.locator(".sr-dj-dock, .sr-dock, [class*=dock]").count()) > 0;
const titleWidths = async (scope) =>
  page.locator(`${scope} .sr-dj-row-title`).evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
  );
const artistWaste = async (scope) =>
  page.locator(`${scope} .sr-dj-row-artist`).evaluateAll((nodes) =>
    nodes.filter((node) => (node.textContent ?? "").trim() === "").map((node) => Math.round(node.getBoundingClientRect().width)),
  );

// ① 曲目库：全部行 title ≥80px，空 artist 不占宽
const libraryWidths = await titleWidths(".sr-dj-library");
const libraryWaste = await artistWaste(".sr-dj-library");
check(
  "① 曲目库：每行 title ≥80px",
  libraryWidths.length > 0 && libraryWidths.every((w) => w >= 80),
  `共 ${libraryWidths.length} 行，最小 ${Math.min(...libraryWidths)}px，最大 ${Math.max(...libraryWidths)}px`,
);
check(
  "② 空 artist 不占宽度",
  libraryWaste.every((w) => w <= 8),
  `空 artist 行 ${libraryWaste.length} 个，宽度 ${libraryWaste.join("/") || "（无）"}px`,
);

// 加 3 首到看板 → 量看板 + 推荐
const rows = page.locator(".sr-dj-library .sr-dj-row");
for (let i = 0; i < 3; i += 1) {
  await rows.nth(i).locator("button", { hasText: "加入" }).click();
  await page.waitForTimeout(600);
}
await page.waitForTimeout(2500);
const boardWidths = await titleWidths(".sr-dj-board");
const suggestWidths = await titleWidths(".sr-dj-suggest-strip");
check(
  "③ 看板行 title ≥80px",
  boardWidths.length === 3 && boardWidths.every((w) => w >= 80),
  `看板 ${boardWidths.length} 行，宽度 ${boardWidths.join("/")}px`,
);
check(
  "④ 推荐行 title ≥80px",
  suggestWidths.length === 0 || suggestWidths.every((w) => w >= 80),
  `推荐 ${suggestWidths.length} 行，宽度 ${suggestWidths.join("/") || "（没推荐）"}px`,
);

// ⑤ 危险回归：点一行“中央”（标题区）应该是载入，不是删除
const draftBefore = await page.evaluate(() => JSON.parse(window.localStorage.getItem("shadowroom.setdraft") ?? "null")?.trackIds?.length ?? 0);
const firstBoardRow = page.locator(".sr-dj-board .sr-dj-row").first();
const box = await firstBoardRow.boundingBox();
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height / 2); // 行中央偏左（标题区）
await page.waitForTimeout(2000);
const draftAfter = await page.evaluate(() => JSON.parse(window.localStorage.getItem("shadowroom.setdraft") ?? "null")?.trackIds?.length ?? 0);
const deckTitle = await page.locator(".sr-dj-deck .sr-dj-deck-title").getAttribute("title");
check(
  "⑤ 点行中央 = 载入（不是删除）",
  draftAfter === draftBefore && Boolean(deckTitle),
  `草稿 ${draftBefore} → ${draftAfter}（应不变），载入的是 ${deckTitle?.split("/").pop() ?? "（空）"}`,
);

check("⑥ 零 console error", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "没有 error/pageerror");
console.log(`\ndock 元素: ${dockOpen ? "在" : "不在"}（视口 1280×800）`);
console.log(`汇总: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
