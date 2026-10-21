/**
 * voice-conversation-20261020 · S6 mock 验收（11 轮语音 + 同页重播/换音色/回退探针）。
 *
 * 真通话路径（假麦克风 → 端点检测 → 桩 STT → 桩模型 SSE → 桩 bridge TTS），不花 token、不碰
 * 真实数据。朗读版内容的观察点是 **TTS 桩收到的每句合成请求**——那是真正"被念"的东西；
 * 每轮的 marks（__callProbe，页面级）提供延迟/回退读数。
 *
 * 结构（假麦克风的爆发只在「采集开始」那一刻，每轮语音用新 context 才有干净回合——与
 * call-five-states 同款）：
 *  - 11 个语音轮（8 brief + 3 detail），每轮新 context，记录该轮 TTS 区间与 marks；
 *  - 重播探针：同一页面先语音轮（长回答）再打字轮——打字轮的「上一条 assistant」正是那条
 *    长回答，旧实现的 thinking 窗口会把它重播；断言只念新答案（D1/R4）；
 *  - 换音色（下一句生效）与 bridge 失败回退（提示原文、句序无重复、系统失败不重入队）。
 *
 * 覆盖 Kimi D1–D8/D10–D12 的 mock 部分；打断（D9）走 call-interrupt-rescue 回归件。
 * 前置：worktree dev server 在 5174。用法：node tests/e2e/voice-conversation-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.VOICE_E2E_BASE ?? "http://localhost:5174";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/voice-conversation";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

/* ── 音频 fixture ─────────────────────────────────────────────────────────── */
/** 假麦克风：0–0.9s 一个 440Hz 响音，之后静音（一个回合的「说话」）。 */
function burstWav(seconds = 12, rate = 44100) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < Math.floor(0.9 * rate); i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 19660), i * 2);
  }
  return wavContainer(data, rate);
}
/** TTS「合成结果」：200ms 极短静音——一句的播放时长可控，回合不会被音频拖长。 */
function silentWav(ms = 200, rate = 22050) {
  const n = Math.floor((ms / 1000) * rate);
  return wavContainer(Buffer.alloc(n * 2), rate);
}
function wavContainer(data, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const tmp = mkdtempSync(join(tmpdir(), "voice-conv-e2e-"));
writeFileSync(join(tmp, "mic.wav"), burstWav());
const TTS_AUDIO = silentWav(200).toString("base64");

/** 与 call-five-states 同形的设置：STT/TTS 角色都指向桩端点（按端点认家的 custom_endpoint）。 */
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
        stt: { protocol: "custom_endpoint", baseUrl: "https://api.minimaxi.com", models: ["asr-1.0"] },
        tts: { protocol: "custom_endpoint", baseUrl: "https://api.minimaxi.com", models: ["speech-2.8-hd"] },
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

/* ── 模型回答脚本（11 轮：8 brief + 3 detail） ───────────────────────────── */
/** 用户贴的那段真实「状态报告体」——截断与契约都要对付它。 */
const STATUS_ANSWER =
  "说话了的呀……我在：你正停在曲目库，51 首都在库里。你刚才在曲目库和 Studio 之间来回切了 10 趟，" +
  "每次切换我都看在眼里。我这边的职责边界：我只干三件事——排 set、改标签、查重复，" +
  "别的我不会自己假装做完。详见 https://example.com/docs 和 /Users/lazora/Documents/ShadowRoom/library.db，" +
  "工具日志：MCP · library · stats ✓ 180ms。";

const ROUNDS = [
  { user: "你好", deltas: ["你好！我在，", "想做什么？"], brief: true },
  { user: "为什么刚才不说话", deltas: ["刚才那轮识别成了空白，我这边没有收到话。", "现在能听到了，你说。"], brief: true },
  // 语音契约下，状态问题也要先给用户真正关心的结论，而不是把整个上下文倒出来。
  // 故意使用反例 `STATUS_ANSWER` 只能放在“上一轮长回答不得重播”的探针里，不能当作合规回答。
  { user: "现在库里什么情况", deltas: ["库里有 51 首，没发现异常。"], brief: true },
  { user: "帮我排一个 30 分钟的 set", deltas: ["<think>用户要 set，先看库里有什么。</think>排好了，", "12 首 tech house，能量递进，总长 29 分钟。"], brief: true },
  { user: "把第一首换成更狠的", deltas: ["换好了，", "开场改成 Supreme 了。"], brief: true },
  { user: "详细说一下这个 set", deltas: ["这个 set 一共 12 首。", "前三首用 124–126 BPM 热身，中段两首 vocal 拉情绪，", "drop 段连放四首 128 BPM，最后收在一首 122 的 deep house 上。", "整段 29 分钟，过渡都对过拍。"], detail: true },
  { user: "导出它", deltas: ["导出完成，文件在录音文件夹里。"], brief: true },
  { user: "再来一版更暗的", deltas: ["好了。", "bass 加重、hat 收半，结构没动。"], brief: true },
  { user: " Cue 都标了吗", deltas: ["标了，8 个 cue 都在。"], brief: true },
  { user: "详细说说 cue 放在哪几首", deltas: ["前四首各两个。", "第 2、4 首的 drop 前各一个，第 1 首的 intro 里有一个。", "剩下的在人声进来的位置，按小节对齐过。"], detail: true },
  { user: "详细说说第 8 首", deltas: ["第 8 首是 Supreme。", "124 BPM，a 小调，用它把场面压住。", "它的 bassline 走三连音，和第 9 首的 drop 能无缝接上。"], detail: true },
];

const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
/** 与 lib/speech-text 同口径的字数（空白不计，每字符算 1）。 */
const spokenLength = (text) => Array.from(text.replace(/\s+/g, "")).length;

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${join(tmp, "mic.wav")}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/**
 * System TTS is an OS service, not tab audio: Chrome's `--mute-audio` does not mute it.
 * A fallback round once spoke its fixture out loud on the user's Mac. Keep every browser test
 * silent by replacing only `speechSynthesis` with an in-page callback-compatible stub.
 */
async function installSilentSystemTts(page) {
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
}

/* 观察点（跨轮收集）：TTS 桩收到的每次合成、每次 send 请求体、console error。 */
const ttsLog = [];
const sendBodies = [];
const consoleErrors = [];
let ttsFail = false;
let sendScript = null; // (index) => events；默认按 ROUNDS，探针轮可覆盖

/** 每轮一个新 context：route/初始化都挂在新页上，roundIndex 决定 STT 与模型脚本。 */
async function newRoundPage(roundIndex) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/servers") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ servers: [], home: "/tmp", workspaces: "/tmp" }) });
    if (path === "/api/agent/health") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, threads: 0, cwd: "/tmp", sandbox: "workspace-write", approval: "on-request", plugins: [] }) });
    }
    if (path === "/api/agent/models") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) });
    }
    if (path === "/api/agent/media-events") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) });
    }
    if (path === "/api/agent/use-provider") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider: null }) });
    }
    if (path === "/api/call") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: "{}", isError: false, ms: 1 }) });
    }
    if (path === "/api/agent/record") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: `/tmp/voice-e2e-${Date.now()}.wav` }) });
    }
    if (path === "/api/agent/providers/stt") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: ROUNDS[roundIndex].user }) });
    }
    if (path === "/api/agent/providers/tts") {
      const body = route.request().postDataJSON();
      ttsLog.push({ round: roundIndex, text: String(body.text ?? ""), voice: body.voice ?? null, at: performance.now() });
      if (ttsFail) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "音色 speech-bad 不存在（HTTP 404）" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ audio: TTS_AUDIO }) });
    }
    if (path === "/api/agent/send") {
      const body = route.request().postDataJSON();
      sendBodies.push({ round: roundIndex, body });
      const index = Math.min(roundIndex, ROUNDS.length - 1);
      const turnId = `t-${index}`;
      const events = [{ type: "turn", threadId: "th-1", turnId }];
      ROUNDS[index].deltas.forEach((text) => {
        events.push({ type: "delta", itemId: `m-${index}`, turnId, text });
      });
      events.push({ type: "usage", turnId, usage: { last: { totalTokens: 100 } } });
      events.push({ type: "done", turn: { status: "completed" } });
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(sendScript === null ? events : sendScript(index)) });
    }
    console.log(`[404] ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not mocked" }) });
  });
  await installSilentSystemTts(page);
  await page.addInitScript((seed) => {
    // headless 的 macOS chrome 有 native speechSynthesis 但 speak 不回调（无音频设备）：
    // 无条件换成可播的假实现（bridge 链路不走它），并记录 system 真正「播」的句子。
    {
      const stubVoice = { voiceURI: "e2e-stub", name: "E2e Stub", lang: "zh-CN", default: true, localService: true, voiceService: "stub" };
      // speechSynthesis 在 window 上是只读 getter，直接赋值会静默失败（实测 headless 仍是 native）。
      const stub = {
        getVoices: () => [stubVoice],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        cancel: () => undefined,
        speak: (utterance) => {
          (window.__stubSpoken ??= []).push(utterance.text);
          setTimeout(() => {
            utterance.onstart?.();
            utterance.onend?.();
          }, 30);
        },
      };
      try {
        Object.defineProperty(window, "speechSynthesis", { value: stub, configurable: true, writable: true });
      } catch { /* 极端环境定义失败就交由 native 失败路径 */ }
    }
    window.localStorage.setItem("shadowroom.view", "conversation");
    window.localStorage.setItem("shadowroom.models.v1", JSON.stringify(seed));
    window.localStorage.setItem("shadowroom.tts.voice", "speech-2.8-hd-female");
    window.localStorage.removeItem("shadowroom.studio.open");
  }, settings);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator(".sr-orb-ball").waitFor({ timeout: 30_000 });
  return { context, page };
}

/** 开通话 → 假麦克风爆发 → 桩 STT → 桩模型 → 全部句子合成 → 回 listening。 */
async function runVoiceRound(index) {
  const { context, page } = await newRoundPage(index);
  await page.locator(".sr-orb-ball").click();
  const ttsBefore = ttsLog.length;
  /** 基线必须是页面自己的 attempts（页面级从 0 起），不能拿全局 ttsLog 计数比。 */
  const attemptsBefore = await page.evaluate(() => window.__callProbe?.marks().ttsAttempts ?? 0);
  await page.waitForFunction(
    (count) => (window.__callProbe?.marks().ttsAttempts ?? 0) > count,
    attemptsBefore,
    { timeout: 45_000 },
  ).catch(() => undefined);
  await page.waitForFunction(
    () => document.querySelector(".sr-orb")?.getAttribute("data-mode") === "listening",
    undefined,
    { timeout: 45_000 },
  ).catch(() => undefined);
  await page.waitForTimeout(300);
  const marks = await page.evaluate(() => window.__callProbe?.marks());
  const spoken = ttsLog.slice(ttsBefore).map((entry) => entry.text);
  await context.close();
  return { marks, spoken };
}

/* ── 11 个语音轮 ─────────────────────────────────────────────────────────── */
const roundData = [];
for (let index = 0; index < ROUNDS.length; index += 1) {
  const { marks, spoken } = await runVoiceRound(index);
  roundData.push({ index, marks, spoken });
  console.log(`round ${index + 1}: 句=${spoken.length} 「${spoken.join(" / ").slice(0, 60)}」`);
}
await (await newRoundPage(0)).context.close().catch(() => undefined); // noop guard

/* ── 断言区 ──────────────────────────────────────────────────────────────── */
// D3/D4：按轮区间断句数与字数。
let briefPass = 0;
let briefTotal = 0;
let detailPass = 0;
const briefDetails = [];
for (const { index, spoken } of roundData) {
  const chars = spoken.reduce((sum, sentence) => sum + spokenLength(sentence), 0);
  if (ROUNDS[index].detail) {
    if (spoken.length >= 3 && chars <= 360) detailPass += 1;
  } else {
    briefTotal += 1;
    if (spoken.length <= 2 && chars <= 70) briefPass += 1;
    else briefDetails.push(`r${index + 1}:${spoken.length}句/${chars}字`);
  }
}
check("D3 默认短答 ≤2 句且 ≤70 字（8/8 达标，验收线 8/10）", briefPass === briefTotal, `brief ${briefPass}/${briefTotal} ${briefDetails.join(";")}`);
check("D4 「详细说」3/3 ≥3 句且 ≤360 字", detailPass === 3, `detail ${detailPass}/3`);

// D2：禁念内容 0（全部朗读输出）。
const spokenAll = roundData.flatMap((round) => round.spoken).join("\n");
for (const [needle, label] of [["<think", "think 标签"], ["https://", "URL"], ["/Users/", "绝对路径"], ["MCP", "工具日志"], ["✓", "日志勾"], ["library.db", "库文件名"]]) {
  check(`D2 ${label} 朗读 0`, !spokenAll.includes(needle), spokenAll.includes(needle) ? spokenAll.slice(0, 80) : "clean");
}

// D5：状态播报标记。
const statusMarks = ["你正停在", "来回切", "只干三件事", "不会自己假装", "职责"];
const leakedRounds = roundData.filter((round) => round.spoken.some((s) => statusMarks.some((mark) => s.includes(mark))));
check("D5 状态播报标记 ≤2/10 轮", leakedRounds.length <= 2, `leaked=${leakedRounds.map((r) => r.index + 1).join(",") || "none"}`);

// D6：问号 ≤1/轮。
const questionRounds = roundData.filter((round) => (round.spoken.join("").match(/？|\?/g) ?? []).length > 1);
check("D6 问号 ≤1/轮（11/11）", questionRounds.length === 0, `violations=${questionRounds.map((r) => r.index + 1).join(",") || "none"}`);

// D10/D11/D12：延迟（mock 管线，阈值是产品真阈值——mock 下应远低于）。
const firstVoiceDelays = roundData
  .map((round) => (round.marks?.firstSpeakStartAt ?? 0) - (round.marks?.turnEndAt ?? 0))
  .filter((value) => Number.isFinite(value) && value > 0)
  .sort((a, b) => a - b);
const p = (list, q) => list[Math.floor((list.length - 1) * q)] ?? 0;
check("D10 首声 p50≤3s / p90≤5s", p(firstVoiceDelays, 0.5) <= 3000 && p(firstVoiceDelays, 0.9) <= 5000, `p50=${Math.round(p(firstVoiceDelays, 0.5))}ms p90=${Math.round(p(firstVoiceDelays, 0.9))}ms n=${firstVoiceDelays.length}`);
const fullPlay = roundData
  .filter((round) => (round.marks?.lastSpeakEndAt ?? 0) > 0 && (round.marks?.firstSpeakStartAt ?? 0) > 0)
  .map((round) => (round.marks?.lastSpeakEndAt ?? 0) - (round.marks?.firstSpeakStartAt ?? 0));
check("D11 brief 完播 p90≤15s", p(fullPlay, 0.9) <= 15_000, `p90=${Math.round(p(fullPlay, 0.9))}ms n=${fullPlay.length}`);
const gaps = [];
for (const { index } of roundData) {
  const times = ttsLog.filter((entry) => entry.round === index).map((entry) => entry.at);
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1] - 200);
}
check("D12 句间停顿（含合成）p90≤600ms", gaps.length === 0 || p(gaps, 0.9) <= 600, `p90=${Math.round(p(gaps, 0.9))}ms n=${gaps.length}`);

// S5：[voice_turn] 注入（send 请求体）+ 不进用户可见消息。
const voiceInjected = sendBodies.filter((entry) => String(entry.body.text ?? "").includes("[voice_turn]"));
check("S5 [voice_turn] 随语音回合注入", voiceInjected.length === sendBodies.length, `${voiceInjected.length}/${sendBodies.length}`);

/* ── 重播探针：同页先语音长答，再打字短问 ──────────────────────────────── */
{
  const { context, page } = await newRoundPage(2);
  // 这里刻意让上一轮变成一条长状态报告，专门验证“新回合绝不能重播旧答案”。
  sendScript = () => [
    { type: "turn", threadId: "th-1", turnId: "long" },
    { type: "delta", itemId: "long-1", turnId: "long", text: STATUS_ANSWER },
    { type: "done", turn: { status: "completed" } },
  ];
  await page.locator(".sr-orb-ball").click();
  const firstBefore = ttsLog.length;
  const firstAttempts = await page.evaluate(() => window.__callProbe?.marks().ttsAttempts ?? 0);
  await page.waitForFunction(
    (count) => (window.__callProbe?.marks().ttsAttempts ?? 0) > count,
    firstAttempts,
    { timeout: 45_000 },
  ).catch(() => undefined);
  await page.waitForFunction(
    () => document.querySelector(".sr-orb")?.getAttribute("data-mode") === "listening",
    undefined,
    { timeout: 45_000 },
  ).catch(() => undefined);
  const firstSpoken = ttsLog.slice(firstBefore).map((entry) => entry.text);

  // 同页打字轮：此刻「上一条 assistant」正是那条长回答——旧实现会重播它。
  sendScript = () => [{ type: "turn", threadId: "th-1", turnId: "typed" }, { type: "delta", itemId: "typed-1", turnId: "typed", text: "好的，" }, { type: "delta", itemId: "typed-1", turnId: "typed", text: "换好了。" }, { type: "done", turn: { status: "completed" } }];
  const secondBefore = ttsLog.length;
  const secondAttempts = await page.evaluate(() => window.__callProbe?.marks().ttsAttempts ?? 0);
  await page.locator(".sr-composer-input").fill("换成第二首");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (count) => (window.__callProbe?.marks().ttsAttempts ?? 0) > count,
    secondAttempts,
    { timeout: 30_000 },
  ).catch(() => undefined);
  await page.waitForFunction(
    () => document.querySelector(".sr-orb")?.getAttribute("data-mode") === "listening",
    undefined,
    { timeout: 30_000 },
  ).catch(() => undefined);
  const secondSpoken = ttsLog.slice(secondBefore).map((entry) => entry.text);
  sendScript = null;
  const replayed = secondSpoken.filter((sentence) => firstSpoken.includes(sentence));
  check(
    "D1 上一轮长回答重播 0（同页 thinking 窗口）",
    secondSpoken.length > 0 && replayed.length === 0,
    `第二轮念了 ${JSON.stringify(secondSpoken)}，与第一轮交集 ${replayed.length}`,
  );
  check(
    "R4 通话中打字回合同样朗读（bind 后开口）",
    secondSpoken.join("").includes("换好了"),
    `spoken=${JSON.stringify(secondSpoken)}`,
  );

  // D7：换 bridge 音色，下一句生效（打字轮触发）。
  await page.evaluate(() => window.localStorage.setItem("shadowroom.tts.voice", "speech-2.8-hd-male"));
  sendScript = () => [{ type: "turn", threadId: "th-1", turnId: "switch" }, { type: "delta", itemId: "switch-1", turnId: "switch", text: "这句该用新音色。" }, { type: "done", turn: { status: "completed" } }];
  const switchBefore = ttsLog.length;
  const switchAttempts = await page.evaluate(() => window.__callProbe?.marks().ttsAttempts ?? 0);
  await page.locator(".sr-composer-input").fill("再说一句");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (count) => (window.__callProbe?.marks().ttsAttempts ?? 0) > count,
    switchAttempts,
    { timeout: 30_000 },
  ).catch(() => undefined);
  const switched = ttsLog.slice(switchBefore);
  sendScript = null;
  check(
    "D7 换 bridge 音色下一句生效（≤1 句延迟）",
    switched.length > 0 && switched.every((entry) => entry.voice === "speech-2.8-hd-male"),
    `voices=${JSON.stringify(switched.map((entry) => entry.voice))}`,
  );

  // D8：bridge 失败 → 系统回退。提示含原文；句序无重复；系统失败（headless 无 voices）不再入队。
  await page.evaluate(() => window.localStorage.setItem("shadowroom.tts.voice", "speech-bad"));
  sendScript = () => [
    { type: "turn", threadId: "th-1", turnId: "fail" },
    { type: "delta", itemId: "fail-1", turnId: "fail", text: "第一句要失败。" },
    { type: "delta", itemId: "fail-1", turnId: "fail", text: "第二句也不该丢。" },
    { type: "done", turn: { status: "completed" } },
  ];
  ttsFail = true;
  const failBefore = ttsLog.length;
  // 回退提示显示在 orb caption，且会被后续状态（listening 词）顶掉——提交前起一个采样器
  // 记录 caption 的真实显示历史，断言「出现过」，不靠抓拍时机。
  await page.evaluate(() => {
    window.__captionLog = [];
    window.__captionSampler = window.setInterval(() => {
      window.__captionLog.push(document.querySelector("[data-call-caption]")?.textContent ?? "");
    }, 60);
  });
  await page.locator(".sr-composer-input").fill("这轮要失败");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window.__callProbe?.marks().ttsFallbacks ?? 0) > 0, undefined, { timeout: 15_000 });
  await page.waitForTimeout(1_200);
  const noticeText = await page.evaluate(() => {
    window.clearInterval(window.__captionSampler);
    return (window.__captionLog ?? []).join("\n");
  });
  await page.waitForTimeout(800);
  const marksAfterFail = await page.evaluate(() => window.__callProbe?.marks());
  const failRequests = ttsLog.slice(failBefore).map((entry) => entry.text);
  ttsFail = false;
  sendScript = null;
  const stubSpoken = await page.evaluate(() => window.__stubSpoken ?? []);
  check(
    "D8 bridge 失败提示含原文 + 熔断",
    noticeText.includes("供应商音色不可用") && noticeText.includes("speech-bad") && (marksAfterFail?.ttsFallbacks ?? 0) >= 2,
    `notice="${noticeText.slice(0, 80)}" fallbacks=${marksAfterFail?.ttsFallbacks}`,
  );
  check(
    "D8' 失败句+剩余句各 repush 恰一次（bridge 请求无重复；system 按序重念两句）",
    failRequests.length === new Set(failRequests).size && failRequests.length === 1
      && JSON.stringify(stubSpoken) === JSON.stringify(["第一句要失败。", "第二句也不该丢。"]),
    `bridgeRequests=${JSON.stringify(failRequests)} systemSpoken=${JSON.stringify(stubSpoken)}`,
  );
  const attemptsAfterFail = marksAfterFail?.ttsAttempts ?? 0;
  await page.waitForTimeout(1_200);
  const attemptsSettled = (await page.evaluate(() => window.__callProbe?.marks().ttsAttempts)) ?? 0;
  check(
    "D8'' 系统失败不再入队（attempts 稳定）",
    attemptsSettled <= attemptsAfterFail,
    `after=${attemptsAfterFail} settled=${attemptsSettled}`,
  );
  await page.screenshot({ path: `${SHOTS}/fallback-notice.png` });
  await context.close();
}

// S5'：用户可见消息不含 [voice_turn]（用最后一个语音轮的页面已关——单独快开一页验证 DOM）。
{
  const { context, page } = await newRoundPage(0);
  await page.locator(".sr-composer-input").fill("打字一句");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const visibleHasVoiceTag = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".sr-msg-user")).some((el) => (el.textContent ?? "").includes("[voice_turn]")),
  );
  check("S5' 用户可见消息不含 [voice_turn]", !visibleHasVoiceTag, `hasTag=${visibleHasVoiceTag}`);
  await context.close();
}

check("Console error 0（全部轮）", consoleErrors.length === 0, JSON.stringify(consoleErrors).slice(0, 240));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
