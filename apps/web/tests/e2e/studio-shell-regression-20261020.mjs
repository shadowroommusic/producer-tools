/**
 * Studio shell regressions found by the full user-facing audit:
 * numeric fields must accept normal typing, a fader drag must be one undo step, track headers and
 * lanes must share one vertical scroll, out-of-range clips must remain visible, and context menus
 * must close with Escape.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.STUDIO_SHELL_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const tracks = Array.from({ length: 10 }, (_, index) => ({
  id: `trk-${index + 1}`,
  name: `${["Drums", "Bass", "Chords", "Lead"][index % 4]} ${index + 1}`,
  muted: false,
  soloed: false,
  volume: 68,
  type: index % 4 === 0 ? "drums" : index % 4 === 1 ? "audio" : "instrument",
  clips: [{
    id: `clip-${index + 1}`,
    name: index === 9 ? "工程末尾之后" : `Part ${index + 1}`,
    start: index === 9 ? 14 : index % 3,
    length: 4,
    notes: [
      { id: `n-${index}-1`, midi: 60 + (index % 4), start_ms: 0, end_ms: 500, velocity: 100 },
      { id: `n-${index}-2`, midi: 64 + (index % 4), start_ms: 500, end_ms: 1000, velocity: 96 },
    ],
  }],
}));

const project = {
  id: "project-shell-regression",
  name: "Studio 全页回归",
  updatedAt: Date.now(),
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

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const seed = async () => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((seedProject) => {
    localStorage.setItem("shadowroom.view", "studio");
    localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [seedProject] }));
    localStorage.setItem("shadowroom.studio.open", seedProject.id);
    localStorage.setItem(
      "shadowroom.dock.by-view.v1",
      JSON.stringify({ workbench: false, studio: false, dj: false, library: false }),
    );
    localStorage.removeItem("shadowroom.orb.position");
  }, project);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-studio-grid", { timeout: 20000 });
  await page.waitForTimeout(200);
};

await seed();

{
  const bpm = page.getByLabel("BPM", { exact: true });
  await bpm.click();
  await page.keyboard.press("Meta+A");
  const typed = [];
  for (const key of ["1", "2", "0"]) {
    await page.keyboard.type(key);
    typed.push(await bpm.inputValue());
  }
  await page.keyboard.press("Enter");
  const committedBpm = await page.getByLabel("BPM", { exact: true }).inputValue();
  const bars = page.getByLabel("工程小节数");
  await bars.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("32");
  await page.keyboard.press("Enter");
  const committedBars = await page.getByLabel("工程小节数").inputValue();
  check(
    "① BPM/小节可逐字输入并在提交时校验",
    typed.join("/") === "1/12/120" && committedBpm === "120" && committedBars === "32",
    `BPM=${typed.join("/")} → ${committedBpm}，小节=${committedBars}`,
  );
}

await seed();
{
  const fader = page.locator(".sr-fader").first();
  const before = await fader.inputValue();
  const box = await fader.boundingBox();
  if (box === null) throw new Error("fader has no box");
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.92, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await fader.inputValue();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForTimeout(150);
  const undone = await page.locator(".sr-fader").first().inputValue();
  check(
    "② 一次推子拖动只产生一步撤销",
    before !== after && undone === before,
    `${before} → ${after} → ${undone}`,
  );
}

await seed();
{
  const first = page.locator(".sr-track-head").first();
  await first.click({ button: "right" });
  const before = await page.locator('.sr-menu[role="menu"]').count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const after = await page.locator('.sr-menu[role="menu"]').count();
  check("③ Studio 右键菜单可用 Esc 关闭", before === 1 && after === 0, `${before} → ${after}`);
}

await seed();
{
  const headerBox = await page.locator(".sr-studio-headers-scroll").boundingBox();
  if (headerBox === null) throw new Error("headers have no box");
  await page.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + Math.min(160, headerBox.height / 2));
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(180);
  const scroll = await page.evaluate(() => {
    const timeline = document.querySelector(".sr-studio-timeline-scroll");
    const header = document.querySelectorAll(".sr-track-head");
    const lanes = document.querySelectorAll(".sr-studio-lane");
    const last = header.length - 1;
    return {
      timelineScrollTop: timeline?.scrollTop ?? -1,
      headerCount: header.length,
      deltaY: Math.abs(header[last].getBoundingClientRect().y - lanes[last].getBoundingClientRect().y),
    };
  });
  check(
    "④ 轨道头区域滚轮同步纵向滚动",
    scroll.timelineScrollTop > 100 && scroll.headerCount === 10 && scroll.deltaY <= 1,
    JSON.stringify(scroll),
  );
}

await seed();
{
  const bounds = await page.evaluate(() => {
    const grid = document.querySelector(".sr-studio-grid");
    const lastClip = [...document.querySelectorAll(".sr-clip")].at(-1);
    if (!(grid instanceof HTMLElement) || !(lastClip instanceof HTMLElement)) return null;
    const gridBox = grid.getBoundingClientRect();
    const clipBox = lastClip.getBoundingClientRect();
    const firstHead = document.querySelector(".sr-track-head")?.getBoundingClientRect();
    const firstLane = document.querySelector(".sr-studio-lane")?.getBoundingClientRect();
    return {
      clippedPx: Math.max(0, clipBox.right - gridBox.right),
      alignDelta: Math.abs((firstHead?.y ?? 0) - (firstLane?.y ?? 0)),
      gridWidth: gridBox.width,
    };
  });
  check(
    "⑤ 超长 MIDI/音频片段仍在时间线内可见，段落不破坏轨道对齐",
    bounds !== null && bounds.clippedPx <= 1 && bounds.alignDelta <= 1,
    JSON.stringify(bounds),
  );
}

check("⑥ 零 Console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
