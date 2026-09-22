import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { readFileSync, existsSync } from "node:fs";

const BASE = "http://localhost:5173";
const BRIDGE = "http://127.0.0.1:8787";
const CRATE_NAME = "验收临时";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function callTool(server, tool, args) {
  const response = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server, tool, arguments: args }),
  });
  const payload = await response.json();
  if (payload.isError) throw new Error(String(payload.result).slice(0, 200));
  return typeof payload.result === "string" ? JSON.parse(payload.result) : payload.result;
}

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
await page.addInitScript(() => window.localStorage.setItem("shadowroom.view", "dj"));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj", { timeout: 30000 });
await page.waitForTimeout(2000);

const library = await callTool("library", "list_tracks", { limit: 200 });
const titleCounts = new Map();
for (const track of library.tracks) {
  const key = track.title ?? track.path.split("/").pop();
  titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
}
const seed = library.tracks.find((track) => (track.duration_ms ?? 0) > 30000 && titleCounts.get(track.title ?? "") === 1) ?? library.tracks[0];
const seedTitle = seed.title ?? seed.path.split("/").pop();
const seedRow = page
  .locator(".sr-dj-library .sr-dj-row")
  .filter({ has: page.locator(".sr-dj-row-title", { hasText: new RegExp(`^${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) })
  .first();
await seedRow.locator("button", { hasText: "装到 A" }).click();
await page.waitForTimeout(6000); // 装台 + 300ms 防抖 + suggest_next

// ① 5 条建议，每条都有理由文字
const suggestionRows = page.locator(".sr-dj-suggest .sr-dj-row");
const suggestionCount = await suggestionRows.count();
const reasonCounts = [];
for (let index = 0; index < suggestionCount; index += 1) {
  reasonCounts.push(await suggestionRows.nth(index).locator(".sr-dj-reasons > *").count());
}
const allHaveReasons = suggestionCount > 0 && reasonCounts.every((count) => count > 0);
check("① 5 条建议，每条带理由文字", suggestionCount === 5 && allHaveReasons, `建议 ${suggestionCount} 条，理由条数 ${reasonCounts.join("/")}`);

// ② 存 crate → crate_list 条数对
await page.getByLabel("crate 名").fill(CRATE_NAME);
await page.locator(".sr-dj-crates button", { hasText: "存入" }).click();
await page.waitForTimeout(2500);
const crates = await callTool("library", "crate_list", {});
const mine = (crates.crates ?? []).find((crate) => crate.name === CRATE_NAME);
const chipTracks = mine ? await page.locator(".sr-dj-crate-item", { hasText: CRATE_NAME }).locator(".sr-dj-count").innerText() : "—";
check("② 存 crate → crate_list 条数对", Boolean(mine) && mine.tracks === 1 && chipTracks.trim() === "1", `crate_list 里 ${mine?.name} = ${mine?.tracks} 首，芯片显示 ${chipTracks.trim()}`);

// ③ 导出 m3u → 行数 = 1 + 2×曲数
await page.locator(".sr-dj-crate-item", { hasText: CRATE_NAME }).locator("button", { hasText: "导出 m3u" }).click();
await page.waitForTimeout(2500);
const m3uPath = `/Users/lazora/Documents/ShadowRoom/exports/${CRATE_NAME}.m3u`;
let lines = [];
if (existsSync(m3uPath)) lines = readFileSync(m3uPath, "utf8").split("\n").filter((line, index, all) => index < all.length - 1 || line !== "");
const expectedLines = 1 + 2 * (mine?.tracks ?? 0);
check("③ 导出 m3u 行数 = 1+2×曲数", lines.length === expectedLines, `${m3uPath} 共 ${lines.length} 行（期望 ${expectedLines}），首行 ${lines[0] ?? "（没文件）"}`);

// ④ 建议行「装到 B」→ deck B 拿到同一首
const firstSuggestion = suggestionRows.first();
const suggestedTitle = await firstSuggestion.locator(".sr-dj-row-title").innerText();
await firstSuggestion.locator("button", { hasText: "装到 B" }).click();
await page.waitForTimeout(6000);
const deckB = page.locator(".sr-dj-deck").nth(1);
const deckBPath = await deckB.locator(".sr-dj-deck-title").getAttribute("title");
const expected = library.tracks.find((track) => (track.title ?? track.path.split("/").pop()) === suggestedTitle.trim());
check("④ 装到 B → deck B 是同一首", Boolean(expected) && deckBPath === expected.path, `建议「${suggestedTitle.trim()}」→ deck B ${deckBPath?.split("/").pop() ?? "（空）"}`);

check("⑦ 零 console error（P3 部分）", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "没有 error/pageerror");

console.log(`\n汇总: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
console.log(`（临时 crate「${CRATE_NAME}」与导出的 m3u 由脚本外清理）`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
