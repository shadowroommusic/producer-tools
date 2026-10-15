/**
 * 通话功能 live 验收（Codex，2026-10-16）：真模型全链路，**不是**合成事件。
 *
 * 链路：点悬浮球开始通话 → Chrome 用假麦克风播放一段真人话（TTS 合成的「帮我做一段两小节的鼓，
 * 速度一百二十。」）→ 端点检测收回合 → 桥式 STT（MiniMax asr-1.0，key 在桥里）→ 文本进会话 →
 * 真模型回合（Codex core）→ TTS 合成回复（MiniMax t2a）→ 球回到 listening。
 *
 * 为什么这么测：在这之前 App 的 STT 只有浏览器自带那一条——Chrome 要连 Google 的识别服务，
 * 国内不通；桌面包里干脆没有。用户 2026-10 的实测结论「根本用不了」是真实的。这条验收跑通
 * = 通话在「没有 Google、没有浏览器识别」的环境里也能工作。
 *
 * 人工触发（花一轮模型 token + 一次 MiniMax 识别/合成），不进 pnpm test。
 * 前置：5173 + 8787 + 8788 在跑；~/.shadowroom/credentials.json 有 miniamx；/tmp/say-turn.wav 在。
 * 用法：node tests/e2e/call-live-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { existsSync, mkdirSync } from "node:fs";

const BASE = process.env.CALL_E2E_BASE ?? "http://localhost:5173";
const VOICE_WAV = process.env.CALL_E2E_WAV ?? "/tmp/say-turn.wav";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/call-live";
const EXPECTED = "帮我做一段两小节的鼓";

mkdirSync(SHOTS, { recursive: true });
if (!existsSync(VOICE_WAV)) {
  console.log(`FAIL  环境 — 假麦克风音频不在：${VOICE_WAV}`);
  process.exit(1);
}

const settings = {
  version: 3,
  providers: [
    {
      id: "minimax",
      name: "MiniMax",
      baseUrl: "https://api.minimaxi.com/v1",
      credentialRef: "miniamx",
      endpointFormat: "chat_completions",
      enabled: true,
      presetSource: "minimax",
      models: ["MiniMax-M3"],
      modelProfiles: {},
      capabilities: {
        stt: { protocol: "minimax-asr", baseUrl: "https://api.minimaxi.com", models: ["asr-1.0"] },
        tts: { protocol: "minimax-t2a", baseUrl: "https://api.minimaxi.com", models: ["speech-2.8-hd"] },
      },
    },
  ],
  roles: {
    agent: null,
    tts: { providerId: "minimax", capability: "tts", model: "speech-2.8-hd" },
    voice_clone: null,
    stt: { providerId: "minimax", capability: "stt", model: "asr-1.0" },
    image: null,
    music: null,
  },
};

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${VOICE_WAV}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] })).newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
const sttCalls = [];
const ttsCalls = [];
await page.route("**/api/agent/providers/stt", async (route) => {
  sttCalls.push(route.request().postDataJSON());
  await route.continue();
});
await page.route("**/api/agent/providers/tts", async (route) => {
  ttsCalls.push(route.request().postDataJSON());
  await route.continue();
});
try {
  await page.addInitScript((seed) => {
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.models.v1", JSON.stringify(seed));
    window.localStorage.removeItem("shadowroom.studio.open");
  }, settings);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);

  // ① 点球 = 开始真通话（不是本地电平演示）
  await page.locator(".sr-orb-ball").click();
  await page.waitForTimeout(1200);
  const modeAfterClick = await page.locator(".sr-orb").getAttribute("data-mode");
  check("① 点悬浮球开始通话", modeAfterClick === "listening", `data-mode=${modeAfterClick}`);

  // ② 假麦克风说话 → 端点检测收回合 → 桥式 STT 收到音频
  let sttOk = false;
  for (let i = 0; i < 40 && !sttOk; i += 1) {
    await page.waitForTimeout(1000);
    sttOk = sttCalls.length > 0 && typeof sttCalls[0]?.audio === "string" && sttCalls[0].audio.length > 1000;
  }
  check("② 录音交给桥式 STT（MiniMax asr-1.0）", sttOk,
    `stt 调用 ${sttCalls.length} 次，首包 ${Math.round((sttCalls[0]?.audio?.length ?? 0) / 1024)}KB，model=${sttCalls[0]?.model}`);

  // ③ 识别文本进了会话（transcript 出现原句）
  let heard = false;
  let transcript = "";
  for (let i = 0; i < 60 && !heard; i += 1) {
    await page.waitForTimeout(1000);
    transcript = await page.locator(".sr-transcript, .sr-dock-transcript").first().innerText().catch(() => "");
    if (transcript.includes(EXPECTED)) heard = true;
    // 回合可能被当成「没听清」重来：允许它自己再录一次（假麦克风在循环播）。
    if (!heard && /没听清|识别失败/.test(transcript)) {
      sttOk = true; // 记下但继续等下一轮
    }
  }
  check("③ 识别出的原句进入会话", heard, heard ? `找到「${EXPECTED}」` : `transcript 尾部：${transcript.replace(/\n+/g, " | ").slice(-200)}`);

  // ④ 回复被 TTS 合成（MiniMax t2a），球说 → 听
  let ttsOk = ttsCalls.length > 0;
  for (let i = 0; i < 60 && !ttsOk; i += 1) {
    await page.waitForTimeout(1000);
    ttsOk = ttsCalls.length > 0;
  }
  check("④ 回复走 TTS（MiniMax t2a）", ttsOk,
    ttsOk ? `${ttsCalls.length} 次合成，首句「${String(ttsCalls[0]?.text ?? "").slice(0, 40)}」` : "没有 TTS 请求");

  await page.screenshot({ path: `${SHOTS}/call-live.png` });
  const modeEnd = await page.locator(".sr-orb").getAttribute("data-mode");
  check("⑤ 零 console error", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "clean");
  console.log(`（收尾时球态：${modeEnd}）`);

  // ⑥ 再点一次 = 挂断。注意：回合可能还在跑，球此时按设计显示 working——
  // 所以「挂断」的正确判据是**回合收尾后球回 idle**（还在通话则会回到 listening）。
  await page.locator(".sr-orb-ball").click();
  let modeHangup = "working";
  for (let i = 0; i < 180; i += 1) {
    await page.waitForTimeout(1000);
    modeHangup = await page.locator(".sr-orb").getAttribute("data-mode");
    if (modeHangup !== "working") break;
  }
  check("⑥ 再点球挂断（回合收尾后球回 idle）", modeHangup === "idle", `data-mode=${modeHangup}`);
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
