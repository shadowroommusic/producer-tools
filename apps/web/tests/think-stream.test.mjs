/**
 * think 流式状态机（tools/think-stream.mjs）——bridge 在 assistant delta 出口剥 `<think>` 的唯一实现。
 *
 * 八个验收场景来自 HANDOFF「conversation-controls-20261020」：正文里不允许再出现任何
 * `<think>` 标签，思考全文必须走 reasoning 通道；标签可以以任意方式跨 chunk。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createThinkFilter,
  splitThinkBlocks,
  ACCESS_PRESETS,
  accessPreset,
} from "../../../tools/think-stream.mjs";

/** Drive one filter with chunks; returns everything the two channels ever emitted. */
function run(chunks, { flush = true } = {}) {
  const filter = createThinkFilter();
  let text = "";
  let reasoning = "";
  for (const chunk of chunks) {
    const out = filter.push(chunk);
    text += out.text;
    reasoning += out.reasoning;
  }
  if (flush) {
    const out = filter.flush();
    text += out.text;
    reasoning += out.reasoning;
  }
  return { text, reasoning };
}

test("① 整块：think 一次到齐，正文只剩净文本", () => {
  const out = run(["<think>plan the answer</think>Hello!"]);
  assert.equal(out.text, "Hello!");
  assert.equal(out.reasoning, "plan the answer");
});

test("② 跨 2 chunk：开标签被劈开", () => {
  const out = run(["<thi", "nk>plan</think>Hello!"]);
  assert.equal(out.text, "Hello!");
  assert.equal(out.reasoning, "plan");
});

test("③ 跨 3 chunk：标签与内容分三段", () => {
  const out = run(["<th", "ink>plan", " more</think>Hello!"]);
  assert.equal(out.text, "Hello!");
  assert.equal(out.reasoning, "plan more");
});

test("④ 多个块：两段 think 都进 reasoning，两段正文保序", () => {
  const out = run(["<think>a</think>one", "<think>b</think>two"]);
  assert.equal(out.text, "onetwo");
  assert.equal(out.reasoning, "ab");
});

test("⑤ 无闭合兜底：残缺 think 不吞正文，内容走 reasoning", () => {
  const out = run(["Hello! <think>half a thought"]);
  assert.equal(out.text, "Hello! ");
  assert.equal(out.reasoning, "half a thought");
});

test("⑥ 空块：<think></think> 一闪而过", () => {
  const out = run(["<think></think>Hello!"]);
  assert.equal(out.text, "Hello!");
  assert.equal(out.reasoning, "");
});

test("⑦ 标签在末尾：孤立的 <think> 原样还给正文，不丢字节", () => {
  const out = run(["Hello!<think"]);
  assert.equal(out.text, "Hello!<think");
  assert.equal(out.reasoning, "");
});

test("⑧ 正文含普通 think 字样：不带标签的词原样通过", () => {
  const out = run(["I think about kicks, and 2<3 them"]);
  assert.equal(out.text, "I think about kicks, and 2<3 them");
  assert.equal(out.reasoning, "");
});

test("⑧b 闭标签也跨 chunk", () => {
  const out = run(["<think>reasoning</thi", "nk>Hello!"]);
  assert.equal(out.text, "Hello!");
  assert.equal(out.reasoning, "reasoning");
});

test("splitThinkBlocks：一次成型文本的同一规则（历史迁移用）", () => {
  const out = splitThinkBlocks("<think>a</think>one<think>b</think>two");
  assert.equal(out.text, "onetwo");
  assert.deepEqual(out.thinks, ["a", "b"]);
  const unclosed = splitThinkBlocks("one<think>tail");
  assert.equal(unclosed.text, "one");
  assert.deepEqual(unclosed.thinks, ["tail"]);
  assert.deepEqual(splitThinkBlocks("no tags").thinks, []);
});

test("权限映射：三档 sandbox/approval 元组逐项精确（Kimi #484 表）", () => {
  assert.deepEqual(ACCESS_PRESETS["read-only"], {
    sandboxSlug: "read-only",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: "on-request",
  });
  assert.deepEqual(ACCESS_PRESETS["workspace-write"], {
    sandboxSlug: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    approvalPolicy: "on-request",
  });
  assert.deepEqual(ACCESS_PRESETS["danger-full-access"], {
    sandboxSlug: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
    approvalPolicy: "never",
  });
  // 未知档回落默认（工作区可写），不猜别的组合。
  assert.equal(accessPreset("yolo").sandboxSlug, "workspace-write");
  assert.equal(accessPreset(undefined).sandboxSlug, "workspace-write");
});
