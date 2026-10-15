/**
 * 最强端到端（一次性探针，不入仓）：真模型回合 → butler 调 generator.clip_modulate →
 * Codex 工具卡片通道 → App 吸收器 → StudioPage 写 gainLfo → localStorage。
 *
 * 与 clip-modulate-wire-acceptance.mjs 的分工：那条合成 media-events（通道 B），
 * 这条跑真回合（通道 A：toolCallFromItem 的 arguments 形状）——MiniMax 交叉验证指出
 * 通道 A 只被静态读过，这是补实测。
 *
 * 前置：5173 + 8787 + 8788 全在。用法：node /tmp/butler-clip-modulate-e2e.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/butler-clip-modulate";
mkdirSync(SHOTS, { recursive: true });

const seed = {
  id: "proj-butler-e2e",
  name: "管家接线验收",
  updatedAt: 1,
  bpm: 240, // 1bar = 1.00 Hz
  key: "",
  bars: 16,
  tracks: [
    {
      id: "trk-butler",
      name: "贝斯",
      muted: false,
      soloed: false,
      volume: 80,
      clips: [{ id: "clip-butler-b", name: "待加泵感", start: 0, length: 2, source: "" }],
    },
  ],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
});
try {
  await page.addInitScript((project) => {
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [project] }));
    window.localStorage.setItem("shadowroom.studio.open", project.id);
    window.localStorage.removeItem("shadowroom.orb.position");
  }, seed);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator(".sr-clip").first().waitFor({ timeout: 15000 });

  // 往 dock composer 里写任务。工具名与参数写死，避免模型自由发挥导致假阴性。
  const composer = page.locator("textarea").first();
  await composer.waitFor({ timeout: 10000 });
  await composer.fill(
    "请调用 shadow-music-generator 的 clip_modulate 工具一次：clip_id 用 clip-butler-b，rate 用 1bar，depth 用 0.7。只调这一个工具，然后一句话确认。",
  );
  await page.locator('button[aria-label="发送"]').first().click();
  console.log("回合已发出，等待 butler 调工具……");

  let gainLfo = null;
  let sawToolCard = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && gainLfo === null) {
    await page.waitForTimeout(2500);
    gainLfo = await page.evaluate(() => {
      const raw = window.localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}";
      const parsed = JSON.parse(raw);
      const clip = parsed.projects?.[0]?.tracks?.[0]?.clips?.find((entry) => entry.id === "clip-butler-b");
      return clip?.gainLfo ?? null;
    });
    if (!sawToolCard) {
      sawToolCard = (await page.locator("text=clip_modulate").count()) > 0;
    }
  }
  await page.screenshot({ path: `${SHOTS}/butler-clip-modulate.png` });
  console.log(JSON.stringify({
    gainLfo,
    sawToolCard,
    elapsedOk: gainLfo !== null,
    consoleErrors: consoleErrors.slice(0, 3),
    screenshot: `${SHOTS}/butler-clip-modulate.png`,
  }, null, 1));
  // 顺带把回合最后一条助手文本抓出来（失败时用于定位是模型没调工具还是链路没接上）
  const transcript = await page.locator(".sr-transcript, .sr-dock-transcript").first().innerText().catch(() => "");
  console.log("transcript 尾部：", transcript.replace(/\n+/g, " | ").slice(-400));
} finally {
  await browser.close();
}
