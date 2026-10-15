// 真人用户巡检（Codex 2026-09-25 起）：像用户一样把 DJ 页和 Studio 页各走一遍，
// 每一步截图 + 收集 console error + 记录"点了没反应"的死按钮。
//
// 用法：node apps/web/tests/e2e/user-pass-dj-studio.mjs [输出目录]
// 需要：vite :5173、mcp 桥 :8787、agent 桥 :8788，以及库里已有素材。
//
// 2026-10-16 修订（Codex）：① Studio 段先点「新建工程」再走（此前缺这一步，后三段的报错全是选择器空找）；
// ② DJ 行改点标题 span（行中心命中「试听」按钮，会把"载入"悄悄变成"载入+播放"）；
// ③ 走带断言改成读秒增量 vs 墙钟；④ 打点步骤转只读——它写真实曲库，巡检不该留痕
// （cue 编辑的写入语义由 dj-page-*-acceptance 在 fixture 上覆盖）。
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

// 点一行载入播放器：优先挑 ≥1 分钟的曲目（3 秒的短文件在 4 秒采样窗口里就放完了，读秒 Δ 恒为 0 没有信号）
try {
  const rows_ = page.locator(".sr-dj-library .sr-dj-row");
  const count = await rows_.count();
  let pick = 0;
  for (let i = 0; i < count; i += 1) {
    const text = (await rows_.nth(i).locator(".sr-dj-row-time").innerText().catch(() => "—")).trim();
    const m = text.match(/^(\d+):(\d{2})$/);
    if (m !== null && Number(m[1]) * 60 + Number(m[2]) >= 60) { pick = i; break; }
  }
  // 点标题 span = 纯载入（onOpen），不自动播放；行中心会命中「试听」按钮。
  await rows_.nth(pick).locator(".sr-dj-row-title").click();
  await page.waitForTimeout(1500);
  await shot("dj-03-loaded");
  const title = await page.locator(".sr-dj-deck-title, .sr-dj-deck").first().innerText();
  note(`载入后播放器（第 ${pick + 1} 行）：` + title.split("\n").slice(0, 3).join(" / "));
} catch (e) { note("载入失败：" + e.message); }

// 播放 3 秒看走带（读秒增量必须≈墙钟增量——这是用户报过的那类 bug 的哨兵）
try {
  // 走带的播/停在 transport 上是 icon 按钮（DjPage 106–1050 行），只有 aria-label，没有文字——
  // 按文字过滤永远点不到（旧脚本的误报）。aria-label 随状态在「播放/暂停」之间切。
  const transport = page.locator('button[aria-label="播放"], button[aria-label="暂停"]').first();
  if (await transport.isDisabled()) {
    note("走带禁用：deck 未就绪（多半是素材文件不在场），跳过播放与打点");
  } else {
    const readClock = async () => (await page.locator(".sr-dj-clock").first().innerText().catch(() => "?")).trim();
    const parse = (text) => {
      const m = String(text).match(/(\d+):(\d{2})/);
      return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
    };
    if ((await transport.getAttribute("aria-label")) === "暂停") await transport.click(); // 收敛到停
    const before = await readClock();
    await transport.click({ timeout: 5000 });
    const wall0 = Date.now();
    await page.waitForTimeout(4000);
    await shot("dj-04-playing");
    const wall = (Date.now() - wall0) / 1000;
    const after = await readClock();
    const delta = parse(after) !== null && parse(before) !== null ? parse(after) - parse(before) : null;
    const ended = (await transport.getAttribute("aria-label")) !== "暂停";
    note(
      `走带：${before} → ${after}（墙钟 ${wall.toFixed(1)}s，读秒 Δ=${delta === null ? "?" : delta}s${ended ? "，采样窗口内已放完" : ""}）`,
    );
  }
} catch (e) { note("播放按钮点不到：" + e.message); }

// 打一个点
// 只读：打点会写进真实 library.db，巡检不留痕。
try {
  const add = page.locator(".sr-dj-cue-add").first();
  const cues = await page.locator(".sr-dj-cue").count();
  note(`cue 列表 ${cues} 条；打点按钮 ${(await add.isDisabled()) ? "禁用（deck 未就绪）" : "可用"}（只读巡检，不写入）`);
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

// Studio 现在先落在工程列表：导入/播放/轨道控件都要先有一个打开的工程。
// 像用户一样先点「新建工程」，再往下走——之前的版本在这个脚本里漏了这一步，
// 后三段的报错全是「没进工程」（选择器找不到），不是按钮坏了。
try {
  const fresh = page.locator(".sr-project-new");
  if ((await fresh.count()) > 0) {
    await fresh.first().click();
    await page.waitForTimeout(1500);
    await shot("studio-01b-new-project");
  }
} catch (e) { note("新建工程失败：" + e.message); }

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
