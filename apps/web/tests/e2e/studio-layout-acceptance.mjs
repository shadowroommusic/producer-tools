/**
 * Studio layout and interaction acceptance.
 *
 * These are the measured regressions from the 2026-10-20 full-page audit: a second vertical
 * scrollbar desynchronised headers from lanes, zoom scaled the ruler but not the painted grid,
 * clips beyond the declared project length disappeared, numeric fields clamped every keypress,
 * fader input split one gesture into many undo steps, and menu overlays ignored Escape.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.STUDIO_LAYOUT_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/studio-layout-acceptance";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const tracks = Array.from({ length: 10 }, (_, index) => ({
  id: `track-${index + 1}`,
  name: index === 3 ? "这是一条用于检查轨道头布局的 Bass 轨道" : `Track ${index + 1}`,
  muted: false,
  soloed: false,
  volume: 68,
  type: index % 3 === 0 ? "drums" : "instrument",
  color: index % 8,
  clips: Array.from({ length: 2 }, (_, clipIndex) => ({
    id: `clip-${index + 1}-${clipIndex + 1}`,
    name: `Part ${index + 1}.${clipIndex + 1}`,
    start: clipIndex * 6,
    length: 2,
    notes: [
      { id: `note-${index}-${clipIndex}-1`, midi: 60 + index, start_ms: 0, end_ms: 250 },
      { id: `note-${index}-${clipIndex}-2`, midi: 64 + index, start_ms: 250, end_ms: 500 },
    ],
  })),
}));
const project = {
  id: "studio-layout-acceptance",
  name: "Studio 布局验收",
  updatedAt: 1,
  bpm: 124,
  key: "8A",
  bars: 16,
  tracks,
  sections: [
    { id: "intro", name: "Intro", bars: 4, start: 0 },
    { id: "drop", name: "Drop", bars: 8, start: 4 },
    { id: "outro", name: "Outro", bars: 4, start: 12 },
  ],
};

const seed = async (next = project, dockOpen = false) => {
  if (page.url() === "about:blank") await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ project: seedProject, dockOpen: seedDockOpen }) => {
    localStorage.setItem("shadowroom.view", "studio");
    localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [seedProject] }));
    localStorage.setItem("shadowroom.studio.open", seedProject.id);
    localStorage.setItem("shadowroom.studio.leftdrawer", "");
    localStorage.setItem(
      "shadowroom.dock.by-view.v1",
      JSON.stringify({ workbench: false, studio: seedDockOpen, dj: false, library: false }),
    );
    localStorage.removeItem("shadowroom.orb.position");
  }, { project: next, dockOpen });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-studio-grid", { timeout: 20000 });
  await page.waitForTimeout(250);
};

await seed();

// One vertical source: headers start aligned, follow arbitrary timeline scrollTop, and the ruler
// remains visible instead of scrolling away with the lanes.
{
  const initial = await page.evaluate(() => {
    const heads = [...document.querySelectorAll(".sr-track-head")];
    const lanes = [...document.querySelectorAll(".sr-studio-lane")];
    return heads.map((head, index) => ({
      delta: +(head.getBoundingClientRect().top - lanes[index].getBoundingClientRect().top).toFixed(1),
    }));
  });
  await page.locator(".sr-studio-timeline-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(120);
  const scrolled = await page.evaluate(() => {
    const timeline = document.querySelector(".sr-studio-timeline-scroll");
    const head = document.querySelectorAll(".sr-track-head")[9].getBoundingClientRect();
    const lane = document.querySelectorAll(".sr-studio-lane")[9].getBoundingClientRect();
    const ruler = document.querySelector(".sr-studio-ruler").getBoundingClientRect();
    const sections = document.querySelector(".sr-studio-sections").getBoundingClientRect();
    const viewport = timeline.getBoundingClientRect();
    return {
      scrollTop: timeline.scrollTop,
      delta: +(head.top - lane.top).toFixed(1),
      sectionTop: +(sections.top - viewport.top).toFixed(1),
      rulerTop: +(ruler.top - viewport.top).toFixed(1),
    };
  });
  check(
    "① 10 轨纵向滚动同步，段落条和标尺固定",
    initial.every((row) => Math.abs(row.delta) <= 0.5) &&
      scrolled.scrollTop > 50 &&
      Math.abs(scrolled.delta) <= 0.5 &&
      Math.abs(scrolled.sectionTop) <= 0.5 &&
      Math.abs(scrolled.rulerTop - 26) <= 0.5,
    JSON.stringify({ initial, scrolled }),
  );
  await page.screenshot({ path: `${SHOTS}/vertical-scroll.png` });
}

// The timeline surface must display content that extends past project.bars, not clip it outside the
// scrollable width.
{
  const overflowProject = {
    ...project,
    tracks: project.tracks.map((track, index) =>
      index === 9
        ? {
            ...track,
            clips: [
              {
                id: "beyond-end",
                name: "超出工程末尾",
                start: 14,
                length: 4,
                notes: [{ id: "beyond-note", midi: 60, start_ms: 0, end_ms: 250 }],
              },
            ],
          }
        : track,
    ),
  };
  await seed(overflowProject);
  const bounds = await page.evaluate(() => {
    const grid = document.querySelector(".sr-studio-grid").getBoundingClientRect();
    const clip = document.querySelector('.sr-clip[aria-label="超出工程末尾"]').getBoundingClientRect();
    return { gridRight: grid.right, clipRight: clip.right, overhang: +(clip.right - grid.right).toFixed(1) };
  });
  check("② 超出工程长度的片段仍完整落在可滚动画布内", bounds.overhang <= 0, JSON.stringify(bounds));
}

// Zoom updates the clip width, ruler width, and the painted bar grid together.
{
  await seed();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  const zoomed = await page.evaluate(() => {
    const bar = document.querySelector(".sr-studio-bar").getBoundingClientRect();
    const image = getComputedStyle(document.querySelector(".sr-studio-grid")).backgroundImage;
    return { barPx: bar.width, image };
  });
  check(
    "③ 125% 缩放后标尺和网格同为 70px / 280px",
    Math.abs(zoomed.barPx - 70) <= 0.5 &&
      zoomed.image.includes("70px") &&
      zoomed.image.includes("280px"),
    JSON.stringify(zoomed),
  );
}

// Human typing must be allowed to pass through invalid intermediate values; clamping happens when
// the field is committed.
{
  await seed();
  const bpm = page.locator('.sr-transport-field:has(.sr-field-label:text-is("BPM")) input');
  await bpm.click();
  await page.keyboard.press("Meta+A");
  const states = [];
  for (const digit of ["1", "2", "0"]) {
    await page.keyboard.type(digit);
    states.push(await bpm.inputValue());
  }
  await page.keyboard.press("Enter");
  await bpm.blur();
  const committed = await bpm.inputValue();
  check(
    "④ BPM 可以逐字输入 120，提交后才写回",
    states.join(">") === "1>12>120" && committed === "120",
    `${states.join(" → ")}；committed=${committed}`,
  );
}

// A drag of the fader is one user gesture and therefore one undo step.
{
  await seed();
  const fader = page.locator(".sr-fader").first();
  const before = await fader.inputValue();
  const box = await fader.boundingBox();
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.92, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  const after = await fader.inputValue();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  const undone = await page.locator(".sr-fader").first().inputValue();
  check(
    "⑤ 一次推子拖动只产生一次撤销",
    before !== after && undone === before,
    `${before} → ${after} → undo ${undone}`,
  );
}

// Right-click menus have a keyboard exit. The old track-head menu left Escape stuck on screen.
{
  await seed();
  await page.locator(".sr-track-head").first().click({ button: "right" });
  await page.waitForSelector('.sr-menu[role="menu"]');
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector('.sr-menu[role="menu"]') === null);
  check("⑥ 轨道头右键菜单 Esc 可关闭", (await page.locator('.sr-menu[role="menu"]').count()) === 0, "closed");
}

// With the dock open, the viewport is still 1440px but Studio is only ~757px. Piano-roll layout
// must respond to the Studio container and put its controls on a second row instead of truncating
// the clip identity to "Pa…".
{
  await seed(project, true);
  await page.locator(".sr-clip").first().dblclick();
  await page.waitForSelector(".sr-roll-heading");
  const desktopDock = await page.evaluate(() => {
    const studio = document.querySelector(".sr-studio").getBoundingClientRect();
    const head = document.querySelector(".sr-roll-head").getBoundingClientRect();
    const heading = document.querySelector(".sr-roll-heading").getBoundingClientRect();
    const actions = document.querySelector(".sr-roll-actions").getBoundingClientRect();
    return {
      studioWidth: +studio.width.toFixed(1),
      headHeight: +head.height.toFixed(1),
      twoRows: actions.top >= heading.bottom - 1,
      title: document.querySelector(".sr-roll-title")?.textContent ?? "",
      meta: document.querySelector(".sr-roll-meta")?.textContent ?? "",
    };
  });
  check(
    "⑦ dock 打开时钢琴卷帘按容器宽度切两行，身份信息完整",
    desktopDock.studioWidth < 800 &&
      desktopDock.twoRows &&
      desktopDock.headHeight >= 70 &&
      desktopDock.title === "Part 1.1" &&
      desktopDock.meta.includes("2 个音符"),
    JSON.stringify(desktopDock),
  );
  await page.screenshot({ path: `${SHOTS}/dock-open-piano-roll.png` });
}

// A short project still fills the visible work surface. Otherwise the region after bar 4 becomes
// one large black rectangle that reads as a broken canvas.
{
  await seed({
    ...project,
    bars: 4,
    tracks: project.tracks.slice(0, 3),
    sections: [],
  });
  const coverage = await page.evaluate(() => {
    const scroll = document.querySelector(".sr-studio-timeline-scroll");
    const grid = document.querySelector(".sr-studio-grid");
    if (!(scroll instanceof HTMLElement) || !(grid instanceof HTMLElement)) return null;
    const gridRect = grid.getBoundingClientRect();
    return {
      gridWidth: +gridRect.width.toFixed(1),
      viewportWidth: +scroll.clientWidth.toFixed(1),
      covered: gridRect.width + 1 >= scroll.clientWidth,
      inlineWidth: grid.style.width,
      minWidth: getComputedStyle(grid).minWidth,
      backgroundImage: getComputedStyle(grid).backgroundImage,
    };
  });
  check(
    "⑦b 四小节工程仍铺满时间线可视区",
    coverage !== null &&
      coverage.covered &&
      coverage.viewportWidth > 300 &&
      coverage.gridWidth >= coverage.viewportWidth - 1 &&
      coverage.minWidth === "100%" &&
      coverage.backgroundImage.includes("84px"),
    JSON.stringify(coverage),
  );
  await page.screenshot({ path: `${SHOTS}/short-project-full-grid.png` });
}

check("⑧ 零 Console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
