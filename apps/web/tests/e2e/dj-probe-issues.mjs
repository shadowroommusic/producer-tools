// 复现 Codex 用户巡检里发现的 DJ 页问题，逐条给数字（用于派单/复验）。
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "dj");
  window.localStorage.removeItem("shadowroom.setdraft");
  // D2 验收测的是默认位置：先清掉历史拖动留下的坐标。
  window.localStorage.removeItem("shadowroom.orb.position");
});
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-library .sr-dj-row", { timeout: 30000 });
await page.waitForTimeout(1200);

const deckTitle = () => page.locator(".sr-dj-deck-title").first().innerText().catch(() => "?");
const cueAddDisabled = () => page.locator("button", { hasText: "打点" }).first().isDisabled().catch(() => null);

// ① 点行是否载入
console.log("① 点行前 deck =", JSON.stringify(await deckTitle()), "打点禁用 =", await cueAddDisabled());
await page.locator(".sr-dj-library .sr-dj-row").first().click();
await page.waitForTimeout(1800);
console.log("① 点行后 deck =", JSON.stringify(await deckTitle()), "打点禁用 =", await cueAddDisabled());

// ② 点「试听」是否载入
await page.locator(".sr-dj-library .sr-dj-row").first().getByRole("button", { name: "试听" }).click();
await page.waitForTimeout(2500);
console.log("② 点试听后 deck =", JSON.stringify(await deckTitle()), "打点禁用 =", await cueAddDisabled());

// ③ 导入 set 面板：等 6 秒，数行数
await page.getByRole("button", { name: "导入 set" }).click();
await page.waitForTimeout(6000);
const importRows = await page.locator(".sr-dj-import-row").count();
const panelBox = await page.locator(".sr-dj-import, .sr-dj-import-row").first().boundingBox().catch(() => null);
console.log("③ 导入 set：行数 =", importRows, "面板高度 =", panelBox ? Math.round(panelBox.height) : "无元素");

// ④ 推荐理由是否被裁切（比较滚动高度与可见高度）
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(500);
const clip = await page.evaluate(() => {
  const box = document.querySelector(".sr-dj-suggest-strip, .sr-dj-suggest");
  if (!box) return "无推荐容器";
  return { scrollH: box.scrollHeight, clientH: box.clientHeight, clipped: box.scrollHeight > box.clientHeight + 1 };
});
console.log("④ 推荐理由容器 =", JSON.stringify(clip));

// ⑤ 悬浮球覆盖了谁（球矩形 vs 关键区域）
const orb = await page.evaluate(() => {
  const el = document.querySelector(".sr-orb, [class*=orb]");
  if (!el) return "无球";
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), 中心命中: hit ? hit.className || hit.tagName : null };
});
console.log("⑤ 悬浮球 =", JSON.stringify(orb));
console.log("console errors:", errs.length);
await browser.close();
