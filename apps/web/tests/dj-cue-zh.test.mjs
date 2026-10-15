/**
 * AI 设 cue 翻译层（#ui-review F-4）的单测：样本句式逐条照抄 autocue.py 源码
 * （注释里标行号），插件句式变了这里会红——那就是补翻译的信号。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { zhBpmSource, zhCueNote, zhCueReason } from "../src/lib/dj-cue-zh.ts";

test("zhCueReason: in 候选两种（对齐/未对齐）", () => {
  // autocue.py:213
  assert.equal(
    zhCueReason("first stable onset at 22593ms, snapped 19ms onto the bar grid (bpm 84.9, grid fit 1.00)"),
    "第一个稳定起音 · 已对齐小节线",
  );
  // autocue.py:219
  assert.equal(
    zhCueReason("first stable onset at 22593ms; no reliable tempo grid, left unsnapped"),
    "第一个稳定起音（速度网格不可信，未对齐小节）",
  );
});

test("zhCueReason: out 候选四种", () => {
  // autocue.py:231
  assert.equal(
    zhCueReason("energy falls to 0% of the body at 338049ms and never recovers; snapped 69ms to the bar grid"),
    "能量衰到 0% 且未恢复 · 已对齐小节线",
  );
  // autocue.py:238
  assert.equal(
    zhCueReason("energy falls to 12% of the body at 338049ms and never recovers; unsnapped"),
    "能量衰到 12% 且未恢复（未对齐小节）",
  );
  // autocue.py:248
  assert.equal(zhCueReason("no clean final drop found; fallback at 90% of the duration"), "没找到干净的尾落 · 按 90% 位置兜底");
  // autocue.py:260
  assert.equal(zhCueReason("the detected drop landed before the in; fallback at 90% instead"), "尾落点在入口之前 · 改按 90% 位置兜底");
});

test("zhCueReason: loop 候选保留拍数、去自相似度浮点", () => {
  // autocue.py:290
  assert.equal(zhCueReason("16-beat section repeats immediately (self-similarity 0.93)"), "16 拍循环段 · 自相似度高");
  assert.equal(zhCueReason("8-beat section repeats immediately (self-similarity 0.71)"), "8 拍循环段 · 自相似度高");
});

test("zhCueReason: 不认得的句式 → null（调用方收进 title）", () => {
  assert.equal(zhCueReason(""), null);
  assert.equal(zhCueReason("some brand new sentence from a future plugin"), null);
  assert.equal(zhCueReason("energy falls to 0% of the body at 100ms"), null); // 半句不完整
});

test("zhCueNote: 七条 notes 全覆盖（autocue.py:201/205/251/264/267/271/282）", () => {
  assert.equal(zhCueNote("tempo grid too unreliable to snap to bar lines"), "速度网格不可信：cue 点未对齐小节线");
  assert.equal(zhCueNote("no stable start found — the level never settles above the floor"), "没找到稳定起点（响度一直没起来）");
  assert.equal(zhCueNote("the out is a 90% fallback — the track does not have a clean ending drop"), "出口按 90% 兜底：这首没有干净的尾落");
  assert.equal(zhCueNote("the natural out conflicted with the in, so the fallback was used"), "自然出口与入口冲突，已用兜底");
  assert.equal(zhCueNote("loop detection skipped: it needs a trustworthy tempo grid"), "跳过 loop 检测（需要可信的速度网格）");
  assert.equal(zhCueNote("no 8/16-beat section repeats cleanly enough to offer as a loop"), "没有足够工整的 8/16 拍循环段可提供");
  assert.equal(zhCueNote("the repeating section starts at or after the out, so no loop was offered"), "循环段起点在出口之后，未提供 loop");
  assert.equal(zhCueNote("a note we have not seen"), null);
});

test("zhBpmSource: 三值 + 未知透传", () => {
  assert.equal(zhBpmSource("argument"), "BPM 来自传入值");
  assert.equal(zhBpmSource("detected"), "BPM 本机检测");
  assert.equal(zhBpmSource("fallback"), "BPM 未知 · 按 120 兜底");
  assert.equal(zhBpmSource("something-new"), "something-new"); // 新来源放行（词短，不算英文长句）
});
