/**
 * 会话环形缓冲单测（S4 巡检遗留：连续通话 5 分钟内存 <30MB / 忘掉刚才）。
 * capSession 是 patchSession 的唯一出口——长通话里每轮都会经过它。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { capSession, MAX_CALLS, MAX_DETAIL_CHARS, MAX_MESSAGES } from "../src/lib/sessions.ts";

const call = (i, { running = false, detailSize = 64 } = {}) => ({
  id: `call-${i}`,
  server: "analysis",
  name: "hum_to_midi",
  status: running ? "running" : "ok",
  summary: `tool-${i}`,
  detail: `{"result":{"content":[{"text":"${"x".repeat(detailSize)}"}]}}`,
});

const session = (i) => ({
  id: "s-1",
  title: "通话",
  createdAt: 0,
  messages: [{ id: `m-${i}`, role: "user", text: `第 ${i} 轮`, at: i }],
  calls: [],
});

test("capSession: 消息与调用都按最近窗口裁（忘掉刚才）", () => {
  let s = session(0);
  for (let i = 0; i < MAX_MESSAGES + 40; i += 1) {
    s = capSession({
      ...s,
      messages: [...s.messages, { id: `m-${i}`, role: "user", text: `第 ${i} 轮`, at: i }],
      calls: [...s.calls, call(i)],
    });
  }
  assert.equal(s.messages.length, MAX_MESSAGES);
  assert.equal(s.calls.length, MAX_CALLS);
  // 最新一条在、最早一条没了（环形语义）。
  assert.equal(s.messages.at(-1).text, `第 ${MAX_MESSAGES + 39} 轮`);
  assert.equal(s.calls.at(-1).id, `call-${MAX_MESSAGES + 39}`);
  assert.equal(s.calls.at(0).id, `call-${MAX_MESSAGES + 40 - MAX_CALLS}`);
});

test("capSession: 旧条目 detail 截断并戳明；运行中与短 detail 不动", () => {
  const long = call(1, { detailSize: MAX_DETAIL_CHARS + 500 });
  const running = call(2, { running: true, detailSize: MAX_DETAIL_CHARS + 500 });
  const short = call(3, { detailSize: 32 });
  const s = capSession({ ...session(0), calls: [long, running, short] });
  assert.ok(s.calls[0].detail.length <= MAX_DETAIL_CHARS + 40);
  assert.ok(s.calls[0].detail.includes("环形缓冲"));
  assert.equal(s.calls[1].detail.length, long.detail.length); // running 原样
  assert.equal(s.calls[2].detail, short.detail);
});

test("capSession: 5 分钟连续通话模拟——100 轮 5KB detail，体积与条数有界", () => {
  // 5 分钟 ≈ 100 轮（3 秒一轮）；每轮 detail 5KB（工具结果偏大档）。
  let s = session(0);
  for (let i = 0; i < 100; i += 1) {
    s = capSession({
      ...s,
      messages: [
        ...s.messages,
        { id: `u-${i}`, role: "user", text: `第 ${i} 轮说的话`, at: i },
        { id: `a-${i}`, role: "assistant", text: `第 ${i} 轮的答复文本`, at: i },
        { id: `t-${i}`, role: "tool", callId: `call-${i}`, at: i },
      ],
      calls: [...s.calls, call(i, { detailSize: 5000 })],
    });
  }
  const bytes = JSON.stringify(s).length;
  assert.ok(s.messages.length <= MAX_MESSAGES, `messages=${s.messages.length}`);
  assert.ok(s.calls.length <= MAX_CALLS, `calls=${s.calls.length}`);
  assert.ok(bytes < 1_500_000, `5 分钟通话会话体积 ${bytes}B 应远小于 1.5MB（≈30MB 内存线的 5%）`);
});
