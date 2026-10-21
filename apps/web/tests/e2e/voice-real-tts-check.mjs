/**
 * voice-conversation S6 · 真 MiniMax TTS 验证（打常驻 8788 桥的真端点，不 mock）。
 *
 * 验收点：① 两个不同 voice 的合成请求各自带回音频（voice 参数真实生效——同文本不同音色，
 * 返回的字节数应有差异且均可解码出 wav 头）；② 坏 voice 失败并回真实错误原文（前端拿它
 * 显示并触发系统回退——回退链在 mock e2e D8 已全链验证）。
 *
 * 只做 3 次合成请求（两好一坏），不改任何用户数据；凭证名只引用、不打印值。
 * 用法：node tests/e2e/voice-real-tts-check.mjs
 */
const BRIDGE = "http://127.0.0.1:8788";
const PROVIDER = {
  baseUrl: "https://api.minimaxi.com",
  credentialRef: "miniamx",
  protocol: "custom_endpoint",
  model: "speech-2.8-hd",
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const post = async (path, body) => {
  const response = await fetch(`${BRIDGE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

// ① 拉真实音色列表。
const voicesResponse = await post("/api/agent/providers/voices", PROVIDER);
const voices = Array.isArray(voicesResponse.data.voices) ? voicesResponse.data.voices : [];
check(
  "R0 MiniMax 真音色列表可拉取",
  voices.length > 2,
  `voices=${voices.length} status=${voicesResponse.status} first=${JSON.stringify(voices[0] ?? null)}`,
);

const [voiceA, voiceB] = voices;
const synthesize = async (voice) => {
  const started = Date.now();
  const response = await post("/api/agent/providers/tts", { ...PROVIDER, text: "你好，这是真机音色验证。", voice });
  return { ...response, ms: Date.now() - started };
};

// ② 两个不同 voice：都带回可解码音频（RIFF=wav 或 ID3=mp3——MiniMax 默认 mp3，
// 前端 decodeAudioData 两种都能解），耗时记录。
const a = await synthesize(voiceA.id);
const aBytes = a.data.audio ? Math.round((a.data.audio.length * 3) / 4) : 0;
const aHead = a.data.audio ? atob(a.data.audio.slice(0, 8)).slice(0, 4) : "";
const aValid = aHead === "RIFF" || aHead.startsWith("ID3");
check(
  "R1 voice A 合成成功（有效音频容器）",
  a.status === 200 && aValid && aBytes > 1000,
  `voice=${voiceA.id} bytes≈${aBytes} container=${JSON.stringify(aHead.slice(0, 4))} ms=${a.ms}`,
);

const b = await synthesize(voiceB.id);
const bBytes = b.data.audio ? Math.round((b.data.audio.length * 3) / 4) : 0;
const bHead = b.data.audio ? atob(b.data.audio.slice(0, 8)).slice(0, 4) : "";
const bValid = bHead === "RIFF" || bHead.startsWith("ID3");
check(
  "R2 voice B 合成成功（有效音频容器，与 A 不同音色、不同字节）",
  b.status === 200 && bValid && bBytes > 1000 && voiceB.id !== voiceA.id && bBytes !== aBytes,
  `voice=${voiceB.id} bytes≈${bBytes} container=${JSON.stringify(bHead.slice(0, 4))} ms=${b.ms}`,
);

// ③ 坏 voice：真实错误原文（前端据此提示并回退系统）。
const bad = await synthesize("definitely-not-a-voice-e2e");
check(
  "R3 坏 voice 失败并回真实错误原文",
  (bad.data.audio === undefined || bad.data.audio === "") && typeof bad.data.error === "string" && bad.data.error !== "",
  `error="${String(bad.data.error ?? "").slice(0, 90)}" ms=${bad.ms}`,
);

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
