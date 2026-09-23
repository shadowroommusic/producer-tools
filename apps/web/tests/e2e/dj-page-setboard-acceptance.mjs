import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const BRIDGE = "http://127.0.0.1:8787";

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
  return typeof payload.result === "string" ? JSON.parse(payload.result) : payload.result;
}

const library = await callTool("library", "list_tracks", { limit: 200 });
const titleById = new Map(library.tracks.map((t) => [t.id, t.title ?? t.path.split("/").pop()]));
const trackTitle = (id) => titleById.get(Number(id)) ?? `#${id}`;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "dj");
  // 只在第一次加载时清草稿：addInitScript 每次导航都会跑，刷新时清掉会让"刷新后仍在"永远失败
  if (!window.sessionStorage.getItem("__accept_cleared")) {
    window.localStorage.removeItem("shadowroom.setdraft");
    window.sessionStorage.setItem("__accept_cleared", "1");
  }
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });
await page.waitForTimeout(2000);

const boardRows = page.locator(".sr-dj-board .sr-dj-row");
const boardTitles = async () => boardRows.locator(".sr-dj-row-title").allTextContents();
const draft = async () => page.evaluate(() => JSON.parse(window.localStorage.getItem("shadowroom.setdraft") ?? "null"));

// ① 拖一首 + 点「加入」两首 → 3 行
const firstLibraryRow = page.locator(".sr-dj-library .sr-dj-row").first();
const firstLibraryTitle = (await firstLibraryRow.locator(".sr-dj-row-title").innerText()).trim();
await firstLibraryRow.dragTo(page.locator(".sr-dj-board"));
await page.waitForTimeout(800);
const picks = page.locator(".sr-dj-suggest-strip .sr-dj-row");
const pickCount = await picks.count();
for (let i = 0; i < Math.min(2, pickCount); i += 1) {
  await picks.nth(i).locator("button", { hasText: "加入" }).click();
  await page.waitForTimeout(500);
}
const rowsAfterAdd = await boardRows.count();
const draftAfterAdd = await draft();
const topbarText = await page.locator(".sr-dj-topbar").innerText();
check(
  "① 拖入/加入 3 首 = 看板行数 = 草稿 trackIds 数",
  rowsAfterAdd === 3 && draftAfterAdd?.trackIds?.length === 3 && topbarText.includes("3"),
  `行数 ${rowsAfterAdd}，草稿 ${draftAfterAdd?.trackIds?.length}，顶栏「${topbarText.replace(/\s+/g, " ").slice(0, 40)}」，首发=${firstLibraryTitle}`,
);

// ② 拖排序 + 刷新仍在
const orderBefore = await boardTitles();
await boardRows.last().dragTo(boardRows.first());
await page.waitForTimeout(900);
const orderAfterDrag = await boardTitles();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });
await page.waitForTimeout(2500);
const orderAfterReload = await boardTitles();
const moved = orderAfterDrag[0] === orderBefore.at(-1);
check(
  "② 拖排序生效且刷新后保持",
  moved && JSON.stringify(orderAfterReload) === JSON.stringify(orderAfterDrag),
  `排序前 ${orderBefore.join(" | ")} → 拖后 ${orderAfterDrag.join(" | ")} → 刷新后 ${orderAfterReload.join(" | ")}`,
);

// ③ 推荐 3 条、每条有理由、且都不在 set 里（按 id / 标题双断言）
const pickBadges = page.locator(".sr-dj-badge-pick");
const badgeCount = await pickBadges.count();
const pickRows = page.locator(".sr-dj-suggest-strip .sr-dj-row");
const pickTitles = (await pickRows.locator(".sr-dj-row-title").allTextContents()).map((t) => t.trim());
const reasonsPerPick = [];
for (let i = 0; i < await pickRows.count(); i += 1) {
  reasonsPerPick.push(await pickRows.nth(i).locator(".sr-dj-reason").count());
}
const setTitles = new Set(orderAfterReload);
const overlap = pickTitles.filter((t) => setTitles.has(t));
const draftNow = await draft();
const setIds = new Set((draftNow?.trackIds ?? []).map(Number));
const pickIdsInSet = [...setIds].filter((id) => pickTitles.includes(trackTitle(id)));
check(
  "③ 推荐恰 3 条、每条带理由、且不在 set 内",
  badgeCount === 3 && reasonsPerPick.every((n) => n >= 1) && overlap.length === 0 && pickIdsInSet.length === 0,
  `推荐 chip ${badgeCount} 个，理由条数 ${reasonsPerPick.join("/")}，与 set 重名 ${overlap.length}，set 内 id 出现在推荐里 ${pickIdsInSet.length}`,
);

// ④ 点行载入 → 播放 → 走带前进
await boardRows.first().click();
await page.waitForTimeout(3000);
const playButton = page.locator(".sr-dj-deck button[aria-label^='播放']").first();
let loaded = true;
try {
  await page.waitForFunction(() => {
    const button = document.querySelector(".sr-dj-deck button[aria-label^='播放']");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 45000 });
} catch { loaded = false; }
const clockBefore = await page.locator(".sr-dj-clock").first().innerText();
if (loaded) {
  await playButton.click();
  await page.waitForTimeout(2200);
}
const clockAfter = await page.locator(".sr-dj-clock").first().innerText();
const toSeconds = (text) => { const [m, s] = text.trim().split(":").map(Number); return m * 60 + s; };
const advanced = toSeconds(clockAfter) - toSeconds(clockBefore) >= 1;
// 暂停后必须冻结
if (loaded) await page.locator(".sr-dj-deck button[aria-label^='暂停']").first().click();
await page.waitForTimeout(300);
const clockPaused = await page.locator(".sr-dj-clock").first().innerText();
await page.waitForTimeout(900);
const clockPausedAgain = await page.locator(".sr-dj-clock").first().innerText();
const frozen = clockPaused === clockPausedAgain;
// +4 拍 seek 必须立刻反映
await page.locator(".sr-dj-deck .sr-page-action", { hasText: "+4" }).first().click();
await page.waitForTimeout(400);
const clockSeeked = await page.locator(".sr-dj-clock").first().innerText();
const seeked = toSeconds(clockSeeked) > toSeconds(clockPausedAgain);
check(
  "④ 走带：播放前进 + 暂停冻结 + seek 立刻反映",
  loaded && advanced && frozen && seeked,
  `载入=${loaded}，播放 ${clockBefore}→${clockAfter}（前进=${advanced}），暂停后 ${clockPaused}→${clockPausedAgain}（冻结=${frozen}），+4拍后 ${clockSeeked}（反映=${seeked}）`,
);

// ⑤ 新建 set → 行数归零、草稿重置
await page.locator("button", { hasText: "新建 set" }).first().click();
await page.waitForTimeout(800);
const rowsAfterNew = await boardRows.count();
const draftAfterNew = await draft();
check(
  "⑤ 新建 set → 行数归零、草稿重置",
  rowsAfterNew === 0 && (draftAfterNew?.trackIds ?? []).length === 0,
  `行数 ${rowsAfterNew}，草稿 trackIds ${(draftAfterNew?.trackIds ?? []).length}`,
);

check("⑥ 零 console error", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "没有 error/pageerror");

console.log(`\n汇总: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
