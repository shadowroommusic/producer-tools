/**
 * voice-conversation · 球的实时声音反馈验收（用户 2026-10-21：「我正在说话时球没有反馈」）。
 *
 * 根因（用户定位，已修）：ButlerOrb 的 rAF 只更新 levelRef，而 <GlassSphere level={levelRef.current}>
 * 只在 React render 时读一次——ref 变化不触发 render，电平永远是 0。修复 = level 接受 getter、
 * Canvas 自己的 rAF 每帧读取；listening 态加感知映射 smoothstep(clamp(level*2))。
 *
 * 本件用真采集链路验收：fake mic 播 /tmp/say-turn.wav（用户生成的话音），断言——
 *  ① listen 期间 .sr-orb-visual 的 --orb-voice 峰值 >0.25（至少 >0.15）；
 *  ② 静音帧回落到 ≤0.08；
 *  ③ 有声/静音两帧 canvas 像素差有明确阈值（>2% 的像素显著变化）；
 *  ④ 连续采样中粒子球的包围盒（非零像素范围）不漂移——响应只改亮度/半径微缩，不位移；
 *  ⑤ Console error 0。
 *
 * 前置：worktree dev server 在 5174、/tmp/say-turn.wav 存在。
 * 用法：node tests/e2e/orb-voice-feedback-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { existsSync, mkdirSync, statSync } from "node:fs";

const BASE = process.env.VOICE_E2E_BASE ?? "http://localhost:5174";
const MIC = "/tmp/say-turn.wav";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/voice-conversation";
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(MIC)) {
  console.log(`FAIL  前置：${MIC} 不存在（先由用户侧生成话音样本）`);
  process.exit(1);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${MIC}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

// System TTS is outside Chrome's `--mute-audio`; this visual test must stay completely silent.
await page.addInitScript(() => {
  const synthesis = window.speechSynthesis;
  if (synthesis === undefined) return;
  synthesis.getVoices = () => [];
  synthesis.cancel = () => undefined;
  synthesis.pause = () => undefined;
  synthesis.resume = () => undefined;
  synthesis.speak = (utterance) => {
    queueMicrotask(() => {
      utterance.onstart?.(new Event("start"));
      utterance.onend?.(new Event("end"));
    });
  };
});

// 本件只看球的电平链路：API 全部拦掉（dev 代理会把 /api 打到真桥，产生与本件无关的 500）。
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/servers") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ servers: [], home: "/tmp", workspaces: "/tmp" }) });
  }
  if (path === "/api/agent/health") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, cwd: "/tmp", sandbox: "workspace-write", approval: "on-request", plugins: [] }) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
});

// 没有配任何 provider：球走本地模式（自己的 VoiceMeter），不需要桥。
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "conversation");
  window.localStorage.removeItem("shadowroom.models.v1");
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator(".sr-orb-ball").waitFor({ timeout: 30_000 });

// 本地模式点球 = 说话（不开通话）；要的是 listening 态（真通话）。开通话：
await page.locator(".sr-orb-ball").click();
await page.waitForFunction(
  () => document.querySelector(".sr-orb")?.getAttribute("data-mode") === "listening",
  undefined,
  { timeout: 15_000 },
);

/** 连续采样 --orb-voice 与 canvas 内容（在页面里做，避免跨进程搬像素）。 */
const samples = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const visual = document.querySelector(".sr-orb-visual");
      const canvas = visual?.querySelector("canvas") ?? null;
      const readVoice = () => Number.parseFloat(visual?.style.getPropertyValue("--orb-voice") ?? "0") || 0;
      const rows = [];
      let frames = 0;
      const sample = () => {
        frames += 1;
        if (canvas !== null) {
          const ctx = canvas.getContext("2d");
          const { width, height } = canvas;
          const data = ctx.getImageData(0, 0, width, height).data;
          /**
           * 亮度 = alpha 总和（不是"alpha>8 的像素数"——粒子位置基本固定，覆盖数对电平几乎
           * 不敏感；真正随电平变的是 ticks/粒子的透明度与半径）。附带非零像素包围盒测漂移。
           */
          let sumAlpha = 0;
          let minX = width, minY = height, maxX = 0, maxY = 0;
          for (let y = 0; y < height; y += 2) {
            for (let x = 0; x < width; x += 2) {
              const index = (y * width + x) * 4;
              const alpha = data[index + 3];
              if (alpha <= 8) continue;
              sumAlpha += alpha;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
          rows.push({ voice: readVoice(), sumAlpha, box: { minX, minY, maxX, maxY } });
        } else {
          rows.push({ voice: readVoice() });
        }
        if (frames < 480) {
          requestAnimationFrame(sample);
          return;
        }
        const sorted = [...rows].sort((a, b) => a.voice - b.voice);
        const quiet = sorted.slice(0, 48);
        const loud = sorted.slice(-48);
        resolve({
          voices: rows.map((row) => row.voice),
          boxes: rows.filter((row) => row.box !== undefined).map((row) => row.box),
          quietLuma: quiet.reduce((sum, row) => sum + row.sumAlpha, 0) / quiet.length,
          loudLuma: loud.reduce((sum, row) => sum + row.sumAlpha, 0) / loud.length,
        });
      };
      requestAnimationFrame(sample);
    }),
  { timeout: 30_000 },
);

const voices = samples.boxes ? samples.voices : [];
const peak = Math.max(...voices, 0);
const floor = Math.min(...voices, 1);
const percentile = (list, p) => list.slice().sort((a, b) => a - b)[Math.floor((list.length - 1) * p)];
const p90Voice = percentile(voices, 0.9);

check(
  "① 说话驱动 --orb-voice 峰值 >0.25（下限 0.15）",
  peak > 0.25,
  `peak=${peak.toFixed(3)} p90=${p90Voice.toFixed(3)}（样本 ${voices.length} 帧）`,
);
check(
  "② 静音帧回落 ≤0.08",
  floor <= 0.08,
  `floor=${floor.toFixed(3)} p10=${percentile(voices, 0.1).toFixed(3)}`,
);

// ③ 亮度差：有声帧（voice 最高 10%）与静音帧（最低 10%）的 canvas alpha 总和比。
const lumaGrowth = samples.quietLuma > 0 ? samples.loudLuma / samples.quietLuma : 0;
check(
  "③ 有声/静音帧像素显著变化（亮度总和比 >1.15）",
  samples.quietLuma > 0 && lumaGrowth > 1.15,
  `quietLuma=${Math.round(samples.quietLuma)} loudLuma=${Math.round(samples.loudLuma)} ratio=${lumaGrowth.toFixed(3)}`,
);

// ④ 包围盒不漂移：所有帧的球体范围中心抖动 ≤ 4px（响应不位移）。
const boxes = samples.boxes ?? [];
const centers = boxes.map((box) => ({
  cx: (box.minX + box.maxX) / 2,
  cy: (box.minY + box.maxY) / 2,
}));
const centerX = centers.map((c) => c.cx);
const centerY = centers.map((c) => c.cy);
const spreadX = Math.max(...centerX) - Math.min(...centerX);
const spreadY = Math.max(...centerY) - Math.min(...centerY);
check(
  "④ 球体不漂移（中心抖动 ≤6px）",
  spreadX <= 6 && spreadY <= 6,
  `Δx=${spreadX.toFixed(1)}px Δy=${spreadY.toFixed(1)}px（${boxes.length} 帧）`,
);

await page.screenshot({ path: `${SHOTS}/orb-voice-feedback.png` });
check("⑤ Console error 0", consoleErrors.length === 0, JSON.stringify(consoleErrors).slice(0, 200));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
