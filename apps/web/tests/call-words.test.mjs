/**
 * 通话状态词只有一份（用户 2026-10-16：「非常不清晰」——球字幕写「在听…」、通话条写「正在听」，
 * 同一秒钟两个词）。这里钉两件事：词表本身，和「没有人在组件里另写一套」。
 *
 * Run with `pnpm test`（Node 自带 runner，`.ts` 由 Node 24 剥类型）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CALL_START_HINT, callWord } from "../src/lib/call-words.ts";

test("三个状态各一个词，且是用户看到的那三个", () => {
  assert.equal(callWord("listening"), "在听…");
  assert.equal(callWord("thinking"), "在想…");
  assert.equal(callWord("speaking"), "在说…");
});

test("起手提示说清两件事：怎么说话、怎么挂断", () => {
  assert.equal(CALL_START_HINT, "说就行 · 点球挂断");
  assert.match(CALL_START_HINT, /挂断/);
});

test("状态词只渲染在球字幕一处（F-2）：App 取词表，通话条零状态词", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /from "\.\.?\/(lib\/)?call-words"/, "App.tsx（球字幕）应当从 lib/call-words 取词");
  const composer = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  // F-2（ui-review-kimi §③）：通话条没有状态位——词表引用一并消失，谁再引就是状态词回流 dock。
  assert.doesNotMatch(composer, /call-words|callWord/, "Composer.tsx 不应再引用词表（状态只渲染在球旁字幕）");
  // 旧写法：同一状态两个词。出现过就说明又有人手写了一套。
  for (const stale of ["正在听", "正在想", "正在说", "在想……"]) {
    assert.equal(app.includes(stale), false, `App.tsx 里还有旧写法「${stale}」`);
  }
  // 词表那三个词在通话条里连字面量都不许出现（App.tsx 经 callWord 渲染、注释也会合法提到，只查这里）。
  for (const word of ["在听…", "在想…", "在说…"]) {
    assert.equal(composer.includes(word), false, `Composer.tsx 里出现了状态词「${word}」——状态只渲染在球旁字幕`);
  }
});
