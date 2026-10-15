/**
 * 打断救话验收（MiniMax #356 的洞：桥式 STT 下 TTS 播放中打断，那句话被整段丢掉）。
 *
 * 全合成、零真实服务：假麦克风（分段 WAV 循环）+ 假 TTS（桥端点罐头 4s WAV，让「说话中」
 * 窗口足够长）+ transcribe 按调用序返回固定文本 + /api/agent/send 罐头 SSE。
 *
 * 声轨设计（16kHz 单声道循环，周期 13.5s）：
 *   [0.0–1.0s 响]   第一回合：端点检测收句 → transcribe#1 → 提交「第一句」
 *   [1.0–4.5s 静]   静够 700ms 收回合；答案开始播（校准窗口 ~0.3s 落在静音段里，基线≈0）
 *   [4.5–10.5s 响]  答案还在说（TTS 4s）→ 打断：cancel 触发 → 从起音切片 → transcribe#2 →
 *                   救回的「别说了，换成钢琴」作为下一回合提交（本脚本的核心断言）
 *   [10.5–13.5s 静] 收尾安静
 *
 * 断言：
 *   ① 点球进通话；② 首回合走完（send #1 文本=第一句）；③ 打断救话（send #2 文本=救回句，
 *   且 transcribe#2 的音频远小于 #1——证明是切片不是整段缓冲）；④ 挂断干净、零 console error。
 *
 * 前置：5173 dev server。用法：node tests/e2e/call-interrupt-rescue-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.RESCUE_E2E_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/interrupt-rescue";
const PHRASE1 = "帮我做一段两小节的鼓";
const PHRASE2 = "别说了，换成钢琴";

mkdirSync(SHOTS, { recursive: true });

/** 「像人声」的响段：基频+谐波+幅度调制（稳态正弦会被浏览器的噪声抑制当成噪声吃掉）。 */
function micWav(path) {
  const rate = 16000;
  const seconds = 13.5;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  const sample = (t) => {
    if (t < 1.0 || (t >= 4.5 && t < 10.5)) {
      const amp = 0.45 + 0.2 * Math.sin(2 * Math.PI * 4.5 * t);
      return amp * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 551 * t + 1)) / 1.5;
    }
    return 0;
  };
  for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(sample(i / rate) * 28000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

/** 假 TTS 的回答音频：4 秒静音 WAV——听不听得见无所谓，只要「说话中」撑得过打断窗口。 */
function ttsWavBase64() {
  const rate = 16000;
  const n = rate * 4;
  const data = Buffer.alloc(n * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]).toString("base64");
}

/** 与 call-live 验收同形状的设置：stt+tts 都配到桥（端点主机名随意——路由在出网前截住）。 */
const settings = {
  version: 3,
  providers: [
    {
      id: "mock", name: "Mock", baseUrl: "https://mock.invalid/v1", credentialRef: null,
      endpointFormat: "chat_completions", enabled: true, presetSource: "minimax", models: ["mock-1"], modelProfiles: {},
      capabilities: {
        stt: { protocol: "custom_endpoint", baseUrl: "https://mock.invalid", models: ["asr-mock"] },
        tts: { protocol: "custom_endpoint", baseUrl: "https://mock.invalid", models: ["tts-mock"] },
      },
    },
  ],
  roles: {
    agent: null,
    tts: { providerId: "mock", capability: "tts", model: "tts-mock" },
    voice_clone: null,
    stt: { providerId: "mock", capability: "stt", model: "asr-mock" },
    image: null, music: null,
  },
};

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const mic = micWav(join(tmpdir(), "shadowroom-rescue-mic.wav"));
const ttsAudio = ttsWavBase64();
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${mic}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] })).newPage();

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

await page.route("**/api/**", async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
});

const sttCalls = [];
await page.route("**/api/agent/providers/stt", async (route) => {
  const body = route.request().postDataJSON();
  sttCalls.push(body);
  const text = sttCalls.length === 1 ? PHRASE1 : sttCalls.length === 2 ? PHRASE2 : "";
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text, duration: 1, trace_id: "mock" }) });
});
let ttsCalls = 0;
await page.route("**/api/agent/providers/tts", async (route) => {
  ttsCalls += 1;
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ audio: ttsAudio }) });
});

