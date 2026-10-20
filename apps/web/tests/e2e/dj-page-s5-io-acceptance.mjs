// S5 acceptance — import a set onto the board, export it as m3u.
//
// Rebuilt 2026-09-25 from the script Codex ran for the S5 verification (10/10) after the
// /tmp copy was lost to a reboot; the numbers it asserts were re-measured on the rebuilt file.
//
// Needs: vite on :5173, mcp bridge on :8787, the "S5 验收场" set already imported into
// ~/Documents/ShadowRoom/_library/library.db (4 tracks, ids 2/4/6/8).
// Run: node apps/web/tests/e2e/dj-page-s5-io-acceptance.mjs
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
  window.localStorage.removeItem("shadowroom.setdraft");
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-library .sr-dj-row", { timeout: 30000 });
await page.waitForTimeout(1200);

// 前置自检（2026-10-20）：「S5 验收场」set 与 2/4/6/8 号曲目是 2026-09-25 的验收 fixture；
// 10-20 换 51 首 FLAC 真库后两者都不在库里。fixture 缺失时 SKIP 并说明，不误报产品回归。
// 恢复方法：按库页 spec 重新导入那份 Rekordbox XML（或等 fixture 库回归）。
{
  const response = await fetch("http://127.0.0.1:8787/api/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server: "library", tool: "set_list", arguments: {} }),
  });
  const payload = await response.json();
  const sets = JSON.parse(typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result)).sets ?? [];
  if (!sets.some((row) => (row.name ?? "").includes("S5 验收场"))) {
    console.log(`SKIP  前置缺失：库里没有「S5 验收场」set（现有 ${sets.length} 个 set）——fixture 未随 2026-10-20 真库迁移恢复，非产品回归。`);
    console.log("\n汇总: SKIP 0/0（前置缺失）");
    await browser.close();
    process.exit(0);
  }
}

// ① 导入 set：打开选择器 → 选「S5 验收场」→ 看板 = 4 行、按 track_id 对得上
// 2026-10-19 起「导入 set」收进 ⋯ More 菜单（2026-10-20 修复：先开菜单再点 menuitem）
const openMore = async () => {
  await page.getByRole("button", { name: "更多 Set 操作" }).click();
  await page.waitForSelector(".sr-dj-more-menu", { timeout: 5000 });
};
await openMore();
await page.getByRole("menuitem", { name: "导入 set" }).click();
await page.waitForSelector(".sr-dj-import-row", { timeout: 15000 });
const rowTexts = await page.locator(".sr-dj-import-row").allTextContents();
check("① 选择器列出导入的 set", rowTexts.some((t) => t.includes("S5 验收场") && t.includes("4 首")), JSON.stringify(rowTexts));
await page.locator(".sr-dj-import-row", { hasText: "S5 验收场" }).click();
await page.waitForTimeout(1500);
const boardIds = await page.locator(".sr-dj-board .sr-dj-row").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-track-id")));
const draftIds = await page.evaluate(() => JSON.parse(window.localStorage.getItem("shadowroom.setdraft")).trackIds);
check("② 看板行数 = set 曲目条数", boardIds.length === 4, `board=${boardIds.length}`);
check("③ 每行按 track_id 对得上（不是标题）", JSON.stringify(boardIds) === JSON.stringify(["2", "4", "6", "8"]) && JSON.stringify(draftIds) === JSON.stringify([2, 4, 6, 8]), `board=${JSON.stringify(boardIds)} draft=${JSON.stringify(draftIds)}`);
const setName = await page.locator(".sr-dj-topbar input").first().inputValue();
check("④ set 名跟随导入", setName.includes("S5 验收场"), setName);

// ② 导出 m3u（导入 notice 还在——等它变成「已导出」，不能读旧文本）；同样先开 More 菜单
await openMore();
await page.getByRole("menuitem", { name: "导出 m3u" }).click();
await page.waitForFunction(() => document.querySelector(".sr-dj-notice")?.textContent?.includes("已导出"), null, { timeout: 15000 });
const notice = await page.locator(".sr-dj-notice").textContent();
const pathMatch = notice.match(/→ (.+?\.m3u)/);
check("⑤ 导出提示给出路径", Boolean(pathMatch), notice.trim());
const m3uPath = pathMatch ? pathMatch[1] : "";
check("⑥ 落在 exports/", m3uPath.includes("/exports/"), m3uPath);
// m3u 不是音频，agent bridge 415 不放行——同机直接读盘
import { readFileSync } from "node:fs";
const lines = readFileSync(m3uPath, "utf8").trimEnd().split("\n");
check("⑦ m3u 行数 = 1 + 2×曲数", lines.length === 1 + 2 * 4, `${lines.length} 行`);
check("⑧ m3u 首行 #EXTM3U、歌按顺序", lines[0] === "#EXTM3U" && lines[2].includes("bass-v2") && lines[8].includes("deep-house-128.wav"), lines.slice(0, 3).join(" | "));
const crateCheck = await page.evaluate(async () => {
  const call = async (tool, args) => {
    const r = await fetch("http://127.0.0.1:8787/api/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: "library", tool, arguments: args }),
    });
    const body = await r.json();
    if (body.isError) throw new Error(body.result);
    return JSON.parse(body.result);
  };
  const crates = (await call("crate_list", {})).crates;
  const mine = crates.find((c) => c.name.includes("S5 验收场"));
  return mine ? { name: mine.name, tracks: mine.tracks } : null;
});
check("⑨ set 先落了 crate（4 首）", crateCheck !== null && crateCheck.tracks === 4, JSON.stringify(crateCheck));

check("⑩ 零 console error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length === 0 ? 0 : 1);
