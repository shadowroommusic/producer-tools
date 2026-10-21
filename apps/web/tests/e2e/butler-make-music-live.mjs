/**
 * 核心创作流 live 验收（一次性探针，不入仓）：真模型回合「做一段 2 小节的鼓」→
 * butler 调 generator.render_song → 音频落盘 → App 吸收成轨道/clip → 时间线可见。
 * 依赖：5173 + 8787 + 8788 + 真实模型（会花 token）。用法：node /tmp/butler-make-music-live.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { existsSync, readdirSync, statSync } from "node:fs";

const RECORDINGS = "/Users/lazora/Documents/ShadowRoom/recordings";
const seed = {
  id: "proj-live-music",
  name: "创作流验收",
  updatedAt: 1,
  bpm: 120,
  key: "",
  bars: 16,
  tracks: [],
};

const before = new Set(readdirSync(RECORDINGS));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
try {
  await page.addInitScript((project) => {
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [project] }));
    window.localStorage.setItem("shadowroom.studio.open", project.id);
    window.localStorage.removeItem("shadowroom.orb.position");
  }, seed);
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "让管家来做" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "让管家来做" }).click();
  const composer = page.getByLabel("给悬浮球的一句话");
  await composer.waitFor({ timeout: 10000 });
  await composer.fill("做一段 2 小节的鼓放进这个工程，120 BPM。");
  await page.locator(".sr-orb-panel button[type=submit]").click();
  console.log("管家回合已发，等路由卡……");

  const route = page.locator(".sr-route-card").last();
  await route.waitFor({ timeout: 300_000 });
  const continueButton = route.getByRole("button", { name: "打开并继续" });
  try {
    await continueButton.waitFor({ timeout: 10_000 });
  } catch (error) {
    console.log("ROUTE CARD", (await route.innerText()).replace(/\n+/g, " | "));
    await page.screenshot({ path: "/Users/lazora/Documents/ShadowRoom/exports/butler-make-music/route-no-execute.png" });
    throw error;
  }
  await continueButton.click();
  console.log("路由已确认，等 Studio worker 渲染……");

  let clips = 0;
  let audioClips = 0;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const snapshot = await page.evaluate(() => {
      const raw = window.localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}";
      const parsed = JSON.parse(raw);
      const project = parsed.projects?.[0];
      const all = (project?.tracks ?? []).flatMap((t) => t.clips ?? []);
      return { clips: all.length, audioClips: all.filter((c) => typeof c.source === "string" && c.source !== "").length, tracks: (project?.tracks ?? []).length };
    });
    clips = snapshot.clips; audioClips = snapshot.audioClips;
    if (clips > 0 && audioClips > 0) break;
  }
  // Tool completion paints the clip before the model's final `done`. Keep the page alive until the
  // turn actually settles so the durable steward handoff can move from running to done.
  await page
    .waitForFunction(
      () => document.querySelector(".sr-dock .sr-send")?.getAttribute("aria-label") === "发送",
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(400);

  const after = readdirSync(RECORDINGS).filter((name) => !before.has(name));
  const fresh = after
    .filter((name) => /drum|鼓|beat|loop/i.test(name) || name.endsWith(".wav"))
    .map((name) => ({ name, size: statSync(`${RECORDINGS}/${name}`).size }))
    .slice(0, 6);
  const transcript = await page.locator(".sr-transcript, .sr-dock-transcript").first().innerText().catch(() => "");
  console.log(JSON.stringify({
    clips, audioClips, newRecordings: fresh, consoleErrors: consoleErrors.slice(0, 3),
    transcriptTail: transcript.replace(/\n+/g, " | ").slice(-320),
  }, null, 1));
  await page.screenshot({ path: "/Users/lazora/Documents/ShadowRoom/exports/butler-make-music/live.png" });
} finally {
  await browser.close();
}
