/**
 * Cross-page user check: the global orb must never cover a visible interactive control.
 *
 * The test exercises the narrow dock layout (where a bottom-right floating object is most dangerous)
 * at desktop and compact desktop widths across every main page.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.ORB_OCCLUSION_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const project = {
  id: "project-orb-occlusion",
  name: "悬浮球遮挡验收",
  updatedAt: 1,
  bpm: 122,
  key: "8A",
  bars: 8,
  tracks: [
    {
      id: "track-orb-occlusion",
      name: "Drums",
      muted: false,
      soloed: false,
      volume: 80,
      type: "drums",
      color: 0,
      clips: [
        {
          id: "clip-orb-occlusion",
          name: "Drums",
          start: 0,
          length: 4,
          source: "/Users/lazora/Documents/ShadowRoom/recordings/tech-house-122-drums.wav",
        },
      ],
    },
  ],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const viewport of [
  { width: 1440, height: 900, label: "1440×900" },
  { width: 1128, height: 765, label: "1128×765" },
]) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript((seed) => {
    if (sessionStorage.getItem("orb-occlusion-seeded")) return;
    sessionStorage.setItem("orb-occlusion-seeded", "1");
    localStorage.setItem("shadowroom.view", "workbench");
    localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [seed] }));
    localStorage.setItem("shadowroom.studio.open", seed.id);
    localStorage.setItem(
      "shadowroom.dock.by-view.v1",
      JSON.stringify({ workbench: true, studio: true, dj: true, library: true }),
    );
    localStorage.removeItem("shadowroom.orb.position");
  }, project);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-visual", { timeout: 20_000 });

  const pages = [
    ["工作台", "工作台"],
    ["Studio", "Studio"],
    ["DJ", "DJ"],
    ["曲目库", "曲目库"],
    ["设置", "设置"],
  ];
  for (const [label, name] of pages) {
    await page.getByRole("button", { name, exact: true }).first().click();
    await page.waitForTimeout(650);
    const audit = await page.evaluate(() => {
      const orb = document.querySelector(".sr-orb-visual")?.getBoundingClientRect();
      if (!orb) return { overlap: ["orb missing"], checked: 0 };
      const selector = [
        "button",
        "a[href]",
        "input",
        "textarea",
        "select",
        '[role="button"]',
        '[role="menuitem"]',
        ".sr-dock-composer",
        ".sr-page-composer",
      ].join(",");
      const hits = [];
      let checked = 0;
      for (const element of document.querySelectorAll(selector)) {
        if (element.closest(".sr-orb")) continue;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
        checked += 1;
        const overlaps = !(
          orb.right <= rect.left ||
          orb.left >= rect.right ||
          orb.bottom <= rect.top ||
          orb.top >= rect.bottom
        );
        if (overlaps) hits.push((element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 50));
      }
      return { overlap: hits, checked };
    });
    check(
      `${viewport.label} · ${label}：球不遮挡任何可见交互控件`,
      audit.overlap.length === 0,
      `checked=${audit.checked} overlaps=${JSON.stringify(audit.overlap)}`,
    );
  }
  await page.getByRole("button", { name: /插件.*9\/9/ }).first().click();
  await page.waitForTimeout(650);
  const pluginAudit = await page.evaluate(() => {
    const orb = document.querySelector(".sr-orb-visual")?.getBoundingClientRect();
    if (!orb) return { overlaps: ["orb missing"], checked: 0 };
    const hits = [];
    let checked = 0;
    for (const element of document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=menuitem]")) {
      if (element.closest(".sr-orb")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      checked += 1;
      const overlaps = !(orb.right <= rect.left || orb.left >= rect.right || orb.bottom <= rect.top || orb.top >= rect.bottom);
      if (overlaps) hits.push((element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 50));
    }
    return { overlaps: hits, checked };
  });
  check(
    `${viewport.label} · 插件：球不遮挡任何可见交互控件`,
    pluginAudit.overlaps.length === 0,
    `checked=${pluginAudit.checked} overlaps=${JSON.stringify(pluginAudit.overlaps)}`,
  );
  check(`${viewport.label} · 全页面 Console error 0`, errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  await context.close();
}

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
