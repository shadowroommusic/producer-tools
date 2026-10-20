/**
 * MIDI / piano-roll display acceptance.
 *
 * The functional tests already prove notes can be edited. This check is about what a user sees:
 * the roll header must stay readable, controls must never wrap into vertical glyph columns, and the
 * note grid must remain bounded at desktop, compact desktop, and icon-sidebar widths.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.STUDIO_MIDI_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/studio-midi-display";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const project = {
  id: "proj-midi-display",
  name: "MIDI 显示验收",
  updatedAt: 1,
  bpm: 128,
  key: "C",
  bars: 16,
  tracks: [{
    id: "trk-midi",
    name: "Drums",
    type: "drums",
    muted: false,
    soloed: false,
    volume: 80,
    clips: [{
      id: "clip-midi",
      name: "鼓 MIDI",
      start: 0,
      length: 2,
      notes: [
        { id: "n1", start_ms: 0, end_ms: 250, midi: 56 },
        { id: "n2", start_ms: 250, end_ms: 500, midi: 58 },
        { id: "n3", start_ms: 500, end_ms: 750, midi: 36 },
        { id: "n4", start_ms: 750, end_ms: 1000, midi: 38 },
        { id: "n5", start_ms: 1000, end_ms: 1250, midi: 39 },
        { id: "n6", start_ms: 1250, end_ms: 1500, midi: 42 },
        { id: "n7", start_ms: 1500, end_ms: 1750, midi: 46 },
      ],
    }],
  }],
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1440, height: 900, dock: true },
  { width: 1280, height: 800, dock: true },
  { width: 1092, height: 605 },
  { width: 900, height: 700 },
  { width: 661, height: 605 },
]) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${viewport.width}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${viewport.width}: ${message.text()}`);
  });
  await page.addInitScript(({ seed, dock }) => {
    localStorage.setItem("shadowroom.view", "studio");
    localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [seed] }));
    localStorage.setItem("shadowroom.studio.open", seed.id);
    localStorage.setItem(
      "shadowroom.dock.by-view.v1",
      JSON.stringify({ workbench: false, studio: dock, dj: false, library: false }),
    );
    localStorage.removeItem("shadowroom.orb.position");
  }, { seed: project, dock: viewport.dock === true });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator('.sr-clip[aria-label="鼓 MIDI"]').waitFor({ timeout: 20000 });
  await page.locator('.sr-clip[aria-label="鼓 MIDI"]').dblclick();
  await page.waitForSelector(".sr-roll", { timeout: 5000 });
  await page.waitForTimeout(250);

  const metrics = await page.evaluate(() => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const head = document.querySelector(".sr-roll-head");
    const heading = document.querySelector(".sr-roll-heading");
    const actions = document.querySelector(".sr-roll-actions");
    const body = document.querySelector(".sr-roll-body");
    const buttons = [...document.querySelectorAll(".sr-roll-actions .sr-btn")];
    const hb = head === null ? null : rect(head);
    const ab = actions === null ? null : rect(actions);
    const overlaps = [];
    for (let i = 0; i < buttons.length; i += 1) {
      for (let j = i + 1; j < buttons.length; j += 1) {
        const a = rect(buttons[i]);
        const b = rect(buttons[j]);
        if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) {
          overlaps.push(`${buttons[i].textContent}:${buttons[j].textContent}`);
        }
      }
    }
    return {
      title: document.querySelector(".sr-roll-title")?.textContent ?? "",
      meta: document.querySelector(".sr-roll-meta")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      head: hb,
      heading: heading === null ? null : rect(heading),
      actions: ab,
      body: body === null ? null : {
        clientWidth: body.clientWidth,
        scrollWidth: body.scrollWidth,
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
      },
      buttonHeights: buttons.map((button) => Math.round(button.getBoundingClientRect().height)),
      whiteSpace: buttons.map((button) => getComputedStyle(button).whiteSpace),
      overlaps,
      rootOverflow: document.querySelector(".sr-studio")?.scrollWidth - document.querySelector(".sr-studio")?.clientWidth,
    };
  });
  const headingFits = metrics.heading !== null && metrics.heading.right <= (metrics.head?.right ?? 0) + 1;
  const actionsFit = metrics.actions !== null && metrics.heading !== null && (
    metrics.actions.y >= metrics.heading.bottom - 1 ||
    metrics.actions.x >= metrics.heading.right - 1
  );
  check(
    `${viewport.width}×${viewport.height}${viewport.dock ? " + dock" : ""} MIDI 头部可读`,
    metrics.title === "鼓 MIDI" &&
      metrics.meta.includes("7 个音符") &&
      metrics.overlaps.length === 0 &&
      metrics.whiteSpace.every((value) => value === "nowrap") &&
      metrics.buttonHeights.every((height) => height <= 38) &&
      headingFits &&
      actionsFit &&
      metrics.rootOverflow <= 1,
    JSON.stringify(metrics),
  );
  check(
    `${viewport.width}×${viewport.height}${viewport.dock ? " + dock" : ""} 音符网格有界`,
    metrics.body !== null &&
      metrics.body.clientWidth > 0 &&
      metrics.body.clientHeight > 0 &&
      metrics.body.scrollWidth >= metrics.body.clientWidth &&
      metrics.body.scrollHeight >= metrics.body.clientHeight,
    JSON.stringify(metrics.body),
  );
  await page.screenshot({
    path: `${SHOTS}/midi-${viewport.width}x${viewport.height}${viewport.dock ? "-dock" : ""}.png`,
  });
  await context.close();
}

check("零 Console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
