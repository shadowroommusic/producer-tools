/**
 * S6 验收：Studio 波形改吃库 peaks。
 *
 * ① 打桩计数：在库文件渲染波形时 decodeAudioData 调用 0 次（音频字节根本不fetch）；
 * ② 渲染桶数 == 库 peaks 桶数（64），且每根柱子的高度与库 peaks 归一化后逐根相等（形状对）；
 * ③ 播放/暂停/seek/停止 行为不回退；④ 零 console error。
 *
 * 前置：5173（vite）+ 8787（mcp 桥）+ 8788（agent 桥）都在跑；库里有一首带 peaks 的 WAV。
 * 用法：node tests/e2e/studio-wave-peaks-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const BRIDGE = "http://127.0.0.1:8787";
const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

// ---- 地面真值：从活桥拿一首带 64 桶 peaks 的在库 WAV
const call = async (tool, args) => {
  const res = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server: "library", tool, arguments: args }),
  });
  const body = await res.json();
  if (body.isError) throw new Error(`${tool}: ${body.result}`);
  // 桥把 MCP 文本内容塞进 result：结构化数据是一坨 JSON 字符串
  return typeof body.result === "string" ? JSON.parse(body.result) : body.result;
};
const { tracks } = await call("list_tracks", { limit: 100000 });
let track = null;
let detail = null;
for (const row of tracks) {
  if (!/\.wav$/i.test(row.path ?? "")) continue;
  const d = await call("track_detail", { id: row.id });
  if (Array.isArray(d.peaks) && d.peaks.length === 64 && d.duration_ms > 3000) {
    track = row;
    detail = d;
    break;
  }
}
if (track === null) throw new Error("库里没有带 64 桶 peaks 的 WAV，验收无从谈起");
const loudest = Math.max(...detail.peaks, 0.0001);
const expectedHeights = detail.peaks.map((p) => Math.max(6, Math.round(Math.min(1, p / loudest) * 100)));
console.log(`素材：#${track.id} ${track.title}（${track.path}），库 peaks 64 桶，loudest=${loudest}`);

const BPM = 128;
const barMs = (60000 / BPM) * 4;
const clipBars = Math.round((detail.duration_ms / barMs) * 100) / 100;
const project = {
  id: "project-s6-wave",
  name: "S6 波形验收",
  updatedAt: Date.now(),
  bpm: BPM,
  key: "8A",
  bars: Math.ceil(clipBars) + 4,
  tracks: [
    {
      id: "track-s6",
      name: "Audio",
      muted: false,
      soloed: false,
      volume: 80,
      type: "audio",
      color: 0,
      clips: [
        { id: "clip-s6", name: track.title, start: 0, length: clipBars, source: track.path, duration_ms: detail.duration_ms },
      ],
    },
  ],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.addInitScript(
  ({ projectJson, openId }) => {
    // decodeAudioData 打桩计数：库路径下必须是 0
    window.__decodeCount = 0;
    const original = window.AudioContext.prototype.decodeAudioData;
    window.AudioContext.prototype.decodeAudioData = function (...args) {
      window.__decodeCount += 1;
      return original.apply(this, args);
    };
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.studio.projects.v1", projectJson);
    window.localStorage.setItem("shadowroom.studio.open", openId);
    window.localStorage.removeItem("shadowroom.dock");
  },
  { projectJson: JSON.stringify({ projects: [project] }), openId: project.id },
);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-clip-wave i", { timeout: 30000 });
await page.waitForTimeout(600);

// ---- ① decodeAudioData 计数为 0
const decodeCount = await page.evaluate(() => window.__decodeCount);
check("① 在库渲染 decodeAudioData 调用 0 次", decodeCount === 0, `decodeAudioData=${decodeCount}`);

// ---- ② 桶数与库一致，逐根高度相等
const heights = await page.$$eval(".sr-clip-wave i", (bars) => bars.map((bar) => Number(bar.style.height.replace("%", ""))));
check(
  "② 桶数 == 库 peaks（64）且形状逐根对得上",
  heights.length === expectedHeights.length && heights.every((h, i) => h === expectedHeights[i]),
  `渲染 ${heights.length} 桶 / 库 ${expectedHeights.length} 桶；前 8 根 渲染=[${heights.slice(0, 8)}] 库=[${expectedHeights.slice(0, 8)}]；峰值 ${Math.max(...heights)}%`,
);

// ---- ③ 走带回退：播放前进、暂停冻结、ruler seek、停止归零
const positionText = () => page.locator(".sr-transport-position").textContent();
const initial = await positionText();
await page.getByRole("button", { name: "播放", exact: true }).click();
await page.waitForFunction((before) => document.querySelector(".sr-transport-position").textContent !== before, initial, { timeout: 10000 });
const playing = await positionText();
await page.getByRole("button", { name: "暂停", exact: true }).click();
await page.waitForTimeout(300);
const pausedA = await positionText();
await page.waitForTimeout(600);
const pausedB = await positionText();

const ruler = page.locator(".sr-studio-ruler").first();
const box = await ruler.boundingBox();
await ruler.click({ position: { x: box.width * 0.6, y: box.height / 2 } });
await page.waitForTimeout(300);
const seeked = await positionText();

await page.getByRole("button", { name: "停止", exact: true }).click();
await page.waitForTimeout(300);
const stopped = await positionText();

const seekBar = Number((seeked.match(/^(\d+)/) ?? [])[1]);
check(
  "③ 播放/暂停/seek/停止 不回退",
  playing !== initial && pausedA === pausedB && seekBar >= 5 && stopped === initial,
  `播放 ${initial.trim()}→${playing.trim()}；暂停冻结=${pausedA === pausedB}；ruler 60% 处 seek→第 ${seekBar} 小节；停止→${stopped.trim()}`,
);

// ---- ④ 零 console error
check("④ 零 console error", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(" | ").slice(0, 200) : "clean");

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
