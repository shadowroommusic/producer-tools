/**
 * 对话顺序 mock 5/5（lib/conversation-flow.ts）：textA→tool1→textB→tool2→textC 必须精确
 * 渲染 3 个 assistant 气泡 + 2 个 tool 行——Kimi #484 第 1 条的判定形状。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendAssistantDelta, segmentKeyFor } from "../src/lib/conversation-flow.ts";

/** Replay one turn's message-level events through the same reducer App uses. */
function replay(events) {
  let messages = [{ id: "u1", role: "user", text: "做个 demo", at: 1 }];
  for (const event of events) {
    if (event.type === "delta") {
      const key = segmentKeyFor(event.itemId, event.turnId, `at-${messages.length}`);
      messages = appendAssistantDelta(messages, event.text, key, Date.now());
    } else if (event.type === "tool") {
      messages = [...messages, { id: `c-${event.id}`, role: "tool", callId: event.id, at: Date.now() }];
    } else if (event.type === "reasoning") {
      messages = [...messages, { id: `r-${event.itemId}`, role: "reasoning", text: event.text, at: Date.now() }];
    }
  }
  return messages;
}

test("① mock 序列精确：A、tool1、B、tool2、C（3 气泡 + 2 tool 行）", () => {
  const messages = replay([
    { type: "delta", itemId: "m1", turnId: "t1", text: "A" },
    { type: "tool", id: "tool1" },
    { type: "delta", itemId: "m2", turnId: "t1", text: "B" },
    { type: "tool", id: "tool2" },
    { type: "delta", itemId: "m3", turnId: "t1", text: "C" },
  ]);
  assert.deepEqual(
    messages.map((m) => (m.role === "assistant" ? `text:${m.text}` : m.role === "tool" ? `tool:${m.callId}` : m.role)),
    ["user", "text:A", "tool:tool1", "text:B", "tool:tool2", "text:C"],
  );
  assert.equal(messages.filter((m) => m.role === "assistant").length, 3);
  assert.equal(messages.filter((m) => m.role === "tool").length, 2);
});

test("② 同一 itemId 连续 delta 只长一个气泡", () => {
  const messages = replay([
    { type: "delta", itemId: "m1", turnId: "t1", text: "Hel" },
    { type: "delta", itemId: "m1", turnId: "t1", text: "lo" },
    { type: "delta", itemId: "m1", turnId: "t1", text: "!" },
  ]);
  assert.equal(messages.filter((m) => m.role === "assistant").length, 1);
  assert.equal(messages[messages.length - 1].text, "Hello!");
});

test("③ reasoning 之后的文字必须新开气泡（即便 itemId 复用）", () => {
  const messages = replay([
    { type: "delta", itemId: "m1", turnId: "t1", text: "先想一下" },
    { type: "reasoning", itemId: "rs1", text: "thinking…" },
    { type: "delta", itemId: "m1", turnId: "t1", text: "接着说" },
  ]);
  const assistants = messages.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants.map((m) => m.text), ["先想一下", "接着说"]);
  assert.equal(assistants[1].id, "a-m1-2", "id 冲突加序号，不合并进旧气泡");
});

test("④ 旧 core 无 itemId：按 turnId 退化成一段，tool 之后的新 delta 仍是新气泡", () => {
  const messages = replay([
    { type: "delta", turnId: "t9", text: "旧core文字" },
    { type: "tool", id: "toolX" },
    { type: "delta", turnId: "t9", text: "工具后继续" },
  ]);
  const assistants = messages.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants.map((m) => m.text), ["旧core文字", "工具后继续"]);
});

test("⑤ 多轮各自独立：turn2 的气泡不落进 turn1 的尾巴", () => {
  const messages = replay([
    { type: "delta", itemId: "m1", turnId: "t1", text: "第一轮答案" },
    { type: "delta", itemId: "m2", turnId: "t2", text: "第二轮答案" },
  ]);
  assert.deepEqual(
    messages.filter((m) => m.role === "assistant").map((m) => m.text),
    ["第一轮答案", "第二轮答案"],
  );
});
