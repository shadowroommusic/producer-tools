/**
 * Butler-orb motion acceptance:
 * - motion is present but deliberately slow rather than visually jittery;
 * - the layered canvas holds a stable 60fps cadence at Retina density;
 * - outer magnetic traces use long, independent periods;
 * - no Console errors while the animation runs.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.ORB_PERF_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/orb-motion-20261020";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem("shadowroom.view", "workbench");
  localStorage.setItem("shadowroom.orb.position", JSON.stringify({ x: 1230, y: 748 }));
  localStorage.setItem("qa-orb-force", "idle");
  localStorage.removeItem("shadowroom.orb.hidden.v1");
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb-canvas", { timeout: 20000 });
await page.waitForTimeout(1400);

const idle = await page.locator(".sr-orb").evaluate((root) => {
  const canvas = root.querySelector("canvas");
  const rect = root.getBoundingClientRect();
  return {
    mode: root.getAttribute("data-mode"),
    size: Math.round(rect.width),
    backing: canvas instanceof HTMLCanvasElement ? [canvas.width, canvas.height] : null,
  };
});
check(
  "① 闲置球保持高分辨率画布",
  idle.mode === "idle" && idle.size === 84 && idle.backing !== null && idle.backing[0] >= idle.size * 2.5,
  JSON.stringify(idle),
);

const motion = await page.evaluate(async () => {
  const canvas = document.querySelector(".sr-orb-canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const snapshot = () => new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data);
  const first = snapshot();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const second = snapshot();
  let difference = 0;
  for (let index = 0; index < first.length; index += 4) {
    difference +=
      (Math.abs(first[index] - second[index]) +
        Math.abs(first[index + 1] - second[index + 1]) +
        Math.abs(first[index + 2] - second[index + 2])) /
      3;
  }
  return difference / (first.length / 4);
});
check(
  "② 700ms 内有连续运动，但平均像素变化保持缓慢",
  motion !== null && motion > 0.08 && motion < 1.35,
  `mean abs diff=${motion?.toFixed(3)}/255（改造前基线 2.517）`,
);

const cadence = await page.evaluate(async () => {
  const intervals = [];
  let previous = performance.now();
  await new Promise((resolve) => {
    let frames = 0;
    const tick = (now) => {
      intervals.push(now - previous);
      previous = now;
      frames += 1;
      if (frames >= 240) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  intervals.shift();
  intervals.sort((a, b) => a - b);
  const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  return {
    frames: intervals.length,
    average,
    p95: intervals[Math.floor(intervals.length * 0.95)],
    max: intervals.at(-1),
    fps: 1000 / average,
  };
});
check(
  "③ 240 帧保持流畅",
  cadence.average <= 17.5 && cadence.p95 <= 18.5 && cadence.fps >= 57,
  `avg=${cadence.average.toFixed(2)}ms, p95=${cadence.p95.toFixed(2)}ms, max=${cadence.max.toFixed(2)}ms, ${cadence.fps.toFixed(1)}fps`,
);

await page.evaluate(() => localStorage.setItem("qa-orb-force", "thinking"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb-canvas", { timeout: 20000 });
await page.waitForTimeout(1400);
const activeCadence = await page.evaluate(async () => {
  const intervals = [];
  let previous = performance.now();
  await new Promise((resolve) => {
    let frames = 0;
    const tick = (now) => {
      intervals.push(now - previous);
      previous = now;
      frames += 1;
      if (frames >= 240) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  intervals.shift();
  intervals.sort((a, b) => a - b);
  const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  return {
    average,
    p95: intervals[Math.floor(intervals.length * 0.95)],
    max: intervals.at(-1),
    fps: 1000 / average,
  };
});
check(
  "④ 最密的 thinking 态仍保持 60fps",
  activeCadence.average <= 17.5 && activeCadence.p95 <= 18.5 && activeCadence.fps >= 57,
  `avg=${activeCadence.average.toFixed(2)}ms, p95=${activeCadence.p95.toFixed(2)}ms, max=${activeCadence.max.toFixed(2)}ms, ${activeCadence.fps.toFixed(1)}fps`,
);

const tracePeriods = await page.locator(".sr-orb-arc").evaluateAll((nodes) =>
  nodes.map((node) => getComputedStyle(node).animationDuration),
);
check(
  "⑤ 外层磁力轨迹使用 24s/38s 慢周期",
  tracePeriods.includes("24s") && tracePeriods.includes("38s"),
  tracePeriods.join(" / "),
);

await page.evaluate(() => localStorage.setItem("qa-orb-force", "idle"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb-canvas", { timeout: 20000 });
await page.waitForTimeout(1000);
await page.locator(".sr-orb").screenshot({ path: `${SHOTS}/idle-refined.png` });
check("⑥ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await browser.close();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
