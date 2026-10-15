/**
 * 思考行收敛（Kimi UI 评审 F-5）：折叠行标题只有一处说法——「想了 N 秒」（进行中「在想…」），
 * 英文原文与 tokens 读数不再出现在对话页默认态。
 *
 * Run with `node --test`（Node 自带 runner，`.ts` 由 Node 24 剥类型）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reasoningSeconds, reasoningTitle } from "../src/lib/reasoning-title.ts";
import { callWord } from "../src/lib/call-words.ts";

test("折叠标题：想完 = 「想了 N 秒」，匹配评审验收的 /^想了 \\d+ 秒$/", () => {
  assert.equal(reasoningTitle(false, 13), "想了 13 秒");
  assert.equal(reasoningTitle(false, 1), "想了 1 秒");
  assert.match(reasoningTitle(false, 32_091), /^想了 \d+ 秒$/);
  assert.doesNotMatch(reasoningTitle(false, 13), /tokens|秒.*[a-zA-Z]/, "标题里不带读数和英文");
});

test("进行中 = 「在想…」，且与通话状态词同一来源（全产品一个「在想…」）", () => {
  assert.equal(reasoningTitle(true), "在想…");
  assert.equal(reasoningTitle(true), callWord("thinking"));
});

test("推不出结束时刻（思考块被裁成会话最后一条）：说「想好了」，不编数字", () => {
  assert.equal(reasoningTitle(false, undefined), "想好了");
  assert.doesNotMatch(reasoningTitle(false, undefined), /\d/);
});

test("秒数推导：四舍五入；不足 1 秒 / 0 / 负差值都落回 1（「想了 0 秒」不是人话）", () => {
  assert.equal(reasoningSeconds(1_000, 14_000), 13);
  assert.equal(reasoningSeconds(1_000, 1_400), 1);
  assert.equal(reasoningSeconds(1_000, 1_000), 1);
  assert.equal(reasoningSeconds(2_000, 1_000), 1);
});

test("ReasoningRow 不再自己写标题词或英文摘要，一律取 reasoningTitle", () => {
  const row = readFileSync(new URL("../src/components/ReasoningRow.tsx", import.meta.url), "utf8");
  assert.match(row, /from "\.\.\/lib\/reasoning-title"/, "标题必须从词表取");
  assert.match(row, /reasoningTitle\(running, seconds\)/, "标题经 reasoningTitle 生成");
  assert.doesNotMatch(row, /["'`]想了|["'`]在想|["'`]想好了/, "组件内不另写字面量词");
  assert.doesNotMatch(row, /firstLine|latestLine/, "英文摘要函数已删");
});

test("usage 行不再往页面打 tokens：文本只进 title", () => {
  const transcript = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  const usage = transcript.slice(transcript.indexOf('role === "usage"'));
  assert.match(usage, /title=\{message\.text\}/, "读数挂 title，hover 才见");
  assert.match(usage, /<\/p>|\/>/, "节点自闭合/收口，不含 {message.text} 子文本");
  assert.doesNotMatch(usage, />\{message\.text\}</, "页面默认态不渲染 tokens 字样");
});

test("死样式跟着删：conversation.css 不留 sr-think-summary / sr-think-sep", () => {
  const css = readFileSync(new URL("../src/styles/conversation.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /sr-think-summary|sr-think-sep/);
});
