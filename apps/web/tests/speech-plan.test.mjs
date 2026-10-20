/**
 * S3：声音来源、实例 key、失败上报（任务 voice-conversation-20261020）。
 *
 * 钉的是"换音色为什么必须换实例"和"合成失败为什么必须说出来"：
 * - 一个 `resolveSpeechPlan()` 决定系统音色 / 供应商音色，通话与设置页读同一处；
 * - key 含供应商、模型、凭证与音色，key 变 → 重建；
 * - 失败走 `onError`，不再用 onEnd 假装播完。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeTTS, createSystemTTS } from "../src/lib/tts.ts";
import { createTTS, planWithVoice, resolveSpeechPlan } from "../src/lib/speech-plan.ts";

const EMPTY_ROLES = { agent: null, tts: null, voice_clone: null, stt: null, image: null, music: null };

function settingsWith(overrides = {}) {
  return {
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
    roles: { ...EMPTY_ROLES, tts: { providerId: "p1", capability: "tts", model: "speech-2.5" } },
    ...overrides,
  };
}

function storage(values = {}) {
  return { getItem: (key) => (key in values ? values[key] : null) };
}

test("没配 TTS 角色时用系统音色", () => {
  const plan = resolveSpeechPlan(settingsWith({ roles: EMPTY_ROLES }), storage({ "shadowroom.voice": "v1" }));
  assert.equal(plan.kind, "system");
  assert.equal(plan.voiceId, "v1");
  assert.equal(plan.key, "system:v1");
});

test("系统音色没选时 key 仍然是稳定的", () => {
  const plan = resolveSpeechPlan(settingsWith({ roles: EMPTY_ROLES }), storage());
  assert.equal(plan.kind, "system");
  assert.equal("voiceId" in plan, false);
  assert.equal(plan.key, "system:");
});

test("系统音色读 shadowroom.voice", () => {
  const plan = resolveSpeechPlan(settingsWith({ roles: EMPTY_ROLES }), storage({ "shadowroom.voice": "Tingting" }));
  assert.equal(plan.voiceId, "Tingting");
});

test("系统音色不读 shadowroom.tts.voice", () => {
  const plan = resolveSpeechPlan(
    settingsWith({ roles: EMPTY_ROLES }),
    storage({ "shadowroom.voice": "Tingting", "shadowroom.tts.voice": "provider-voice" }),
  );
  assert.equal(plan.voiceId, "Tingting");
});

test("配了 TTS 角色就走 bridge，端点/协议/模型取能力配置", () => {
  const plan = resolveSpeechPlan(settingsWith(), storage());
  assert.equal(plan.kind, "bridge");
  assert.equal(plan.providerId, "p1");
  assert.equal(plan.providerName, "MiniMax");
  assert.equal(plan.baseUrl, "https://api.minimax.cn/v1");
  assert.equal(plan.protocol, "minimax-t2a");
  assert.equal(plan.model, "speech-2.5");
  assert.equal(plan.credentialRef, "minimax");
});

test("供应商音色读 shadowroom.tts.voice", () => {
  const plan = resolveSpeechPlan(settingsWith(), storage({ "shadowroom.tts.voice": "male-qn-qingse" }));
  assert.equal(plan.kind, "bridge");
  assert.equal(plan.voice, "male-qn-qingse");
});

test("供应商音色不读 shadowroom.voice", () => {
  const plan = resolveSpeechPlan(settingsWith(), storage({ "shadowroom.voice": "Tingting" }));
  assert.equal(plan.kind, "bridge");
  assert.equal("voice" in plan, false);
});

test("音色变化会改变实例 key", () => {
  const a = resolveSpeechPlan(settingsWith(), storage({ "shadowroom.tts.voice": "voice-A" }));
  const b = resolveSpeechPlan(settingsWith(), storage({ "shadowroom.tts.voice": "voice-B" }));
  assert.notEqual(a.key, b.key);
});

test("模型变化会改变实例 key", () => {
  const a = resolveSpeechPlan(settingsWith(), storage());
  const changed = settingsWith();
  changed.roles = { ...EMPTY_ROLES, tts: { providerId: "p1", capability: "tts", model: "speech-3.0" } };
  changed.providers[0].capabilities.tts.models = ["speech-2.5", "speech-3.0"];
  const b = resolveSpeechPlan(changed, storage());
  assert.equal(b.kind, "bridge");
  assert.notEqual(a.key, b.key);
});

test("凭证变化会改变实例 key", () => {
  const a = resolveSpeechPlan(settingsWith(), storage());
  const changed = settingsWith();
  changed.providers[0].credentialRef = "minimax-2";
  const b = resolveSpeechPlan(changed, storage());
  assert.notEqual(a.key, b.key);
});

test("同样输入得到同样的 key（不会每轮重建）", () => {
  const store = storage({ "shadowroom.tts.voice": "voice-A" });
  assert.equal(resolveSpeechPlan(settingsWith(), store).key, resolveSpeechPlan(settingsWith(), store).key);
});

test("供应商被停用时回落到系统音色", () => {
  const changed = settingsWith();
  changed.providers[0].enabled = false;
  const plan = resolveSpeechPlan(changed, storage({ "shadowroom.voice": "v1" }));
  assert.equal(plan.kind, "system");
  assert.equal(plan.voiceId, "v1");
});

test("角色绑定的模型不在能力列表里时回落到系统音色", () => {
  const changed = settingsWith();
  changed.providers[0].capabilities.tts.models = ["other-model"];
  const plan = resolveSpeechPlan(changed, storage());
  assert.equal(plan.kind, "system");
});

test("planWithVoice 换供应商音色：voice 与 key 一起变", () => {
  const plan = resolveSpeechPlan(settingsWith(), storage({ "shadowroom.tts.voice": "voice-A" }));
  const changed = planWithVoice(plan, "voice-B");
  assert.equal(changed.kind, "bridge");
  assert.equal(changed.voice, "voice-B");
  assert.notEqual(changed.key, plan.key);
  assert.equal(plan.voice, "voice-A", "原计划不能被改掉");
});

test("planWithVoice 清空供应商音色", () => {
  const plan = resolveSpeechPlan(settingsWith(), storage({ "shadowroom.tts.voice": "voice-A" }));
  const cleared = planWithVoice(plan, undefined);
  assert.equal(cleared.kind, "bridge");
  assert.equal("voice" in cleared, false);
  assert.notEqual(cleared.key, plan.key);
});

test("planWithVoice 用于系统音色试听", () => {
  const plan = resolveSpeechPlan(settingsWith({ roles: EMPTY_ROLES }), storage());
  const preview = planWithVoice(plan, "Samantha");
  assert.equal(preview.kind, "system");
  assert.equal(preview.voiceId, "Samantha");
  assert.equal(preview.key, "system:Samantha");
});

/** 假 AudioContext：只够 bridge 播放/取消用。 */
function installAudio() {
  const sources = [];
  class FakeContext {
    constructor() {
      this.destination = {};
    }
    createBufferSource() {
      const source = {
        buffer: null,
        started: false,
        stopped: false,
        onended: null,
        connect() {},
        start() {
          source.started = true;
        },
        stop() {
          source.stopped = true;
          source.onended?.();
        },
      };
      sources.push(source);
      return source;
    }
    decodeAudioData() {
      return Promise.resolve({ duration: 1.2 });
    }
  }
  globalThis.AudioContext = FakeContext;
  return {
    sources,
    restore: () => {
      delete globalThis.AudioContext;
    },
  };
}

