import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationRecoveryBlock } from "../src/lib/conversation-recovery.ts";

const at = (index) => index + 1;

test("恢复块只带最近 6 条用户/助手正文，保持原顺序", () => {
  const messages = [
    { id: "u0", role: "user", text: "old", at: 0 },
    { id: "r0", role: "reasoning", text: "secret", at: 0 },
    { id: "tool", role: "tool", callId: "x", at: 0 },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? "assistant" : "user",
      text: `line-${index}`,
      at: at(index),
    })),
  ];
  const block = conversationRecoveryBlock(messages);
  assert.match(block.join("\n"), /\[recent_conversation\]/);
  assert.match(block.at(-1), /\/recent_conversation/);
  const body = block.join("\n");
  assert.doesNotMatch(body, /old/);
  assert.doesNotMatch(body, /secret/);
  assert.match(body, /line-5/);
  assert.match(body, /line-0/);
  assert.ok(body.indexOf("line-0") < body.indexOf("line-5"));
});

test("恢复块有总字符预算，优先保留最新消息", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    id: `m${index}`,
    role: "user",
    text: `${index}:${"x".repeat(500)}`,
    at: index,
  }));
  const body = conversationRecoveryBlock(messages).join("\n");
  assert.match(body, /7:/);
  assert.doesNotMatch(body, /0:/);
  assert.ok(body.length < 2100, `length=${body.length}`);
});

test("没有正文时返回空数组，不制造空上下文", () => {
  assert.deepEqual(conversationRecoveryBlock([]), []);
  assert.deepEqual(
    conversationRecoveryBlock([{ id: "r", role: "reasoning", text: "thinking", at: 1 }]),
    [],
  );
});
