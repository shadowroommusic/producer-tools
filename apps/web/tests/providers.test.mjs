/**
 * 供应商与角色：形状照 Shadow，规则是「一个问题只有一个答案」。
 *
 * 这里钉住四件事：一个供应商可以有**多个**对话模型；模型档跟着模型走；能力是 `{protocol, baseUrl,
 * models}` 而没有「默认模型」这种第二份真相；老设置（v1 的 slots、v2 的 defaultModel）会被迁移而
 * 不是丢掉。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addModels,
  agentModelChoices,
  assignRole,
  capabilityOf,
  clearRole,
  credentialNameFor,
  defaultCapabilityConfig,
  emptySettings,
  maskKey,
  normalizeSettings,
  providerProblems,
  removeModel,
  removeProvider,
  roleSummary,
  roleTarget,
  setCapability,
  setModelProfile,
  setRoleModel,
  upsertProvider,
} from "../src/lib/providers.ts";
import { minimaxM3ChatProfile, textChatProfile } from "../src/lib/providerModel.ts";

const minimax = (patch = {}) => ({
  id: "p-minimax",
  name: "MiniMax",
  baseUrl: "https://api.minimaxi.com/anthropic",
  credentialRef: "minimax",
  endpointFormat: "chat_completions",
  enabled: true,
  models: ["MiniMax-M3", "MiniMax-M2.7"],
  modelProfiles: { "MiniMax-M3": minimaxM3ChatProfile() },
  capabilities: {},
  ...patch,
});

test("a provider holds several chat models, and the chat switch offers every one of them", () => {
  let settings = upsertProvider(emptySettings(), minimax());
  settings = addModels(settings, "p-minimax", ["MiniMax-M2.5", "MiniMax-M3"], "agent"); // 重复的不会加两次
  const choices = agentModelChoices(settings);
  assert.deepEqual(choices.map((choice) => choice.model), ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"]);
  assert.equal(choices[0].profile?.contextWindowTokens, 1_000_000, "the profile travels with the model");
  // 语音/生图模型永远不出现在这里
  const withTts = setCapability(settings, "p-minimax", "tts", { protocol: "chat_completions", baseUrl: "https://api.minimaxi.com", models: ["speech-2.5"] });
  assert.deepEqual(agentModelChoices(withTts).map((choice) => choice.model).includes("speech-2.5"), false);
});

test("removing a model unplugs the role that pointed at it", () => {
  let settings = upsertProvider(emptySettings(), minimax());
  settings = assignRole(settings, "agent", "p-minimax", "MiniMax-M2.7");
  assert.equal(roleTarget(settings, "agent")?.model, "MiniMax-M2.7");
  settings = removeModel(settings, "p-minimax", "MiniMax-M2.7", "agent");
  assert.equal(settings.roles.agent, null);
  assert.deepEqual(settings.providers[0].models, ["MiniMax-M3"]);
  assert.deepEqual(settings.providers[0].modelProfiles["MiniMax-M2.7"], undefined, "the profile goes with it");
});

test("a capability is protocol + endpoint + models, and switching it off unplugs its role", () => {
  let settings = upsertProvider(emptySettings(), minimax());
  const prefilled = defaultCapabilityConfig(settings.providers[0], "tts");
  assert.equal(prefilled.baseUrl, "https://api.minimaxi.com/anthropic", "endpoint inherited, not retyped");
  assert.deepEqual(prefilled.models, []);
  settings = setCapability(settings, "p-minimax", "tts", { ...prefilled, models: ["speech-2.5", "speech-02"] });
  settings = assignRole(settings, "tts", "p-minimax");
  assert.equal(roleTarget(settings, "tts")?.model, "speech-2.5", "the role takes the first model");
  settings = setRoleModel(settings, "tts", "speech-02");
  assert.equal(roleSummary(settings, "tts"), "MiniMax · speech-02");
  settings = setCapability(settings, "p-minimax", "tts", null);
  assert.equal(settings.roles.tts, null);
  assert.equal(capabilityOf(settings.providers[0], "tts"), undefined);
});

test("roles can be switched off without losing the capability underneath", () => {
  let settings = upsertProvider(emptySettings(), minimax());
  settings = assignRole(settings, "agent", "p-minimax", "MiniMax-M3");
  const off = clearRole(settings, "agent");
  assert.equal(roleTarget(off, "agent"), undefined);
  assert.deepEqual(off.providers[0].models, ["MiniMax-M3", "MiniMax-M2.7"]);
  assert.equal(assignRole(off, "agent", "p-minimax").roles.agent?.model, "MiniMax-M3");
});

test("a disabled provider takes its models out of every role", () => {
  let settings = upsertProvider(emptySettings(), minimax());
  settings = assignRole(settings, "agent", "p-minimax", "MiniMax-M3");
  const off = upsertProvider(settings, { ...minimax(), enabled: false });
  assert.equal(roleTarget(off, "agent"), undefined);
  assert.equal(roleSummary(off, "agent"), "未配置");
  assert.deepEqual(agentModelChoices(off), [], "a disabled provider offers no models either");
});

test("deleting a provider unplugs its roles and leaves the others alone", () => {
  let settings = upsertProvider(emptySettings(), minimax());
  settings = upsertProvider(settings, { ...minimax(), id: "p-local", name: "本地", credentialRef: null });
  settings = assignRole(settings, "tts", "p-minimax");
  settings = assignRole(settings, "agent", "p-local", "MiniMax-M2.7");
  const after = removeProvider(settings, "p-minimax");
  assert.equal(after.providers.length, 1);
  assert.equal(after.roles.tts, null);
  assert.equal(after.roles.agent?.providerId, "p-local");
});

test("model profiles are per model, and clearing one is explicit", () => {
  let settings = upsertProvider(emptySettings(), minimax({ modelProfiles: {} }));
  settings = setModelProfile(settings, "p-minimax", "MiniMax-M2.7", textChatProfile(204_800));
  assert.equal(settings.providers[0].modelProfiles["MiniMax-M2.7"]?.contextWindowTokens, 204_800);
  settings = setModelProfile(settings, "p-minimax", "MiniMax-M2.7", null);
  assert.equal(settings.providers[0].modelProfiles["MiniMax-M2.7"], undefined);
});

test("settings from the first two versions are upgraded, not lost", () => {
  const v2 = {
    version: 2,
    providers: [
      {
        id: "p-openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        credentialRef: "openai",
        protocol: "openai",
        enabled: true,
        capabilities: {
          agent: { enabled: true, defaultModel: "gpt-4o", extraModels: ["gpt-4o-mini"] },
          tts: { enabled: true, defaultModel: "tts-1", baseUrl: "https://tts.example/v1" },
        },
      },
    ],
    roles: { agent: "p-openai:agent", tts: "p-openai:tts", voice_clone: null, stt: null, image: null },
  };
  const upgraded = normalizeSettings(v2);
  assert.equal(upgraded.version, 3);
  assert.deepEqual(upgraded.providers[0].models, ["gpt-4o", "gpt-4o-mini"], "multiple chat models survive");
  assert.equal(upgraded.providers[0].capabilities.tts?.baseUrl, "https://tts.example/v1", "the TTS override survives");
  assert.deepEqual(upgraded.providers[0].capabilities.tts?.models, ["tts-1"]);
  assert.deepEqual(upgraded.roles.agent, { providerId: "p-openai", capability: "agent", model: "gpt-4o" });
  assert.deepEqual(upgraded.roles.tts, { providerId: "p-openai", capability: "tts", model: "tts-1" });

  const v1 = {
    version: 1,
    providers: [{ id: "p-x", label: "X", baseUrl: "https://x/v1", credentialRef: null, protocol: "openai", enabled: true }],
    slots: [{ id: "slot-tts", providerId: "p-x", capability: "tts", model: "voice-1" }],
    roles: { agent: null, tts: "slot-tts", voice_clone: null, stt: null, image: null },
  };
  const fromV1 = normalizeSettings(v1);
  assert.deepEqual(fromV1.providers[0].capabilities.tts?.models, ["voice-1"]);
  assert.equal(fromV1.roles.tts?.model, "voice-1");
});

test("keys are named, never shown, and a provider needs a real endpoint", () => {
  assert.equal(credentialNameFor("My OpenAI", ["openai"]), "my-openai");
  assert.equal(maskKey("sk-abcdef1234"), "••••••••1234");
  assert.equal(maskKey(undefined), "");
  assert.deepEqual(providerProblems({ name: "OpenAI", baseUrl: "https://api.openai.com/v1" }), []);
  assert.deepEqual(providerProblems({ name: "", baseUrl: "api.openai.com" }), ["给它起个名字", "Base URL 要以 http:// 或 https:// 开头"]);
});