await page.route("**/api/agent/record", async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: "/tmp/rescue-e2e-voice.wav" }) });
});
await page.route("**/api/agent/health", async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"threads":1,"cwd":"/tmp","sandbox":"none"}' });
});
await page.route("**/api/agent/models", async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"models":[]}' });
});
await page.route("**/api/servers", async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"servers":[],"home":"/tmp","workspaces":"/tmp"}' });
});

try {
  await page.addInitScript((seed) => {
    window.localStorage.setItem("shadowroom.view", "workbench");
    window.localStorage.setItem("shadowroom.models.v1", JSON.stringify(seed));
    // /api/agent/send 的罐头：真 ReadableStream 分帧（每帧 250ms）。route.fulfill 一次整包交付会把
    // delta 与 done 挤进同一次批渲染，撞出「答案未落库、running 已置 false」的空答案竞态——
    // 真实桥是慢流多帧，这里照实仿。提交体记在 window.__rescueSends 供断言。
    window.__rescueSends = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!String(url).includes("/api/agent/send")) return realFetch(input, init);
      try { window.__rescueSends.push(JSON.parse(String(init?.body ?? "{}"))); } catch { /* 断言时可见 */ }
      const encoder = new TextEncoder();
      const frames = [
        'data: {"type":"delta","text":"好的。马上就做。"}',
        'data: {"type":"delta","text":"第二句让它说久一点，给你时间打断。"}',
        'data: {"type":"done"}',
      ];
      const stream = new ReadableStream({
        async start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`${frame}\n\n`));
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    };
  }, settings);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);

  // ① 点球 = 开始通话
  await page.locator(".sr-orb-ball").click();
  await page.waitForTimeout(1200);
  const mode = await page.locator(".sr-orb").getAttribute("data-mode");
  check("① 点悬浮球开始通话", mode === "listening", `data-mode=${mode}`);

  // ② 首回合：第一段话 → transcribe#1 → 提交进 send#1
  const readSends = () => page.evaluate(() => window.__rescueSends ?? []);
  let sent1 = null;
  for (let i = 0; i < 24 && sent1 === null; i += 1) {
    await page.waitForTimeout(500);
    sent1 = (await readSends()).find((s) => s.text === PHRASE1) ?? null;
  }
  check("② 第一回合提交（假麦克风 → transcribe#1 → send）", sent1 !== null,
    sent1 === null ? `sends=${JSON.stringify((await readSends()).map((s) => s.text))}` : `text=「${sent1.text}」，stt 调用 ${sttCalls.length} 次`);

  // ③ 打断救话：TTS 说话中第二段响 → cancel → 起音切片 → transcribe#2 → send#2 = 救回句
  let sent2 = null;
  let sendsNow = [];
  for (let i = 0; i < 30 && sent2 === null; i += 1) {
    await page.waitForTimeout(500);
    sendsNow = await readSends();
    sent2 = sendsNow.find((s) => s.text === PHRASE2) ?? null;
  }
  const rescueBytes = sttCalls[1]?.audio?.length ?? 0;
  const firstBytes = sttCalls[0]?.audio?.length ?? 1;
  check("③ 打断的话被救回并作为下一回合提交", sent2 !== null,
    sent2 === null
      ? `未等到「${PHRASE2}」：sends=${JSON.stringify(sendsNow.map((s) => s.text))}，stt 调用 ${sttCalls.length} 次`
      : `text=「${sent2.text}」，走的是第 ${sendsNow.findIndex((s) => s.text === PHRASE2) + 1} 次提交`);
  check("④ 救的是起音切片，不是整段缓冲", rescueBytes > 0 && rescueBytes < firstBytes / 2,
    `transcribe#1 ≈ ${Math.round(firstBytes / 1024)}KB（整回合） vs #2 ≈ ${Math.round(rescueBytes / 1024)}KB（切片）`);
  check("⑤ TTS 真的被叫过（说话中窗口存在）", ttsCalls > 0, `tts 合成 ${ttsCalls} 次`);

  await page.screenshot({ path: `${SHOTS}/interrupt-rescue.png` });

  // ⑥ 挂断（回合可能还在收尾，等球回 idle）
  await page.locator(".sr-orb-ball").click();
  let modeEnd = "working";
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(1000);
    modeEnd = await page.locator(".sr-orb").getAttribute("data-mode");
    if (modeEnd !== "working") break;
  }
  check("⑥ 挂断干净", modeEnd === "idle", `data-mode=${modeEnd}`);
  check("⑦ 零 console error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
console.log(`SHOT  ${SHOTS}/interrupt-rescue.png`);
process.exit(failed === 0 ? 0 : 1);
