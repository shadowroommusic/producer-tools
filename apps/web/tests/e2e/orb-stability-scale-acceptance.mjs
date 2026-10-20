/**
 * Voice-orb stability, scale and handshake acceptance.
 *
 * Covers the user-visible regressions directly:
 *   - scrolling any page never moves the fixed orb;
 *   - the five scale stops, minimum hit target and persistence;
 *   - the slower 1100ms/800ms call handshake and reduced-motion fast path.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.ORB_STABILITY_BASE ?? "http://127.0.0.1:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/orb-stability-20261020";
const PAGES = ["workbench", "conversation", "studio", "dj", "library", "settings", "plugins"];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1092, height: 605 },
];
const SCALE_STOPS = [0.25, 0.5, 0.75, 1, 1.25];

mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

for (const viewport of VIEWPORTS) {
  for (const view of PAGES) {
    const context = await browser.newContext({ viewport, permissions: ["microphone"] });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ view }) => {
      localStorage.setItem("shadowroom.view", view);
      localStorage.setItem("shadowroom.orb.position", JSON.stringify({ x: 820, y: 360 }));
      localStorage.removeItem("shadowroom.orb.scale.v1");
      localStorage.removeItem("shadowroom.orb.hidden.v1");
    }, { view });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sr-orb", { timeout: 20000 });
    await page.waitForTimeout(350);

    const read = () =>
      page.evaluate(() => {
        const orb = document.querySelector(".sr-orb");
        if (!(orb instanceof HTMLElement)) return null;
        const rect = orb.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          stored: localStorage.getItem("shadowroom.orb.position"),
        };
      });
    const before = await read();
    let maxDx = 0;
    let maxDy = 0;
    for (let step = 0; step < 8; step += 1) {
      await page.evaluate((delta) => {
        const containers = [...document.querySelectorAll("*")].filter((element) => {
          if (element.closest(".sr-orb")) return false;
          return element.scrollHeight > element.clientHeight + 24;
        });
        const container = containers.find((element) => {
          const style = getComputedStyle(element);
          return /(auto|scroll)/.test(style.overflowY);
        });
        if (container) container.scrollTop += delta;
        window.scrollBy(0, delta);
      }, 180);
      await page.waitForTimeout(45);
      const current = await read();
      if (before !== null && current !== null) {
        maxDx = Math.max(maxDx, Math.abs(current.x - before.x));
        maxDy = Math.max(maxDy, Math.abs(current.y - before.y));
      }
    }
    const after = await read();
    check(
      `滚动不漂移 ${viewport.width} ${view}`,
      before !== null &&
        after !== null &&
        maxDx <= 1 &&
        maxDy <= 1 &&
        before.stored === after.stored &&
        errors.length === 0,
      `Δx=${maxDx.toFixed(2)} Δy=${maxDy.toFixed(2)} storedChanged=${before?.stored !== after?.stored} errors=${errors.length}`,
    );
    await context.close();
  }
}

{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__orb_scale_seeded")) {
      localStorage.setItem("shadowroom.view", "workbench");
      localStorage.removeItem("shadowroom.orb.position");
      localStorage.removeItem("shadowroom.orb.scale.v1");
      localStorage.removeItem("shadowroom.orb.hidden.v1");
      sessionStorage.setItem("__orb_scale_seeded", "1");
    }
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-ball canvas", { timeout: 20000 });
  await page.waitForTimeout(350);

  const openMenu = async () => {
    const box = await page.locator(".sr-orb-ball").boundingBox();
    if (box === null) throw new Error("orb has no box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await page.waitForSelector(".sr-orb-menu", { timeout: 3000 });
  };
  const metrics = () =>
    page.evaluate(() => {
      const rect = document.querySelector(".sr-orb");
      const hit = document.querySelector(".sr-orb-ball");
      const visual = document.querySelector(".sr-orb-visual");
      if (!(rect instanceof HTMLElement) || !(hit instanceof HTMLElement) || !(visual instanceof HTMLElement)) return null;
      const r = rect.getBoundingClientRect();
      const b = hit.getBoundingClientRect();
      const v = visual.getBoundingClientRect();
      return {
        root: r.width,
        hit: b.width,
        visual: v.width,
        scale: localStorage.getItem("shadowroom.orb.scale.v1"),
      };
    });

  await openMenu();
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("menuitem", { name: "缩小悬浮球" }).click();
  }
  await page.waitForTimeout(80);
  const small = await metrics();
  check(
    "最小档 25%：视觉约 21px、命中至少 32px",
    small !== null && Math.abs(small.visual - 21) <= 1 && small.hit >= 32 && small.scale === "0.25",
    JSON.stringify(small),
  );
  await page.screenshot({ path: `${SHOTS}/scale-25.png` });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb");
  await page.waitForTimeout(250);
  const persisted = await metrics();
  check(
    "缩放刷新后保持 25%",
    persisted !== null && Math.abs(persisted.visual - 21) <= 1 && persisted.hit >= 32 && persisted.scale === "0.25",
    JSON.stringify(persisted),
  );

  const observed = [];
  for (const expected of [0.5, 0.75, 1, 1.25]) {
    await openMenu();
    await page.getByRole("menuitem", { name: "放大悬浮球" }).click();
    await page.waitForTimeout(60);
    const current = await metrics();
    observed.push({ expected, current });
    await page.keyboard.press("Escape");
  }
  const expectedSizes = [42, 63, 84, 105];
  check(
    "其余四档尺寸为 42 / 63 / 84 / 105px",
    observed.every((item, index) => item.current !== null && Math.abs(item.current.visual - expectedSizes[index]) <= 1),
    JSON.stringify(observed.map((item) => item.current)),
  );

  await page.evaluate(() => localStorage.setItem("shadowroom.orb.scale.v1", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-ball canvas");
  await page.waitForTimeout(300);
  const ball = page.locator(".sr-orb-ball");
  await ball.click();
  await page.waitForFunction(() => document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "opening");
  // App.startCall waits for getUserMedia before flipping voiceMode, so measure the transition itself.
  const openedAt = Date.now();
  await page.waitForFunction(() => document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "open", null, {
    timeout: 3000,
  });
  const openedMs = Date.now() - openedAt;
  check("开始通话约 1100ms", openedMs >= 1020 && openedMs <= 1250, `${openedMs}ms`);

  await openMenu();
  await page.getByRole("menuitem", { name: "结束通话" }).click();
  await page.waitForFunction(() => document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "closing");
  const endedAt = Date.now();
  await page.waitForFunction(
    () => document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "idle",
    null,
    { timeout: 2500 },
  );
  const closedMs = Date.now() - endedAt;
  check("挂断约 800ms", closedMs >= 720 && closedMs <= 1000, `${closedMs}ms`);
  await page.screenshot({ path: `${SHOTS}/handshake-settled.png` });
  await context.close();
}

{
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("shadowroom.view", "workbench");
    localStorage.removeItem("shadowroom.orb.position");
    localStorage.removeItem("shadowroom.orb.scale.v1");
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-ball canvas");
  const durations = await page.evaluate(() => {
    const orb = document.querySelector(".sr-orb");
    const ball = document.querySelector(".sr-orb-ball");
    return [orb, ball].filter(Boolean).map((element) => getComputedStyle(element).transitionDuration);
  });
  check(
    "reduced-motion 无几何过渡",
    durations.length === 2 && durations.every((value) => value.split(", ").every((part) => part === "0s")),
    durations.join(" / "),
  );
  await context.close();
}

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
