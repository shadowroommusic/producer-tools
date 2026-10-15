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

test("两个通话界面都从词表取词，没有各自的写法", () => {
  const files = ["../src/App.tsx", "../src/components/Composer.tsx"];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /from "\.\.?\/(lib\/)?call-words"/, `${file} 应当从 lib/call-words 取词`);
    // 旧写法：同一状态两个词。出现过就说明又有人手写了一套。
    for (const stale of ["正在听", "正在想", "正在说", "在想……"]) {
      assert.equal(source.includes(stale), false, `${file} 里还有旧写法「${stale}」`);
    }
  }
});
