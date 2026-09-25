// Studio 页用户巡检：先建工程，再导入/播放/右键/导出，逐步截图 + 记问题。
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/Users/lazora/Documents/ShadowRoom/exports/user-pass-studio";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "studio");
  window.localStorage.removeItem("shadowroom.studio.projects.v1");
});
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/01-land.png` });

// 建工程
try {
  await page.getByText("新建工程").first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/02-new-project.png` });
  console.log("工程已建，轨道区元素数 =", await page.locator(".sr-studio-track, .sr-track-head").count());
} catch (e) { console.log("建工程失败：" + e.message); }

// 导入音频
try {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles("/Users/lazora/Documents/ShadowRoom/recordings/lofi-groove.wav", { timeout: 20000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/03-imported.png` });
  console.log("导入后轨道数 =", await page.locator(".sr-studio-track, .sr-track-head").count());
} catch (e) { console.log("导入失败：" + e.message); }

// 播放
try {
  await page.locator("button").filter({ hasText: /^▶/ }).first().click({ timeout: 5000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/04-playing.png` });
  const t = await page.locator(".sr-studio-transport").first().innerText();
  console.log("播放中走带 =", JSON.stringify(t.split("\n").slice(0, 4).join(" ")));
} catch (e) { console.log("播放失败：" + e.message); }

// 停止 + 右键轨道
try {
  await page.locator('button[aria-label="停止"]').first().click({ timeout: 5000 });
  await page.waitForTimeout(800);
  await page.locator(".sr-studio-track, .sr-track-head").first().click({ button: "right", timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/05-track-menu.png` });
  console.log("右键菜单项 =", await page.locator('[role="menu"] >> text=/./').count());
} catch (e) { console.log("右键失败：" + e.message); }

// 悬浮球是否遮挡
const orb = await page.evaluate(() => {
  const el = document.querySelector("[class*=orb]");
  if (!el) return "无球";
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
console.log("悬浮球 =", JSON.stringify(orb), "console errors =", errs.length);
await browser.close();
