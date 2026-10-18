/**
 * Studio UI refresh acceptance (2026-10-19).
 *
 * User contract: project identity is visible, the empty state is the creation surface, the left
 * sound/scratch tools are overlay drawers that can always close, and the global butler CTA opens the
 * actual orb composer instead of pretending a handoff happened.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.STUDIO_UI_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/studio-ui-20261019";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function studioPage(width, height, tracks = []) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript((seed) => {
    localStorage.setItem("shadowroom.view", "studio");
    localStorage.setItem(
      "shadowroom.studio.projects.v1",
      JSON.stringify({ projects: [{ id: "p-ui", name: "空工程验收", updatedAt: 1, bpm: 124, key: "8A", bars: 32, tracks: seed }] }),
    );
    localStorage.setItem("shadowroom.studio.open", "p-ui");
  }, tracks);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-studio-head", { timeout: 15000 });
  await page.waitForTimeout(450);
  return { page, errors };
}

try {
  const { page, errors } = await studioPage(1440, 900);
  const header = await page.evaluate(() => ({
    name: document.querySelector(".sr-studio-name")?.textContent ?? "",
    clock: document.querySelector(".sr-studio-clock")?.textContent ?? "",
    rail: document.querySelectorAll(".sr-studio-rail-btn").length,
    hero: document.querySelectorAll(".sr-studio-hero-card").length,
    overflow: document.querySelector(".sr-studio")?.scrollWidth - document.querySelector(".sr-studio").clientWidth,
  }));
  check(
    "① 两层顶栏显示工程名、10 分钟上限与统一左 rail",
    header.name === "空工程验收" && header.clock.includes("10:00") && header.rail === 2 && header.hero === 1 && header.overflow <= 1,
    JSON.stringify(header),
  );

  const beforeWidth = await page.locator(".sr-studio-timeline").evaluate((el) => el.getBoundingClientRect().width);
  await page.locator(".sr-sounds-rail").click();
  await page.waitForSelector(".sr-studio-drawer.sr-sounds");
  const afterWidth = await page.locator(".sr-studio-timeline").evaluate((el) => el.getBoundingClientRect().width);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".sr-studio-drawer.sr-sounds").length === 0);
  check(
    "② 音色抽屉覆盖不挤时间线，Esc 可收起",
    Math.abs(beforeWidth - afterWidth) <= 1 && (await page.locator(".sr-studio-drawer").count()) === 0,
    `timeline ${beforeWidth}→${afterWidth}`,
  );

  await page.getByRole("button", { name: "让管家来做" }).click();
  const prompt = await page.locator(".sr-orb-input input").inputValue();
  check(
    "③ “让管家来做”实际打开全局管家并带入工程上下文",
    (await page.locator(".sr-orb-panel").count()) === 1 && prompt.includes("空工程验收"),
    prompt,
  );
  await page.screenshot({ path: `${SHOTS}/studio-1440.png` });
  check("④ 1440 流程零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  await page.close();

  const compact = await studioPage(1092, 605, [
    { id: "t-lead", name: "Lead", muted: false, soloed: false, volume: 80, type: "instrument", color: 1, clips: [] },
    { id: "t-drums", name: "Drums", muted: false, soloed: false, volume: 90, type: "drums", color: 2, clips: [] },
  ]);
  const compactMetrics = await compact.page.evaluate(() => {
    const root = document.querySelector(".sr-studio");
    const transport = document.querySelector(".sr-studio-transport")?.getBoundingClientRect();
    return {
      overflow: root === null ? -1 : root.scrollWidth - root.clientWidth,
      transportBottom: transport?.bottom ?? -1,
      tracks: document.querySelectorAll(".sr-track-head").length,
      actionVisible: document.querySelector(".sr-studio-export") !== null,
      moreVisible: document.querySelector('[aria-label="更多操作"]') !== null,
    };
  });
  check(
    "⑤ 1092×605 有轨工程无横向溢出，核心动作和 More 都可见",
    compactMetrics.overflow <= 1 &&
      compactMetrics.transportBottom < 260 &&
      compactMetrics.tracks === 2 &&
      compactMetrics.actionVisible &&
      compactMetrics.moreVisible &&
      compact.errors.length === 0,
    JSON.stringify({ ...compactMetrics, errors: compact.errors }),
  );
  await compact.page.screenshot({ path: `${SHOTS}/studio-1092.png` });
  await compact.page.close();
} finally {
  await browser.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
