/**
 * effort 过滤 3/3（lib/agent-settings.ts）：真实可映射档可见；`none` 锁定；未知协议/单档/
 * 无声明隐藏且发送不带 effort——自定义 provider 的 effort 不许假装支持（Kimi #484 第 6 条）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { effortChoiceFor, effortForModel, effortForSend, normalizeAgentSettings } from "../src/lib/agent-settings.ts";

const model = (fields) => fields;

test("① openai-responses 多档：可见、默认档正确、发送带档", () => {
  const m = model({
    supportedReasoningEfforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    defaultReasoningEffort: "high",
    reasoningProtocol: "openai-responses",
  });
  const choice = effortChoiceFor(m);
  assert.equal(choice.kind, "list");
  assert.deepEqual(choice.efforts, ["low", "medium", "high"]);
  assert.equal(choice.defaultEffort, "high");
  assert.equal(effortForModel(m), "high");
  assert.equal(effortForSend(m, "low"), "low");
});

test("② none 协议：锁定唯一档，发送不带 effort", () => {
  const m = model({
    supportedReasoningEfforts: [{ effort: "auto" }, { effort: "off" }],
    defaultReasoningEffort: "auto",
    reasoningProtocol: "none",
  });
  const choice = effortChoiceFor(m);
  assert.equal(choice.kind, "locked");
  assert.equal(choice.effort, "auto");
  assert.equal(effortForModel(m), undefined);
  assert.equal(effortForSend(m, "auto"), undefined, "locked 档不进请求");
});

test("③ 未知协议 / 无声明 / 单档：全部隐藏，sendTurn 不带 effort", () => {
  // 未知协议（glm-chat-completions 之类的 provider 私有协议——适配器没映射它）
  const unknown = model({
    supportedReasoningEfforts: [{ effort: "off" }, { effort: "high" }],
    defaultReasoningEffort: "high",
    reasoningProtocol: "glm-chat-completions",
  });
  assert.equal(effortChoiceFor(unknown).kind, "hidden");
  assert.equal(effortForSend(unknown, "high"), undefined);
  // 无声明（ModelProfile 没有 reasoning）
  assert.equal(effortChoiceFor(model({ supportedReasoningEfforts: [] })).kind, "hidden");
  assert.equal(effortChoiceFor(undefined).kind, "hidden");
  // 单档不算选择
  const single = model({
    supportedReasoningEfforts: [{ effort: "only" }],
    reasoningProtocol: "openai-responses",
  });
  assert.equal(effortChoiceFor(single).kind, "hidden");
  assert.equal(effortForSend(single, "only"), undefined);
  // 陈旧档（换了模型没换档）也不会发出去
  const multi = model({
    supportedReasoningEfforts: [{ effort: "low" }, { effort: "high" }],
    reasoningProtocol: "openai-responses",
  });
  assert.equal(effortForSend(multi, "max"), undefined);
});

test("normalizeAgentSettings：收窄未知数据，access 缺省回落工作区可写", () => {
  assert.deepEqual(normalizeAgentSettings(null), { access: "workspace-write" });
  assert.deepEqual(normalizeAgentSettings({ access: "danger-full-access" }), { access: "danger-full-access" });
  assert.deepEqual(normalizeAgentSettings({ modelId: "", effort: "", access: "乱写" }), { access: "workspace-write" });
  assert.deepEqual(normalizeAgentSettings({ modelId: "gpt-5.3", effort: "low", access: "read-only" }), {
    modelId: "gpt-5.3",
    effort: "low",
    access: "read-only",
  });
});
