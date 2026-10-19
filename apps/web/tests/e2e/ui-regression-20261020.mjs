/**
 * Regression pass for the five user-visible defects reported on 2026-10-20:
 * particle orb visibility/theme, DJ header collisions with the dock open, dock composer placement,
 * library folder selection, and horizontal overflow around the resulting layouts.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.UI_REGRESSION_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/ui-regression-20261020";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ["microphone"] });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.addInitScript(() => {
  localStorage.setItem("shadowroom.view", "dj");
  localStorage.setItem(
    "shadowroom.dock.by-view.v1",
    JSON.stringify({ workbench: false, studio: false, dj: true, library: true }),
  );
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });
await page.waitForTimeout(700);

const dj = await page.evaluate(() => {
  const rect = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  };
  const intersects = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
  const topbar = document.querySelector(".sr-dj-topbar");
  const children = topbar === null
    ? []
    : [...topbar.children].map((el) => {
        const b = el.getBoundingClientRect();
        return {
          cls: el.className,
          x: b.x,
          y: b.y,
          right: b.right,
          bottom: b.bottom,
          width: b.width,
          height: b.height,
        };
      });
  const overlaps = [];
  for (let i = 0; i < children.length; i += 1) {
    for (let j = i + 1; j < children.length; j += 1) {
      if (intersects(children[i], children[j])) overlaps.push(`${children[i].cls} × ${children[j].cls}`);
    }
  }
  const dock = rect(".sr-dock");
  const composer = rect(".sr-dock-composer");
  const root = document.querySelector(".sr-dj");
  return {
    children,
    overlaps,
    rootOverflow: root === null ? -1 : root.scrollWidth - root.clientWidth,
    mainOverflow: (() => {
      const main = document.querySelector(".sr-dj-main");
      return main === null ? -1 : main.scrollWidth - main.clientWidth;
    })(),
    dock,
    composer,
    overlapLabel: document.querySelector(".sr-dj-topbar .sr-dj-overlap")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    heroOverlap: [...document.querySelectorAll(".sr-dj-hero-meta > span")].at(-1)?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  };
});
check(
  "① DJ 顶栏在右侧对话栏打开时不叠字",
  dj.overlaps.length === 0 && dj.rootOverflow <= 1 && dj.mainOverflow <= 1,
  `直接子项 ${dj.children.length} 个，交叠 ${JSON.stringify(dj.overlaps)}，横向溢出 ${dj.rootOverflow}/${dj.mainOverflow}px`,
);
check(
  "② 接歌重叠写明含义",
  dj.overlapLabel.startsWith("接歌重叠") && dj.overlapLabel.includes("0 秒") && dj.heroOverlap.includes("0s"),
  `顶栏=${JSON.stringify(dj.overlapLabel)}，概览=${JSON.stringify(dj.heroOverlap)}`,
);
check(
  "③ 右侧输入框始终贴底",
  dj.dock !== null &&
    dj.composer !== null &&
    dj.composer.y > dj.dock.y + dj.dock.height / 2 &&
    Math.abs(dj.dock.bottom - dj.composer.bottom) <= 12,
  `dock ${JSON.stringify(dj.dock)} / composer ${JSON.stringify(dj.composer)}`,
);
await page.screenshot({ path: `${SHOTS}/dj-with-dock.png` });

const orb = await page.evaluate(() => {
  const ball = document.querySelector(".sr-orb-ball")?.getBoundingClientRect();
  const visual = document.querySelector(".sr-orb-visual");
  const style = visual === null ? null : getComputedStyle(visual);
  return {
    width: ball?.width ?? -1,
    height: ball?.height ?? -1,
    hueA: style?.getPropertyValue("--orb-hue-a").trim() ?? "",
    hueB: style?.getPropertyValue("--orb-hue-b").trim() ?? "",
    canvas: document.querySelector(".sr-orb-canvas") !== null,
  };
});
check(
  "④ 粒子球足够可见并使用酸绿/冰青主题",
  orb.width >= 80 && orb.height >= 80 && orb.canvas && orb.hueA === "74" && orb.hueB === "174",
  JSON.stringify(orb),
);
const orbBox = await page.locator(".sr-orb-ball").boundingBox();
if (orbBox !== null) {
  await page.screenshot({
    path: `${SHOTS}/orb.png`,
    clip: { x: orbBox.x - 20, y: orbBox.y - 20, width: orbBox.width + 40, height: orbBox.height + 40 },
  });
}

await page.route("**/api/agent/pick", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ paths: ["/Users/lazora/Music/Test Library"] }),
  });
});
await page.getByRole("button", { name: "曲目库", exact: true }).click();
await page.waitForSelector(".sr-lib-row", { timeout: 15000 });
await page.getByRole("button", { name: "入库音乐", exact: true }).click();
const browse = page.getByRole("button", { name: "选择要扫描的文件夹" });
await browse.click();
await page.waitForFunction(
  () =>
    document.querySelector('.sr-lib-ingest-panel input[aria-label="要扫描的文件夹路径"]')?.value ===
    "/Users/lazora/Music/Test Library",
);
const picker = await page.evaluate(() => ({
  value: document.querySelector('.sr-lib-ingest-panel input[aria-label="要扫描的文件夹路径"]')?.value ?? "",
  note: document.querySelector(".sr-lib-scanprogress")?.textContent ?? "",
  panelOverflow: (() => {
    const panel = document.querySelector(".sr-lib-ingest-panel");
    return panel === null ? -1 : panel.scrollWidth - panel.clientWidth;
  })(),
}));
check(
  "⑤ 曲目库可直接选择文件夹并回填路径",
  picker.value === "/Users/lazora/Music/Test Library" &&
    picker.note.includes("文件夹已选择") &&
    picker.panelOverflow <= 1,
  JSON.stringify(picker),
);
await page.screenshot({ path: `${SHOTS}/library-picker.png` });

check("⑥ 零 Console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