function installFetch(respond) {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => respond(bodies[bodies.length - 1].body) };
  };
  return {
    bodies,
    restore: () => {
      delete globalThis.fetch;
    },
  };
}

const AUDIO = Buffer.from("not-really-audio").toString("base64");

test("bridge 请求体带的是实例音色", async () => {
  const audio = installAudio();
  const network = installFetch(() => ({ audio: AUDIO }));
  try {
    const tts = createBridgeTTS({
      baseUrl: "https://api.example.com/v1",
      credentialRef: "key",
      protocol: "minimax-t2a",
      model: "speech-2.5",
      voice: "voice-A",
    });
    await tts.synthesize("你好。");
    assert.equal(network.bodies[0].body.voice, "voice-A");
    assert.equal(network.bodies[0].body.text, "你好。");
    assert.equal(network.bodies[0].url, "/api/agent/providers/tts");
  } finally {
    network.restore();
    audio.restore();
  }
});

test("bridge 合成失败时 onError 带原因（不再静默当播完）", async () => {
  const audio = installAudio();
  const network = installFetch(() => ({ error: "voice not found" }));
  try {
    const tts = createBridgeTTS({
      baseUrl: "https://api.example.com/v1",
      credentialRef: "key",
      protocol: "minimax-t2a",
      model: "speech-2.5",
      voice: "missing",
    });
    const errors = [];
    let ended = 0;
    await new Promise((resolve) => {
      tts.speak("你好。", {
        onError: (message) => errors.push(message),
        onEnd: () => {
          ended += 1;
          resolve();
        },
      });
    });
    assert.deepEqual(errors, ["voice not found"]);
    assert.equal(ended, 1);
  } finally {
    network.restore();
    audio.restore();
  }
});

