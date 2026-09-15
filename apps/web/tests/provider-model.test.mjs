/**
 * The model-profile layer, ported from the user's Shadow app.
 *
 * These assertions are the port's contract: the builders produce the same shapes Shadow's do, the
 * reasoning constants keep their effort lists, and a profile that says nothing stays silent instead of
 * inventing a context window.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_RESPONSES_REASONING,
  GLM_REASONING,
  MINIMAX_BUILT_IN_REASONING,
  MINIMAX_M3_REASONING,
  XIAOMI_REASONING,
  copyModelProfiles,
  describeProfile,
  minimaxM2ChatProfile,
  minimaxM3ChatProfile,
  plainTextProfile,
  textChatProfile,
  visionChatProfile,
  withPriorityServiceTier,
  xiaomiVisionChatProfile,
} from "../src/lib/providerModel.ts";

test("a text chat model is text-only, tool-calling, and says nothing it does not know", () => {
  const bare = textChatProfile();
  assert.deepEqual(bare.inputModalities, ["text"]);
  assert.deepEqual(bare.outputModalities, ["text"]);
  assert.deepEqual(bare.messageParts, ["text"]);
  assert.equal(bare.supportsToolCalling, true);
  assert.equal("contextWindowTokens" in bare, false, "an unknown window stays unknown");
  assert.equal(bare.reasoning, undefined);
});

test("a vision model takes images and declares the message part it needs", () => {
  const vision = visionChatProfile(200_000, CODEX_RESPONSES_REASONING);
  assert.deepEqual(vision.inputModalities, ["text", "image"]);
  assert.deepEqual(vision.messageParts, ["text", "image_url"]);
  assert.equal(vision.contextWindowTokens, 200_000);
  assert.equal(vision.reasoning?.requestProtocol, "openai-responses");
});

test("the reasoning constants keep Shadow's effort lists", () => {
  assert.deepEqual(MINIMAX_M3_REASONING, { supportedEfforts: ["auto", "off"], defaultEffort: "auto", requestProtocol: "anthropic-thinking" });
  assert.deepEqual(MINIMAX_BUILT_IN_REASONING, { supportedEfforts: ["auto"], defaultEffort: "auto", requestProtocol: "none" });
  assert.deepEqual(XIAOMI_REASONING.supportedEfforts, ["off", "low", "medium", "high"]);
  assert.deepEqual(GLM_REASONING.supportedEfforts, ["off", "high", "max"]);
  assert.equal(CODEX_RESPONSES_REASONING.defaultEffort, "high");
});

test("the preset profiles match what Shadow ships for MiniMax and Xiaomi", () => {
  const m3 = minimaxM3ChatProfile();
  assert.equal(m3.contextWindowTokens, 1_000_000);
  assert.deepEqual(m3.inputModalities, ["text", "image"], "M3 sees images");
  const m2 = minimaxM2ChatProfile();
  assert.equal(m2.contextWindowTokens, 204_800);
  assert.deepEqual(m2.reasoning?.supportedEfforts, ["auto"]);
  assert.deepEqual(xiaomiVisionChatProfile(256_000).inputModalities, ["text", "image"]);
});

test("copying profiles is a deep copy — editing one never edits the constant", () => {
  const source = { "m3": minimaxM3ChatProfile() };
  const copy = copyModelProfiles(source);
  copy["m3"].inputModalities.push("audio");
  copy["m3"].reasoning?.supportedEfforts.push("max");
  assert.deepEqual(source["m3"].inputModalities, ["text", "image"]);
  assert.deepEqual(source["m3"].reasoning?.supportedEfforts, ["auto", "off"]);
  assert.deepEqual(copyModelProfiles(undefined), {});
});

test("a plain local model is honestly described as not calling tools", () => {
  const local = plainTextProfile(32_000);
  assert.equal(local.supportsToolCalling, false);
  assert.match(describeProfile(local), /不调工具/);
  assert.match(describeProfile(withPriorityServiceTier(minimaxM3ChatProfile())), /可看图 · 会调工具/);
  assert.equal(describeProfile(undefined), "未填写模型档案");
});
