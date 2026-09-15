/**
 * The model settings, as pure data: who serves which role, and what the chat is allowed to offer.
 *
 * The rule under test is the user's: the chat switches the main model and nothing else. Every other
 * role is decided in settings, and a half-configured provider must not leave a role pointing at a
 * slot that can never answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignRole,
  clearRole,
  credentialNameFor,
  emptySettings,
  mainModelChoices,
  maskKey,
  providerProblems,
  removeProvider,
  roleSummary,
  slotForRole,
  slotsForRole,
  upsertProvider,
} from "../src/lib/providers.ts";

const openai = { id: "p-openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", credentialRef: "openai", protocol: "openai", enabled: true };
const local = { id: "p-local", label: "本地 TTS", baseUrl: "http://127.0.0.1:9931/v1", credentialRef: null, protocol: "openai", enabled: true };

test("one provider can serve two roles, with two models", () => {
  let settings = upsertProvider(emptySettings(), openai);
  settings = assignRole(settings, "agent", openai.id, "gpt-4o");
  settings = assignRole(settings, "tts", openai.id, "gpt-4o-mini-tts");
  assert.equal(settings.slots.length, 2);
  assert.equal(slotForRole(settings, "agent")?.model, "gpt-4o");
  assert.equal(slotForRole(settings, "tts")?.model, "gpt-4o-mini-tts");
  assert.equal(roleSummary(settings, "tts"), "OpenAI · gpt-4o-mini-tts");
});

test("a half-typed slot is not an answer", () => {
  let settings = upsertProvider(emptySettings(), openai);
  settings = assignRole(settings, "agent", openai.id, "");
  assert.deepEqual(slotsForRole(settings, "agent"), [], "no model name yet");
  assert.deepEqual(mainModelChoices(settings), [], "the chat offers nothing until a model is named");
  assert.equal(roleSummary(settings, "agent"), "未配置");
});

test("the chat may only switch the main model", () => {
  let settings = upsertProvider(emptySettings(), openai);
  settings = assignRole(settings, "agent", openai.id, "gpt-4o");
  settings = assignRole(settings, "tts", openai.id, "tts-1");
  settings = assignRole(settings, "image", openai.id, "gpt-image-1");
  assert.deepEqual(mainModelChoices(settings).map((choice) => choice.slot.model), ["gpt-4o"]);
});

test("a disabled provider takes its slots out of every role", () => {
  let settings = upsertProvider(emptySettings(), openai);
  settings = assignRole(settings, "agent", openai.id, "gpt-4o");
  const off = upsertProvider(settings, { ...openai, enabled: false });
  assert.deepEqual(slotsForRole(off, "agent"), []);
  assert.equal(slotForRole(off, "agent"), undefined);
  assert.equal(roleSummary(off, "agent"), "未配置");
  // …and switching it back on brings the role back without re-typing the model.
  const on = upsertProvider(off, openai);
  assert.equal(slotForRole(on, "agent")?.model, "gpt-4o");
});

test("deleting a provider takes its slots and unplugs the roles that used them", () => {
  let settings = upsertProvider(emptySettings(), openai);
  settings = upsertProvider(settings, local);
  settings = assignRole(settings, "tts", local.id, "kokoro");
  settings = assignRole(settings, "agent", openai.id, "gpt-4o");
  const after = removeProvider(settings, local.id);
  assert.equal(after.providers.length, 1);
  assert.equal(after.slots.length, 1);
  assert.equal(after.roles.tts, null, "the role is unconfigured, not pointing at a ghost");
  assert.equal(after.roles.agent === null, false, "the other role is untouched");
});

test("a role can be switched off without losing the model underneath", () => {
  let settings = upsertProvider(emptySettings(), openai);
  settings = assignRole(settings, "tts", openai.id, "tts-1");
  const off = clearRole(settings, "tts");
  assert.equal(slotForRole(off, "tts"), undefined);
  assert.equal(off.slots.length, 1, "the slot is still there to switch back on");
  assert.equal(assignRole(off, "tts", openai.id, "tts-1").slots.length, 1, "re-assigning reuses it");
});

test("keys are named, never shown", () => {
  assert.equal(credentialNameFor("My OpenAI", ["openai"]), "my-openai");
  assert.equal(credentialNameFor("OpenAI", []), "openai");
  assert.equal(credentialNameFor("!!!", []), "provider");
  assert.equal(maskKey("sk-abcdef1234"), "••••••••1234");
  assert.equal(maskKey(undefined), "");
});

test("a provider needs a name and an http endpoint", () => {
  assert.deepEqual(providerProblems({ label: "OpenAI", baseUrl: "https://api.openai.com/v1" }), []);
  assert.deepEqual(providerProblems({ label: "", baseUrl: "api.openai.com" }), ["给它起个名字", "Base URL 要以 http:// 或 https:// 开头"]);
  assert.deepEqual(providerProblems({ label: "x", baseUrl: "" }), ["填 Base URL"]);
});
