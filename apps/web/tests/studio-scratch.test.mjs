/**
 * 试凑区纯逻辑（#bitwig-adoption A 项）的单测：60 格上限按旧到新剪、循环槽 ≤4 LRU 顶替、
 * 下一小节边界永不落在过去（启动误差验收 |Δ|≤30ms 的数学底座）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SCRATCH_MAX_CELLS,
  SCRATCH_MAX_LOOPS,
  addScratchClip,
  admitLoop,
  nextBarBoundaryMs,
  removeScratchClip,
} from "../src/lib/studio-scratch.ts";

const project = (scratch) => ({
  id: "p1", name: "t", updatedAt: 0, bpm: 120, key: "", bars: 8, tracks: [],
  ...(scratch === undefined ? {} : { scratch }),
});
const clip = (id) => ({ id, name: id, start: 0, length: 2 });

test("addScratchClip: 追加；无 scratch 字段的老工程自动建数组", () => {
  const first = addScratchClip(project(undefined), clip("a"));
  assert.deepEqual(first.scratch.map((c) => c.id), ["a"]);
  const second = addScratchClip(first, clip("b"));
  assert.deepEqual(second.scratch.map((c) => c.id), ["a", "b"]);
});

test(`addScratchClip: 超过 ${SCRATCH_MAX_CELLS} 格按旧到新剪`, () => {
  let current = project([]);
  for (let i = 0; i < SCRATCH_MAX_CELLS + 3; i += 1) current = addScratchClip(current, clip(`c${i}`));
  assert.equal(current.scratch.length, SCRATCH_MAX_CELLS);
  assert.equal(current.scratch[0].id, "c3"); // 最旧的三格被剪掉
  assert.equal(current.scratch.at(-1).id, `c${SCRATCH_MAX_CELLS + 2}`);
});

test("removeScratchClip: 按 id 移除；不存在的 id 原样返回", () => {
  const base = addScratchClip(addScratchClip(project([]), clip("a")), clip("b"));
  assert.deepEqual(removeScratchClip(base, "a").scratch.map((c) => c.id), ["b"]);
  assert.deepEqual(removeScratchClip(base, "nope").scratch.map((c) => c.id), ["a", "b"]);
  assert.deepEqual(removeScratchClip(project(undefined), "a").scratch, []);
});

test("nextBarBoundaryMs: 永远落在将来，边界内侧不跳拍", () => {
  assert.equal(nextBarBoundaryMs(0, 1000, 0), 1000); // 原点即边界 → 下一小节
  assert.equal(nextBarBoundaryMs(500, 1000, 0), 1000);
  assert.equal(nextBarBoundaryMs(999, 1000, 0), 1000); // 差 1ms 到边界 → 不多等一拍
  assert.equal(nextBarBoundaryMs(1000, 1000, 0), 2000); // 恰好踩过边界 → 下一小节
  assert.equal(nextBarBoundaryMs(1001, 1000, 0), 2000);
  assert.equal(nextBarBoundaryMs(1500, 1000, 300), 2300); // origin 偏移对齐
  assert.equal(nextBarBoundaryMs(0, 1000, 500), 1500); // now 早于 origin 时从 origin 起算
});

test("admitLoop: 未满追加，已在槽不动", () => {
  const empty = admitLoop([], "a", 100);
  assert.deepEqual(empty, { slots: [{ clipId: "a", startedAt: 100 }], evicted: [] });
  const again = admitLoop(empty.slots, "a", 200);
  assert.equal(again.slots, empty.slots); // 原数组引用，不制造重渲染
  assert.deepEqual(again.evicted, []);
  const second = admitLoop(empty.slots, "b", 300);
  assert.deepEqual(second.slots.map((s) => s.clipId), ["a", "b"]);
});

test(`admitLoop: 第 ${SCRATCH_MAX_LOOPS + 1} 个顶掉最旧的（LRU）`, () => {
  let slots = [];
  for (const [i, id] of ["a", "b", "c", "d"].entries()) slots = admitLoop(slots, id, i).slots;
  assert.equal(slots.length, SCRATCH_MAX_LOOPS);
  const fifth = admitLoop(slots, "e", 99);
  assert.deepEqual(fifth.evicted, ["a"]); // 最旧的被顶
  assert.deepEqual(fifth.slots.map((s) => s.clipId), ["b", "c", "d", "e"]);
  assert.equal(fifth.slots.at(-1).startedAt, 99);
});

test("admitLoop: 自定义上限同样成立", () => {
  let slots = [];
  slots = admitLoop(slots, "a", 1, 2).slots;
  slots = admitLoop(slots, "b", 2, 2).slots;
  const third = admitLoop(slots, "c", 3, 2);
  assert.deepEqual(third.evicted, ["a"]);
  assert.deepEqual(third.slots.map((s) => s.clipId), ["b", "c"]);
});