test("bridge 成功时先 onStart 再 onEnd", async () => {
  const audio = installAudio();
  const network = installFetch(() => ({ audio: AUDIO }));
  try {
    const tts = createBridgeTTS({
      baseUrl: "https://api.example.com/v1",
      credentialRef: "key",
      protocol: "minimax-t2a",
      model: "speech-2.5",
      voice: "voice-A",
    });
    const events = [];
    tts.speak("你好。", {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(events, ["start"]);
    audio.sources[0].stop();
    assert.deepEqual(events, ["start", "end"]);
  } finally {
    network.restore();
    audio.restore();
  }
});

test("bridge cancel 之后迟到的合成结果不再播放", async () => {
  const audio = installAudio();
  const network = installFetch(() => ({ audio: AUDIO }));
  try {
    const tts = createBridgeTTS({
      baseUrl: "https://api.example.com/v1",
      credentialRef: "key",
      protocol: "minimax-t2a",
      model: "speech-2.5",
      voice: "voice-A",
    });
    let started = 0;
    tts.speak("你好。", { onStart: () => (started += 1) });
    tts.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(started, 0);
    assert.equal(audio.sources.filter((source) => source.started).length, 0);
  } finally {
    network.restore();
    audio.restore();
  }
});

/** 系统语音的最小桩：只记录 speak/cancel 与 utterance 的真值。 */
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
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [{ voiceURI: "v1", name: "Tingting", lang: "zh-CN" }],
      speak: (utterance) => utterances.push(utterance),
      cancel: () => {
        state.cancelCalls += 1;
      },
      addEventListener: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    },
  };
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

test("系统语音 spoke 后 onStart / onEnd 各一次", () => {
  const stub = installSystemSpeech();
  try {
    const tts = createSystemTTS();
    const events = [];
    tts.speak("你好。", { onStart: () => events.push("start"), onEnd: () => events.push("end") });
    stub.utterances[0].onstart();
    stub.utterances[0].onend();
    assert.deepEqual(events, ["start", "end"]);
  } finally {
    stub.restore();
  }
});

test("系统语音失败会说明原因，而不是静默结束", () => {
  const stub = installSystemSpeech();
  try {
    const tts = createSystemTTS();
    const errors = [];
    let ended = 0;
    tts.speak("你好。", { onError: (message) => errors.push(message), onEnd: () => (ended += 1) });
    stub.utterances[0].onerror({ error: "synthesis-failed" });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /synthesis-failed/);
    assert.equal(ended, 1);
  } finally {
    stub.restore();
  }
});

test("系统语音 cancel 之后 onEnd 不再回调（取消不是播完）", () => {
  const stub = installSystemSpeech();
  try {
    const tts = createSystemTTS();
    let ended = 0;
    tts.speak("你好。", { onEnd: () => (ended += 1) });
    tts.cancel();
    stub.utterances[0].onend();
    assert.equal(ended, 0);
    assert.equal(stub.state.cancelCalls, 1);
  } finally {
    stub.restore();
  }
});

test("createTTS 按计划返回对应实现", () => {
  const stub = installSystemSpeech();
  try {
    const system = resolveSpeechPlan(settingsWith({ roles: EMPTY_ROLES }), storage());
    const provider = createTTS(system);
    assert.equal(provider.synthesize instanceof Function, true);
    assert.equal(provider.speaking(), false);
    // 系统实现拿不到音频流（这是 ADR-019 的已知限制，不是 bug）。
    return provider.synthesize("你好。").then((buffer) => assert.equal(buffer, null));
  } finally {
    stub.restore();
  }
});
