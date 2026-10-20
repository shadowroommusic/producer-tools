/**
 * 历史 think 迁移（loadSessions → migrateSessionThink）· 3 条 fixture，幂等 + 顺序不变。
 * 规格来自 HANDOFF「conversation-controls-20261020」验收 2：迁移后正文 0 标签、reasoning
 * 数正确、顺序不变、重复跑幂等。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSessions, migrateSessionThink } from "../src/lib/sessions.ts";

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
};
const useStorage = (storage) => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
};

/** Re-run a session through the store loader twice — the path real reloads take. */
const loadTwice = (messages) => {
  const storage = memoryStorage();
  useStorage(storage);
  const seed = JSON.stringify({
    activeButlerId: "s1",
    sessions: [{ id: "s1", title: "t", createdAt: 1, kind: "butler", scope: { workspaceId: "butler" }, messages, calls: [] }],
  });
  storage.setItem("shadowroom.sessions.v1", seed);
  const once = loadSessions().sessions[0].messages;
  storage.setItem("shadowroom.sessions.v1", JSON.stringify({
    activeButlerId: "s1",
    sessions: [{ id: "s1", title: "t", createdAt: 1, kind: "butler", scope: { workspaceId: "butler" }, messages: once, calls: [] }],
  }));
  const twice = loadSessions().sessions[0].messages;
  return { once, twice };
};

test("fixture 1：单块 think——正文剥净、一条 reasoning、顺序 user→reasoning→assistant", () => {
  const { once, twice } = loadTwice([
    { id: "u1", role: "user", text: "hi", at: 1 },
    { id: "a1", role: "assistant", text: "<think>ponder this</think>答案在这里。", at: 2 },
  ]);
  const assistants = once.filter((m) => m.role === "assistant");
  const reasonings = once.filter((m) => m.reasoning !== undefined || m.role === "reasoning");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "答案在这里。");
  assert.equal(reasonings.length, 1);
  assert.equal(reasonings[0].text, "ponder this");
  assert.deepEqual(once.map((m) => m.role), ["user", "reasoning", "assistant"]);
  // 幂等：再加载一遍不多插。
  assert.deepEqual(twice.map((m) => `${m.role}:${m.text}`), once.map((m) => `${m.role}:${m.text}`));
});

test("fixture 2：多块 think——两段思考各成一行，正文只剩两段净文本", () => {
  const { once, twice } = loadTwice([
    { id: "a2", role: "assistant", text: "<think>part one</think>可见一<think>part two</think>可见二", at: 2 },
  ]);
  const reasonings = once.filter((m) => m.role === "reasoning");
  assert.equal(reasonings.length, 2);
  assert.deepEqual(reasonings.map((m) => m.text), ["part one", "part two"]);
  const assistant = once.find((m) => m.role === "assistant");
  assert.equal(assistant.text, "可见一可见二");
  assert.ok(!once.some((m) => m.text.includes("<think")));
  assert.deepEqual(twice, once);
});

test("fixture 3：未闭合 think——思考进 reasoning、正文完整、同样幂等", () => {
  const { once, twice } = loadTwice([
    { id: "a3", role: "assistant", text: "先说结论。<think>还没想完就被截断", at: 2 },
  ]);
  const assistant = once.find((m) => m.role === "assistant");
  const reasoning = once.find((m) => m.role === "reasoning");
  assert.equal(assistant.text, "先说结论。");
  assert.equal(reasoning.text, "还没想完就被截断");
  assert.deepEqual(once.map((m) => m.role), ["reasoning", "assistant"]);
  assert.deepEqual(twice, once);
});

test("干净会话原样返回（迁移零成本）", () => {
  const messages = [
    { id: "u1", role: "user", text: "普通正文里有 think 这个词", at: 1 },
    { id: "a1", role: "assistant", text: "I think it works.", at: 2 },
  ];
  assert.equal(migrateSessionThink(messages), messages);
});
