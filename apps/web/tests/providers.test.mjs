/**
 * The model settings: which provider offers what, and who ends up doing the job.
 *
 * Two rules are pinned here because they are the project's first principle applied to this feature:
 * the capability is the only truth (slots are derived, so they cannot drift), and nothing is stored
 * that can be inherited (a capability that names no endpoint follows the chat one).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignRole,
  capabilityOf,
  capabilityStatus,
  capabilityTarget,
  clearRole,
  credentialNameFor,
  deriveSlots,
  emptySettings,
  mainModelChoices,
  maskKey,
  normalizeSettings,
  providerProblems,
  removeProvider,
  roleSummary,
  roleTarget,
  setCapability,
  upsertProvider,
} from "../src/lib/providers.ts";

const openai = (patch = {}) => ({
  id: "p-openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "openai",
  protocol: "openai",
  enabled: true,
  capabilities: {
    agent: { enabled: true, defaultModel: "gpt-4o" },
    tts: { enabled: true, defaultModel: "tts-1", options: { voice: "alloy" } },
  },
  ...patch,
});

const ready = { source: "file" };

test("one provider serves two roles, and slots are derived rather than stored", () => {
  let settings = upsertProvider(emptySettings(), openai());
  settings = assignRole(settings, "agent", "p-openai");
  settings = assignRole(settings, "tts", "p-openai");
  assert.equal(roleTarget(settings, "agent")?.model, "gpt-4o");
  assert.equal(roleTarget(settings, "tts")?.model, "tts-1");
  assert.equal(roleSummary(settings, "tts"), "OpenAI · tts-1");
  assert.deepEqual(
    deriveSlots(settings).map((slot) => slot.id),
    ["p-openai:agent", "p-openai:tts"],
    "slots exist only as a view of the capabilities",
  );
  assert.equal(Object.hasOwn(settings, "slots"), false, "nothing named slots is persisted");
});

test("the chat may only switch the main model", () => {
  const provider = openai({
    capabilities: {
      agent: { enabled: true, defaultModel: "gpt-4o" },
      tts: { enabled: true, defaultModel: "tts-1" },
      image: { enabled: true, defaultModel: "gpt-image-1" },
    },
  });
  const settings = assignRole(upsertProvider(emptySettings(), provider), "agent", "p-openai");
  assert.deepEqual(mainModelChoices(settings).map((choice) => choice.slot.model), ["gpt-4o"]);
});

test("a capability that names no endpoint follows the chat endpoint", () => {
  const provider = openai();
  assert.equal(capabilityTarget(provider, "tts").baseUrl, "https://api.openai.com/v1", "inherited, not copied");
  // …and moving the chat endpoint moves the capability with it — the point of not storing a copy.
  const moved = { ...provider, baseUrl: "https://gateway.internal/v1" };
  assert.equal(capabilityTarget(moved, "tts").baseUrl, "https://gateway.internal/v1");
  // An explicit override stays put.
  const overridden = {
    ...provider,
    capabilities: { ...provider.capabilities, tts: { enabled: true, defaultModel: "tts-1", baseUrl: "https://tts.example/v1" } },
  };
  assert.equal(capabilityTarget({ ...overridden, baseUrl: "https://moved/v1" }, "tts").baseUrl, "https://tts.example/v1");
});

test("the status badge says what is actually missing, in the order you would fix it", () => {
  const provider = openai();
  assert.equal(capabilityStatus(provider, "agent", ready), "ready");
  assert.equal(capabilityStatus(provider, "image", ready), "off");
  assert.equal(
    capabilityStatus({ ...provider, capabilities: { ...provider.capabilities, tts: { enabled: true } } }, "tts", ready),
    "needs-model",
  );
  assert.equal(capabilityStatus(provider, "agent", { source: "missing" }), "needs-credential");
  assert.equal(
    capabilityStatus(
      { ...provider, baseUrl: "not-a-url", capabilities: { agent: { enabled: true, defaultModel: "gpt-4o" } } },
      "agent",
      ready,
    ),
    "needs-endpoint",
  );
  assert.equal(
    capabilityStatus(
      { ...provider, capabilities: { agent: { enabled: true, defaultModel: "x", protocol: "custom" } } },
      "agent",
      ready,
    ),
    "needs-path",
    "a custom protocol with no path cannot be called",
  );
});

test("switching a capability on pre-fills it; switching it off unplugs its role", () => {
  let settings = upsertProvider(emptySettings(), openai({ capabilities: { agent: { enabled: true, defaultModel: "gpt-4o" } } }));
  settings = setCapability(settings, "p-openai", "tts", { enabled: true });
  const tts = capabilityOf(settings.providers[0], "tts");
  assert.equal(tts.defaultModel, "tts-1", "the model almost every endpoint uses");
  assert.equal(tts.options?.voice, "alloy");
  settings = assignRole(settings, "tts", "p-openai");
  assert.equal(roleTarget(settings, "tts")?.model, "tts-1");
  settings = setCapability(settings, "p-openai", "tts", null);
  assert.equal(settings.roles.tts, null, "the role is unplugged in the same update");
  assert.equal(capabilityOf(settings.providers[0], "tts").enabled, false);
});

test("a disabled provider takes its capabilities out of every role", () => {
  let settings = upsertProvider(emptySettings(), openai());
  settings = assignRole(settings, "agent", "p-openai");
  const off = upsertProvider(settings, { ...openai(), enabled: false });
  assert.equal(roleTarget(off, "agent"), undefined);
  assert.equal(roleSummary(off, "agent"), "未配置");
  const on = upsertProvider(off, openai());
  assert.equal(roleTarget(on, "agent")?.model, "gpt-4o", "switching it back on restores the role");
});

test("deleting a provider unplugs the roles that used it and leaves the others alone", () => {
  let settings = upsertProvider(emptySettings(), openai());
  settings = upsertProvider(settings, { ...openai(), id: "p-local", label: "本地", credentialRef: null });
  settings = assignRole(settings, "tts", "p-local");
  settings = assignRole(settings, "agent", "p-openai");
  const after = removeProvider(settings, "p-local");
  assert.equal(after.providers.length, 1);
  assert.equal(after.roles.tts, null);
  assert.equal(after.roles.agent, "p-openai:agent");
});

test("a role can be switched off without losing the capability underneath", () => {
  let settings = upsertProvider(emptySettings(), openai());
  settings = assignRole(settings, "tts", "p-openai");
  const off = clearRole(settings, "tts");
  assert.equal(roleTarget(off, "tts"), undefined);
  assert.equal(capabilityOf(off.providers[0], "tts").enabled, true, "the capability is still there");
  assert.equal(assignRole(off, "tts", "p-openai").roles.tts, "p-openai:tts");
});

test("settings written by the first version are upgraded, not lost", () => {
  const legacy = {
    version: 1,
    providers: [
      { id: "p-openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", credentialRef: "openai", protocol: "openai", enabled: true },
    ],
    slots: [
      { id: "slot-agent", providerId: "p-openai", capability: "agent", model: "gpt-4o" },
      { id: "slot-tts", providerId: "p-openai", capability: "tts", model: "tts-1" },
    ],
    roles: { agent: "slot-agent", tts: "slot-tts", voice_clone: null, stt: null, image: null },
  };
  const upgraded = normalizeSettings(legacy);
  assert.equal(upgraded.version, 2);
  assert.equal(capabilityOf(upgraded.providers[0], "agent").defaultModel, "gpt-4o");
  assert.equal(capabilityTarget(upgraded.providers[0], "tts").baseUrl, "https://api.openai.com/v1", "the old endpoint is inherited");
  assert.equal(upgraded.roles.agent, "p-openai:agent", "role ids are rewritten to provider:capability");
  assert.equal(upgraded.roles.tts, "p-openai:tts");
  assert.equal(Object.hasOwn(upgraded, "slots"), false);
  assert.equal(roleTarget(upgraded, "agent")?.model, "gpt-4o", "and the role still resolves");
});

test("keys are named, never shown, and a provider needs a real endpoint", () => {
  assert.equal(credentialNameFor("My OpenAI", ["openai"]), "my-openai");
  assert.equal(maskKey("sk-abcdef1234"), "••••••••1234");
  assert.equal(maskKey(undefined), "");
  assert.deepEqual(providerProblems({ label: "OpenAI", baseUrl: "https://api.openai.com/v1" }), []);
  assert.deepEqual(providerProblems({ label: "", baseUrl: "api.openai.com" }), ["给它起个名字", "Base URL 要以 http:// 或 https:// 开头"]);
});
