/**
 * F-8：预设供应商的默认值钉死——设置页「高级」折叠层与 choosePreset 的预填都来自
 * providerDefaultsFromPreset，这里写错就是静默错配（规格 docs/ui-review-kimi.md F-8）。
 *
 * 钉三件事：
 * ① 每家预设的通用契约（name/baseUrl/presetSource/models/能力形状）；
 * ② 带能力的几家（MiniMax/Xiaomi/Volcengine）逐项默认值；
 * ③ 预设**不**指定 endpointFormat —— 高级层的协议默认沿用 blankProvider 的 chat_completions，
 *    「按端点认家」（f57b571 resolveMediaProtocol）在 bridge 兜底，这里不许越俎代庖。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESET_CAPABILITY_KIND,
  PROVIDER_PRESETS,
  presetById,
  presetProtocol,
  providerDefaultsFromPreset,
} from "../src/lib/providerPresets.ts";

const VALID_FORMATS = new Set(["chat_completions", "responses", "messages", "custom_endpoint"]);
const KNOWN_KINDS = new Set(["image", "stt", "tts", "music"]);

test("每家预设：通用契约（label/端点/presetSource/模型/能力形状）", () => {
  assert.ok(PROVIDER_PRESETS.length >= 15, `目录至少 15 家，现 ${PROVIDER_PRESETS.length}`);
  for (const preset of PROVIDER_PRESETS) {
    const defaults = providerDefaultsFromPreset(preset);
    assert.equal(defaults.name, preset.label, `${preset.id} name`);
    assert.equal(defaults.baseUrl, preset.baseUrl, `${preset.id} baseUrl`);
    assert.equal(defaults.presetSource, preset.id, `${preset.id} presetSource`);
    assert.deepEqual(defaults.models, preset.models, `${preset.id} models`);
    assert.match(defaults.baseUrl, /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/, `${preset.id} baseUrl 须为 https 或本机`);
    for (const [kind, config] of Object.entries(defaults.capabilities)) {
      assert.ok(KNOWN_KINDS.has(kind), `${preset.id} 能力 ${kind} 是已知角色`);
      assert.ok(VALID_FORMATS.has(config.protocol), `${preset.id}.${kind} 协议 ${config.protocol} 是合法线格式`);
      assert.ok(config.baseUrl !== "", `${preset.id}.${kind} 端点留空应已回退 preset.baseUrl`);
      assert.ok(Array.isArray(config.models), `${preset.id}.${kind} models 是数组`);
    }
    // ③：预设不指定供应商级协议——高级层的协议默认由 blankProvider 给 chat_completions。
    assert.equal("endpointFormat" in defaults, false, `${preset.id} 不许预设 endpointFormat`);
  }
});

test("MiniMax：端点、模型顺序、四项能力逐项钉死", () => {
  const preset = presetById("minimax");
  assert.ok(preset !== undefined);
  const defaults = providerDefaultsFromPreset(preset);
  assert.equal(defaults.name, "MiniMax");
  assert.equal(defaults.baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(defaults.models[0], "MiniMax-M3");
  assert.equal(defaults.models.length, 8);
  assert.deepEqual(defaults.capabilities.tts, {
    protocol: "custom_endpoint",
    baseUrl: "https://api.minimaxi.com",
    models: ["speech-2.8-hd", "speech-2.8-turbo"],
  });
  assert.deepEqual(defaults.capabilities.stt, {
    protocol: "custom_endpoint",
    baseUrl: "https://api.minimaxi.com",
    models: ["asr-1.0"],
  });
  assert.deepEqual(defaults.capabilities.image, {
    protocol: "custom_endpoint",
    baseUrl: "https://api.minimaxi.com",
    models: ["image-01", "image-01-live"],
  });
  assert.deepEqual(defaults.capabilities.music, {
    protocol: "custom_endpoint",
    baseUrl: "https://api.minimaxi.com",
    models: ["music-2.6", "music-cover", "music-2.6-free", "music-cover-free"],
  });
});

test("Xiaomi / Volcengine：能力端点与协议翻译", () => {
  const xiaomi = providerDefaultsFromPreset(presetById("xiaomi"));
  assert.equal(xiaomi.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.deepEqual(xiaomi.capabilities.stt, {
    protocol: "custom_endpoint",
    baseUrl: "https://api.xiaomimimo.com/v1",
    models: ["mimo-v2.5-asr"],
  });
  assert.equal(xiaomi.capabilities.tts.models.length, 3);

  const volc = providerDefaultsFromPreset(presetById("volcengine"));
  assert.equal(volc.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.deepEqual(volc.capabilities.image, {
    protocol: "custom_endpoint",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
  });
  assert.equal(Object.keys(volc.capabilities).length, 1);
});

test("无能力的预设：capabilities 是空对象而不是 undefined 拼错", () => {
  for (const id of ["litellm", "moonshot-cn", "moonshot-global", "aliyun", "kimi-code"]) {
    const defaults = providerDefaultsFromPreset(presetById(id));
    assert.deepEqual(defaults.capabilities, {}, `${id} 不该有能力`);
  }
});

test("presetProtocol：Shadow 协议名 → 线格式的四个分支", () => {
  assert.equal(presetProtocol("messages"), "messages");
  assert.equal(presetProtocol("anthropic-messages"), "messages");
  assert.equal(presetProtocol("openai-responses"), "responses");
  assert.equal(presetProtocol("openai-chat"), "chat_completions");
  assert.equal(presetProtocol("chat_completions"), "chat_completions");
  // 目录里真实出现的厂商私有协议名，全部落 custom_endpoint（按端点认家在 bridge 接手）。
  assert.equal(presetProtocol("minimax-t2a"), "custom_endpoint");
  assert.equal(presetProtocol("minimax-asr"), "custom_endpoint");
  assert.equal(presetProtocol("minimax-image"), "custom_endpoint");
  assert.equal(presetProtocol("minimax-music"), "custom_endpoint");
  assert.equal(presetProtocol("mimo-asr"), "custom_endpoint");
  assert.equal(presetProtocol("mimo-tts"), "custom_endpoint");
  assert.equal(presetProtocol("volcengine-ark-image"), "custom_endpoint");
});

test("PRESET_CAPABILITY_KIND：目录里用到的能力键都有角色映射", () => {
  assert.deepEqual(PRESET_CAPABILITY_KIND, { image: "image", speech: "stt", textToSpeech: "tts", music: "music" });
  for (const preset of PROVIDER_PRESETS) {
    for (const key of Object.keys(preset.capabilities ?? {})) {
      assert.ok(key in PRESET_CAPABILITY_KIND, `${preset.id} 的能力键 ${key} 没有角色映射（会被静默丢掉）`);
    }
  }
});

test("待核实预设：needsVerification 与 note 不丢（界面要写原因）", () => {
  for (const preset of PROVIDER_PRESETS) {
    if (preset.needsVerification === true) assert.ok(typeof preset.note === "string" && preset.note !== "", `${preset.id} 缺 note`);
  }
  assert.equal(presetById("claude-subscription").needsVerification, true);
});
