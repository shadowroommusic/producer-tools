/**
 * S0：先把三类真实缺陷钉成测试，再实现（任务 voice-conversation-20261020）。
 *
 * 这些用例描述的是**用户听到的**问题，不是内部实现：
 * 1. 上一轮的答案被重念一遍（"有时候读很久很久"）；
 * 2. 连续两次 speak 互相取消，第一句只说出一半（"很死板地念"）；
 * 3. 换了音色后通话彻底不说话（实例还是旧的，失败又被静默吞掉）。
 *
 * 前两条可以在这里直接驱动；第三条要等 `lib/speech-plan.ts` 出现——测试先红，实现后绿。
 *
 * Run with `pnpm test`（Node 自带 runner，`.ts` 由 Node 24 剥类型）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystemTTS } from "../src/lib/tts.ts";

/** 装一套最小的 `speechSynthesis`，记录每次 speak/cancel。 */
function installSystemSpeech() {
  const utterances = [];
  const state = { cancelCalls: 0 };
  class Utterance {
    constructor(text) {
      this.text = text;
      this.voice = null;
      this.lang = "";
      this.rate = 1;
      this.pitch = 1;
    }
  }
  const synth = {
    speaking: false,
    getVoices: () => [
      { voiceURI: "v1", name: "Tingting", lang: "zh-CN" },
      { voiceURI: "v2", name: "Samantha", lang: "en-US" },
    ],
    speak: (utterance) => utterances.push(utterance),
    cancel: () => {
      state.cancelCalls += 1;
    },
    pause: () => undefined,
    resume: () => undefined,
    addEventListener: () => undefined,
  };
  globalThis.window = { speechSynthesis: synth };
  globalThis.SpeechSynthesisUtterance = Utterance;
  return {
    utterances,
    state,
    restore: () => {
      delete globalThis.window;
      delete globalThis.SpeechSynthesisUtterance;
    },
  };
}

test("S0-1 新回合不得重念上一轮的回答", async () => {
  const { createSpeechTurn } = await import("../src/lib/speech-turn.ts");
  const turn = createSpeechTurn();
  turn.begin();
  turn.bind("a-1");
  turn.advance(3);
  // 用户说完下一句：新回合开始，上一轮的答案绝不能再次进入朗读。
  turn.begin();
  assert.equal(turn.owns("a-1"), false, "上一轮的 assistant id 在新回合必须不被认领");
  assert.equal(turn.spoken(), 0, "新回合的已念句数必须归零");
  turn.bind("a-2");
  assert.equal(turn.owns("a-2"), true);
  assert.equal(turn.owns("a-1"), false);
});

test("S0-1b 同一轮后续不同 id 一律忽略（Codex #492-5）", async () => {
  const { createSpeechTurn } = await import("../src/lib/speech-turn.ts");
  const turn = createSpeechTurn();
  turn.begin();
  turn.bind("a-1");
  turn.bind("a-2");
  assert.equal(turn.id(), "a-1", "第一个 id 锁定本轮答案");
  assert.equal(turn.owns("a-2"), false, "同一轮的分段/重发不得换掉答案");
  turn.begin();
  turn.bind("a-2");
  assert.equal(turn.id(), "a-2", "begin 之后才允许绑定新 id");
});

test("S0-2 连续 speak 不得隐式 cancel 上一句", () => {
  const stub = installSystemSpeech();
  try {
    const tts = createSystemTTS();
    tts.speak("第一句。", { onEnd: () => undefined });
    tts.speak("第二句。", { onEnd: () => undefined });
    assert.equal(stub.utterances.length, 2, "两句都应该交到系统语音");
    assert.equal(stub.state.cancelCalls, 0, "speak 内部不许 cancel（截断就是这么来的）");
  } finally {
    stub.restore();
  }
});

test("S0-3 音色变化必须产生新的 TTS 实例（bridge 不能继续用旧 voice）", async () => {
  const { resolveSpeechPlan, planWithVoice } = await import("../src/lib/speech-plan.ts");
  const storage = { getItem: (key) => (key === "shadowroom.tts.voice" ? "voice-A" : null) };
  const settings = {
    version: 3,
    providers: [
      {
        id: "p1",
        name: "MiniMax",
        baseUrl: "https://api.minimax.cn/v1",
        credentialRef: "minimax",
        endpointFormat: "chat_completions",
        enabled: true,
        models: [],
        modelProfiles: {},
        capabilities: { tts: { protocol: "minimax-t2a", baseUrl: "https://api.minimax.cn/v1", models: ["speech-2.5"] } },
      },
    ],
    roles: {
      tts: { providerId: "p1", capability: "tts", model: "speech-2.5" },
      agent: null,
      voice_clone: null,
      stt: null,
      image: null,
      music: null,
    },
  };
  const plan = resolveSpeechPlan(settings, storage);
  assert.equal(plan.kind, "bridge");
  assert.equal(plan.voice, "voice-A");
  const changed = planWithVoice(plan, "voice-B");
  assert.notEqual(changed.key, plan.key, "换了音色，实例 key 必须变（否则通话还在用旧 voice）");
  assert.equal(changed.voice, "voice-B");
});
