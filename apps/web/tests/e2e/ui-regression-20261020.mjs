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
    overlapInput: document.querySelector(".sr-dj-topbar .sr-dj-overlap input")?.value ?? "",
    heroOverlap: [...document.querySelectorAll(".sr-dj-hero-meta > span")].at(-1)?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  };
});
check(
  "① DJ 顶栏在右侧对话栏打开时不叠字",
  dj.overlaps.length === 0 && dj.rootOverflow <= 1 && dj.mainOverflow <= 1,
  `直接子项 ${dj.children.length} 个，交叠 ${JSON.stringify(dj.overlaps)}，横向溢出 ${dj.rootOverflow}/${dj.mainOverflow}px`,
);
check(
  "② 默认重叠与实际重叠分开显示",
  dj.overlapLabel.startsWith("默认重叠") &&
    dj.overlapInput === "16" &&
    dj.heroOverlap.includes("0s") &&
    dj.heroOverlap.includes("实际重叠"),
  `控件=${JSON.stringify(dj.overlapLabel)} / ${dj.overlapInput}，概览=${JSON.stringify(dj.heroOverlap)}`,
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

const firstLibraryRow = page.locator(".sr-dj-library .sr-dj-row").filter({
  has: page.getByRole("button", { name: /加入 set / }),
}).first();
await firstLibraryRow.hover();
await firstLibraryRow.getByRole("button", { name: /加入 set / }).click();
await page.waitForFunction(() => document.querySelectorAll(".sr-dj-suggest-row").length >= 1, null, {
  timeout: 15000,
});
const setContinuation = await page.evaluate(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const suggestions = [...document.querySelectorAll(".sr-dj-suggest-row")].map((row) => {
    const reasons = row.querySelector(".sr-dj-reasons");
    return {
      ...box(row),
      reasonsHeight: reasons === null ? 0 : reasons.getBoundingClientRect().height,
      reasonsScrollHeight: reasons?.scrollHeight ?? 0,
    };
  });
  const drop = document.querySelector(".sr-dj-next-drop");
  const heroActual = [...document.querySelectorAll(".sr-dj-hero-meta > span")].at(-1)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return {
    suggestions,
    suggestionOverflow: (() => {
      const strip = document.querySelector(".sr-dj-suggest-strip");
      return strip === null ? -1 : strip.scrollWidth - strip.clientWidth;
    })(),
    drop: drop === null ? null : box(drop),
    heroActual,
    boardRows: document.querySelectorAll(".sr-dj-board .sr-dj-row").length,
  };
});
check(
  "④ 一首歌时仍显示实际 0 重叠，并为下一首提供明确落点",
  setContinuation.boardRows === 1 &&
    setContinuation.heroActual.includes("0s") &&
    setContinuation.drop !== null &&
    setContinuation.drop.height >= 100,
  JSON.stringify({ heroActual: setContinuation.heroActual, drop: setContinuation.drop, rows: setContinuation.boardRows }),
);
check(
  "⑤ 推荐卡不再被固定高度压扁",
  setContinuation.suggestions.length >= 1 &&
    setContinuation.suggestionOverflow <= 1 &&
    setContinuation.suggestions.every(
      (row) => row.height >= 80 && row.reasonsHeight >= 16 && row.reasonsHeight <= 37,
    ),
  JSON.stringify(setContinuation.suggestions),
);
await page.screenshot({ path: `${SHOTS}/dj-one-track.png` });

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
  "⑥ 粒子球足够可见并使用酸绿/冰青主题",
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
  "⑦ 曲目库可直接选择文件夹并回填路径",
  picker.value === "/Users/lazora/Music/Test Library" &&
    picker.note.includes("文件夹已选择") &&
    picker.panelOverflow <= 1,
  JSON.stringify(picker),
);
await page.screenshot({ path: `${SHOTS}/library-picker.png` });

await page.setViewportSize({ width: 1474, height: 1080 });
await page.getByRole("button", { name: "DJ", exact: true }).click();
await page.getByRole("button", { name: "收起对话" }).click();
await page.waitForSelector(".sr-dj-suggest-row", { timeout: 15000 });
const wide = await page.evaluate(() => {
  const top = [...document.querySelectorAll(".sr-dj-topbar > *")].map((element) => {
    const rect = element.getBoundingClientRect();
    return { cls: String(element.className), x: rect.x, right: rect.right, width: rect.width };
  });
  const suggestions = document.querySelector(".sr-dj-suggest-strip");
  const root = document.querySelector(".sr-dj");
  return {
    top,
    suggestionOverflow: suggestions === null ? -1 : suggestions.scrollWidth - suggestions.clientWidth,
    pageOverflow: root === null ? -1 : root.scrollWidth - root.clientWidth,
  };
});
check(
  "⑧ 1474px 宽屏顶栏与推荐条无横向错位",
  wide.top.length === 4 &&
    wide.top.every((item, index) => index === 0 || item.x >= wide.top[index - 1].right) &&
    wide.suggestionOverflow <= 1 &&
    wide.pageOverflow <= 1,
  JSON.stringify(wide),
);
await page.screenshot({ path: `${SHOTS}/dj-wide-one-track.png` });

check("⑨ 零 Console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
