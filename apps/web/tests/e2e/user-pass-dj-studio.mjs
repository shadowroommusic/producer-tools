// 真人用户巡检（Codex 2026-09-25 起）：像用户一样把 DJ 页和 Studio 页各走一遍，
// 每一步截图 + 收集 console error + 记录"点了没反应"的死按钮。
//
// 用法：node apps/web/tests/e2e/user-pass-dj-studio.mjs [输出目录]
// 需要：vite :5173、mcp 桥 :8787、agent 桥 :8788，以及库里已有素材。
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/Users/lazora/Documents/ShadowRoom/exports/user-pass";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  permissions: ["microphone"],
});
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

let n = 0;
const shot = async (name) => { n += 1; await page.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}.png` }); };
const notes = [];
const note = (s) => { notes.push(s); console.log("NOTE " + s); };

const goto = async (view) => {
  await page.addInitScript((v) => window.localStorage.setItem("shadowroom.view", v), view);
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
};

// ————————————————————————— DJ 页 —————————————————————————
await goto("dj");
await page.waitForSelector(".sr-dj-library .sr-dj-row", { timeout: 30000 });
await page.waitForTimeout(800);
await shot("dj-01-land");

// 筛选
try {
  const search = page.locator(".sr-dj-library input").first();
  await search.fill("deep");
  await page.waitForTimeout(700);
  await shot("dj-02-filter-deep");
  const rows = await page.locator(".sr-dj-library .sr-dj-row").count();
  note(`筛选 deep 后 ${rows} 行`);
  await search.fill("");
  await page.waitForTimeout(500);
} catch (e) { note("筛选失败：" + e.message); }

// 点一行载入播放器
try {
  await page.locator(".sr-dj-library .sr-dj-row").first().click();
  await page.waitForTimeout(1500);
  await shot("dj-03-loaded");
  const title = await page.locator(".sr-dj-deck-title, .sr-dj-deck").first().innerText();
  note("载入后播放器：" + title.split("\n").slice(0, 3).join(" / "));
} catch (e) { note("载入失败：" + e.message); }

// 播放 3 秒看走带
try {
  await page.locator(".sr-icon-btn, button").filter({ hasText: /^▶|播放/ }).first().click({ timeout: 5000 });
  await page.waitForTimeout(3000);
  await shot("dj-04-playing");
  const clock = await page.locator(".sr-dj-clock").first().innerText().catch(() => "?");
  note("播放 3 秒后读秒：" + clock.replace(/\n/g, " "));
} catch (e) { note("播放按钮点不到：" + e.message); }

// 打一个点
try {
  const before = await page.locator(".sr-dj-cue").count();
  await page.locator(".sr-dj-cue-add").first().click({ timeout: 5000 });
  await page.waitForTimeout(900);
  const after = await page.locator(".sr-dj-cue").count();
  await shot("dj-05-cue-added");
  note(`打点：${before} → ${after} 条`);
} catch (e) { note("打点失败：" + e.message); }

// AI 设 cue 预览
try {
  await page.locator(".sr-dj-aicue, button").filter({ hasText: "AI 设 cue" }).first().click({ timeout: 5000 });
  await page.waitForTimeout(6000);
  await shot("dj-06-aicue-preview");
  const card = await page.locator(".sr-dj-aicue-list, .sr-dj-aicue-head").count();
  note("AI 设 cue 预览卡元素数：" + card);
} catch (e) { note("AI 设 cue 点不到：" + e.message); }

// 拖一行进看板
try {
  const row = page.locator(".sr-dj-library .sr-dj-row").nth(1);
  const board = page.locator(".sr-dj-board");
  await row.dragTo(board);
  await page.waitForTimeout(1200);
  await shot("dj-07-board-drag");
  const boardRows = await page.locator(".sr-dj-board .sr-dj-row").count();
  note("看板行数：" + boardRows);
} catch (e) { note("拖进看板失败：" + e.message); }

// 推荐
await page.waitForTimeout(1500);
await shot("dj-08-recommend");

// 导入 set / 导出 m3u / AI 排序 / 新建
for (const label of ["导入 set", "AI 排序", "导出 m3u", "新建 set"]) {
  try {
    const btn = page.getByRole("button", { name: label }).first();
    const visible = await btn.count();
    if (!visible) { note(`按钮不存在：${label}`); continue; }
    if (!(await btn.isEnabled())) { note(`按钮禁用：${label}`); continue; }
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(label === "AI 排序" ? 4000 : 1500);
    await shot("dj-09-" + label.replace(/\s/g, "-"));
  } catch (e) { note(`${label} 失败：` + e.message); }
}

// ————————————————————————— Studio 页 —————————————————————————
await goto("studio");
await page.waitForTimeout(1500);
await shot("studio-01-land");

try {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles("/Users/lazora/Documents/ShadowRoom/recordings/lofi-groove.wav");
  await page.waitForTimeout(4000);
  await shot("studio-02-imported");
  const tracks = await page.locator(".sr-studio-track, .sr-track-head").count();
  note("导入后轨道数：" + tracks);
} catch (e) { note("导入失败：" + e.message); }

try {
  await page.locator('button[aria-label="播放"], button[aria-label="停止"]').first().click({ timeout: 5000 });
  await page.waitForTimeout(3000);
  await shot("studio-03-playing");
} catch (e) { note("播放失败：" + e.message); }

try {
  const head = page.locator(".sr-studio-track, .sr-track-head").first();
  await head.click({ button: "right", timeout: 5000 });
  await page.waitForTimeout(800);
  await shot("studio-04-track-menu");
} catch (e) { note("右键轨道菜单失败：" + e.message); }

note("console errors: " + consoleErrors.length);
console.log("\n截图目录：" + OUT);
console.log("问题记录：\n" + notes.map((x) => " - " + x).join("\n"));
await browser.close();
