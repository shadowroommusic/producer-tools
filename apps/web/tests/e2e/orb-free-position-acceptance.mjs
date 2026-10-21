/**
 * User-owned orb placement acceptance.
 *
 * The orb is deliberately allowed to overlap any control. Once the user puts it somewhere,
 * navigation, dock changes, busy states and window growth must not move it. Only viewport or orb
 * size changes that would leave the orb partially off-screen may clamp it back.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.ORB_FREE_POSITION_BASE ?? "http://127.0.0.1:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb", { timeout: 20_000 });
await page.waitForTimeout(350);

const readOrb = () =>
  page.evaluate(() => {
    const root = document.querySelector(".sr-orb");
    if (!(root instanceof HTMLElement)) return null;
    const rect = root.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
      stored: localStorage.getItem("shadowroom.orb.position"),
    };
  });
const samePosition = (a, b, tolerance = 1) =>
  a !== null && b !== null && Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

// Fresh install: visual anchor is bottom-centre, not a corner or a control-aware slot.
await page.evaluate(() => {
  localStorage.removeItem("shadowroom.orb.position");
  localStorage.setItem("shadowroom.orb.scale.v1", "1");
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb");
await page.waitForTimeout(250);
const fresh = await readOrb();
const expectedDefault = { x: (1440 - 84) / 2, y: 900 - 84 - 140 };
check(
  "首次出现位于屏幕中下方",
  fresh !== null &&
    Math.abs(fresh.x - expectedDefault.x) <= 1 &&
    Math.abs(fresh.y - expectedDefault.y) <= 1,
  `actual=${fresh ? `${fresh.x},${fresh.y}` : "null"} expected=${expectedDefault.x},${expectedDefault.y}`,
);

// Put the orb directly over 新建工程. No protection may shove it away.
const target = await page.evaluate(() => {
  const button = document.querySelector(".sr-new-session")?.getBoundingClientRect();
  if (!button) return null;
  const position = { x: Math.round(button.x + 6), y: Math.round(button.y + 6) };
  localStorage.setItem("shadowroom.orb.position", JSON.stringify(position));
  return position;
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb");
await page.waitForTimeout(250);
const placed = await readOrb();
check(
  "用户位置不许因覆盖控件而被自动避让",
  target !== null && placed !== null && Math.abs(placed.x - target.x) <= 1 && Math.abs(placed.y - target.y) <= 1,
  `target=${JSON.stringify(target)} actual=${placed ? `${placed.x},${placed.y}` : "null"}`,
);

const stay = [];
for (const name of ["Studio", "DJ", "曲目库", "设置"]) {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(300);
  stay.push({ name, orb: await readOrb() });
}
await page.getByRole("button", { name: /插件.*9\/9/ }).first().click();
await page.waitForTimeout(300);
stay.push({ name: "插件", orb: await readOrb() });
check(
  "跨全部页面位置完全不变",
  stay.every((entry) => samePosition(placed, entry.orb)),
  stay.map((entry) => `${entry.name}:${entry.orb ? `${entry.orb.x},${entry.orb.y}` : "null"}`).join(" | "),
);

await page.getByRole("button", { name: "Studio", exact: true }).first().click();
await page.waitForTimeout(250);
const beforeDock = await readOrb();
const rail = page.locator(".sr-dock-rail-btn").first();
if (await rail.isVisible()) {
  await rail.click();
  await page.waitForTimeout(450);
}
const afterDock = await readOrb();
check(
  "打开或关闭右侧对话不改球位置",
  samePosition(beforeDock, afterDock),
  `before=${beforeDock ? `${beforeDock.x},${beforeDock.y}` : "null"} after=${afterDock ? `${afterDock.x},${afterDock.y}` : "null"}`,
);

await page.setViewportSize({ width: 1128, height: 765 });
await page.waitForTimeout(250);
const resizedInside = await readOrb();
check(
  "窗口缩小后只要仍完整可见就不移动",
  samePosition(afterDock, resizedInside),
  `before=${afterDock ? `${afterDock.x},${afterDock.y}` : "null"} after=${resizedInside ? `${resizedInside.x},${resizedInside.y}` : "null"}`,
);

await page.evaluate(() => {
  localStorage.setItem("shadowroom.orb.position", JSON.stringify({ x: 900, y: 600 }));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb");
await page.waitForTimeout(250);
const nearEdge = await readOrb();
await page.setViewportSize({ width: 300, height: 180 });
await page.waitForTimeout(300);
const clipped = await readOrb();
const expectedClip =
  clipped === null
    ? null
    : {
        x: Math.max(12, 300 - clipped.w - 12),
        y: Math.max(12, 180 - clipped.h - 12),
      };
check(
  "窗口过小时仅夹回视口内",
  nearEdge !== null &&
    clipped !== null &&
    expectedClip !== null &&
    Math.abs(clipped.x - expectedClip.x) <= 1 &&
    Math.abs(clipped.y - expectedClip.y) <= 1,
  `before=${nearEdge ? `${nearEdge.x},${nearEdge.y}` : "null"} actual=${clipped ? `${clipped.x},${clipped.y}` : "null"} expected=${JSON.stringify(expectedClip)}`,
);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb");
await page.waitForTimeout(250);
const refreshed = await readOrb();
check(
  "刷新后恢复用户自己的位置",
  samePosition(clipped, refreshed),
  `before=${clipped ? `${clipped.x},${clipped.y}` : "null"} after=${refreshed ? `${refreshed.x},${refreshed.y}` : "null"}`,
);
check("全程 Console error 0", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await context.close();
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
