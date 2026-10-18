import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSession,
  loadSessions,
  selectSession,
  sessionForKind,
} from "../src/lib/sessions.ts";

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
};

const useStorage = (storage) => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
};

test("old stores migrate activeId to a butler topic without losing messages", () => {
  const storage = memoryStorage();
  useStorage(storage);
  storage.setItem(
    "shadowroom.sessions.v1",
    JSON.stringify({
      activeId: "old-1",
      sessions: [
        {
          id: "old-1",
          title: "旧对话",
          createdAt: 10,
          messages: [{ id: "m1", role: "user", text: "hello", at: 20 }],
          calls: [],
        },
      ],
    }),
  );
  const store = loadSessions();
  assert.equal(store.activeButlerId, "old-1");
  assert.equal(store.sessions[0].kind, "butler");
  assert.deepEqual(store.sessions[0].scope, { workspaceId: "butler" });
  assert.equal(store.sessions[0].messages.length, 1);
});

test("worker endpoints are one per page and never take over the butler selection", () => {
  const butler = createSession("butler");
  let store = selectSession({ sessions: [] }, butler);
  const studio = createSession("studio");
  const dj = createSession("dj");
  store = selectSession(store, studio);
  store = selectSession(store, dj);
  assert.equal(sessionForKind(store, "butler")?.id, butler.id);
  assert.equal(sessionForKind(store, "studio")?.id, studio.id);
  assert.equal(sessionForKind(store, "dj")?.id, dj.id);
  assert.equal(store.sessions.length, 3);
});

test("new worker sessions have user-facing fixed names and isolated scopes", () => {
  assert.equal(createSession("butler").title, "新对话");
  assert.equal(createSession("studio").title, "Studio 助手");
  assert.equal(createSession("dj").title, "DJ 助手");
  assert.equal(createSession("library").title, "曲目库助手");
});
