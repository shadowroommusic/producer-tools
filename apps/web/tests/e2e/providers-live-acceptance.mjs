/**
 * Manual live provider acceptance (real key, real upstream requests).
 *
 * It never prints or stores the key: requests only carry a credential name and the bridge resolves
 * the value from ~/.shadowroom/credentials.json. The TTS → STT round trip proves both media adapters
 * end to end instead of treating two green "connect" probes as sufficient.
 *
 * Prerequisites: agent bridge on :8788 and a stored MiniMax credential.
 * Usage:
 *   node tests/e2e/providers-live-acceptance.mjs
 *   PROVIDER_TEST_KEY=other-name node tests/e2e/providers-live-acceptance.mjs
 */
import assert from "node:assert/strict";

const BRIDGE = process.env.PROVIDER_TEST_BRIDGE ?? "http://127.0.0.1:8788";
const CREDENTIAL = process.env.PROVIDER_TEST_KEY ?? "minimax";
const BASE_URL = process.env.PROVIDER_TEST_BASE_URL ?? "https://api.minimax.cn/v1";
const results = [];

async function post(path, body) {
  const response = await fetch(`${BRIDGE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${path}: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 240)}`);
  return payload;
}

function check(name, condition, detail) {
  results.push(condition);
  console.log(`${condition ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const agent = await post("/api/agent/providers/test", {
  baseUrl: BASE_URL,
  credentialRef: CREDENTIAL,
  protocol: "openai",
  capability: "agent",
  model: process.env.PROVIDER_TEST_AGENT_MODEL ?? "MiniMax-M3",
});
check("主模型真实回复", agent.ok === true, `${agent.detail} · ${agent.ms} ms`);

const ttsModel = process.env.PROVIDER_TEST_TTS_MODEL ?? "speech-2.8-hd";
const spoken = "帮我做一段两小节的鼓，速度一百二十。";
const tts = await post("/api/agent/providers/tts", {
  baseUrl: BASE_URL,
  credentialRef: CREDENTIAL,
  protocol: "openai",
  protocolName: "custom_endpoint",
  model: ttsModel,
  text: spoken,
  voice: process.env.PROVIDER_TEST_VOICE ?? "male-qn-qingse",
  format: "mp3",
});
check("TTS 返回真实音频", typeof tts.audio === "string" && tts.bytes > 1000, `${tts.bytes} 字节`);

const stt = await post("/api/agent/providers/stt", {
  baseUrl: BASE_URL,
  credentialRef: CREDENTIAL,
  protocol: "openai",
  protocolName: "custom_endpoint",
  model: process.env.PROVIDER_TEST_STT_MODEL ?? "asr-1.0",
  format: "mp3",
  audio: tts.audio,
});
check("STT 识别 TTS 原句", stt.text === spoken, `「${stt.text ?? ""}」· ${stt.duration ?? "?"}s`);

const voices = await post("/api/agent/providers/voices", {
  baseUrl: BASE_URL,
  credentialRef: CREDENTIAL,
  protocolName: "custom_endpoint",
});
check("音色列表来自供应商", voices.source === "provider" && voices.voices.length > 0, `${voices.voices?.length ?? 0} 个音色`);

const image = await post("/api/agent/providers/test", {
  baseUrl: BASE_URL,
  credentialRef: CREDENTIAL,
  protocol: "openai",
  capability: "image",
  model: process.env.PROVIDER_TEST_IMAGE_MODEL ?? "image-01",
});
check("Image 返回真实测试图", image.ok === true, `${image.detail} · ${image.ms} ms`);

const music = await post("/api/agent/providers/test", {
  baseUrl: BASE_URL,
  credentialRef: CREDENTIAL,
  protocol: "openai",
  capability: "music",
  model: process.env.PROVIDER_TEST_MUSIC_MODEL ?? "music-3.0",
});
const musicBlockedByProvider = /MiniMax 音乐 API 已对新用户关闭/.test(music.detail ?? "");
check(
  "音乐接入能明确区分“本地故障”和“供应商停服”",
  music.ok === true || musicBlockedByProvider,
  `${music.ok ? "生成成功" : music.detail} · ${music.ms} ms`,
);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
