/**
 * S1：朗读版文本的确定性规则（任务 voice-conversation-20261020）。
 *
 * 这里钉的是"耳朵里听到什么"：think、代码、表格、URL、绝对路径、工具日志都不许被念；
 * 短答最多 2 句 / 70 字，展开最多 8 句 / 360 字；超预算时退到逗号，绝不念半句。
 *
 * Run with `pnpm test`（Node 自带 runner，`.ts` 由 Node 24 剥类型）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPEECH_BUDGETS,
  SPEECH_TURN_MAX_MS,
  createSpeechFeeder,
  speechSentences,
  speechText,
  splitSpeechSentences,
  spokenLength,
  stripForSpeech,
} from "../src/lib/speech-text.ts";

/** 用户 2026-10-20 贴的那类"整份状态"回答：正是"读很久"的来源。 */
const STATUS_FIXTURE = [
  "<think>先查一下当前页面，再确认曲库规模。</think>",
  "当前页面是曲目库，51 首曲都在库里。",
  "工程和 Set 这边没有变化。",
  "最近 10 次切换分别是 Studio、DJ、曲目库，来回切了 10 次。",
  "职责边界是这样的：Studio 负责编曲，DJ 负责 Set，曲目库负责入库。",
  "",
  "| 项目 | 数量 |",
  "| --- | --- |",
  "| 曲目 | 51 |",
  "| 工程 | 3 |",
  "",
  "MCP · library · stats — 12ms",
  "相关文件在 /Users/lazora/Documents/ShadowRoom/recordings/night-drive.wav",
  "详见 https://example.com/library",
].join("\n");

test("完整 think 块不念", () => {
  assert.equal(stripForSpeech("<think>内部推理</think>好的。"), "好的。");
});

test("多行 think 块不念", () => {
  assert.equal(stripForSpeech("<think>\n第一行\n第二行\n</think>结论。"), "结论。");
});

test("未闭合 think 只去掉标签，不吞正文", () => {
  assert.equal(stripForSpeech("<think>结论在屏幕上。"), "结论在屏幕上。");
});

test("thinking 变体同样被剥掉", () => {
  assert.equal(stripForSpeech("<thinking>想一想</thinking>好。"), "好。");
});

test("代码块整段不念（含未闭合）", () => {
  assert.equal(stripForSpeech("改好了。\n```python\nprint(1)\n```\n可以听。"), "改好了。\n可以听。");
  assert.equal(stripForSpeech("改好了。\n```js\nconsole.log(1)"), "改好了。");
});

test("行内代码只保留内容", () => {
  assert.equal(stripForSpeech("把 `kick` 加回来。"), "把 kick 加回来。");
});

test("表格行不念", () => {
  assert.equal(stripForSpeech("| 项目 | 数量 |\n| --- | --- |\n| 曲目 | 51 |\n共 51 首。"), "共 51 首。");
});

test("没有前导竖线的两列表格也不念", () => {
  assert.equal(stripForSpeech("曲目 | 51\n工程 | 3\n一共 51 首。"), "一共 51 首。");
});

test("URL 不念", () => {
  assert.equal(stripForSpeech("详见 https://example.com/a/b 就行。"), "详见 就行。");
});

test("URL 不吞掉句末中文标点", () => {
  assert.equal(stripForSpeech("看这个 https://example.com/x，然后继续。"), "看这个，然后继续。");
});

test("macOS 绝对路径不念", () => {
  assert.equal(stripForSpeech("文件在 /Users/lazora/Music/a.wav 里。"), "文件在 里。");
});

test("~ 路径不念", () => {
  assert.equal(stripForSpeech("放到 ~/Documents/ShadowRoom/exports 下。"), "放到 下。");
});

test("Windows 路径不念", () => {
  assert.equal(stripForSpeech("在 C:\\Users\\lazora\\Music 里。"), "在 里。");
});

test("MCP 工具行不念", () => {
  assert.equal(stripForSpeech("MCP · library · stats — 12ms\n共 51 首。"), "共 51 首。");
});

test("[server.tool] 行不念", () => {
  assert.equal(stripForSpeech("[library.stats] 51\n共 51 首。"), "共 51 首。");
});

test("✓ / ✗ 结果行不念", () => {
  assert.equal(stripForSpeech("✓ 完成\n共 51 首。"), "共 51 首。");
});

test("标题标记不念", () => {
  assert.equal(stripForSpeech("## 当前状态\n一切正常。"), "当前状态\n一切正常。");
});

test("列表符号去掉、内容保留", () => {
  assert.equal(stripForSpeech("- 曲目 51\n- 工程 3"), "曲目 51\n工程 3");
});

test("有序列表标记不念", () => {
  assert.equal(stripForSpeech("1. 曲目 51\n2. 工程 3"), "曲目 51\n工程 3");
});

test("引用符号不念", () => {
  assert.equal(stripForSpeech("> 共 51 首。"), "共 51 首。");
});

test("粗体与斜体标记不念", () => {
  assert.equal(stripForSpeech("**重点**是 _这个_。"), "重点是 这个。");
});

test("分隔线不念", () => {
  assert.equal(stripForSpeech("第一段。\n---\n第二段。"), "第一段。\n第二段。");
});

test("空输入得到空朗读", () => {
  assert.equal(stripForSpeech(""), "");
  assert.deepEqual(speechSentences(""), []);
});

test("只有代码或只有 think 时什么都不念", () => {
  assert.equal(speechText("```\ncode\n```"), "");
  assert.equal(speechText("<think>只有思考</think>"), "");
});

test("短答最多 2 句", () => {
  assert.deepEqual(speechSentences("一。二。三。"), ["一。", "二。"]);
});

test("短答最多 70 字", () => {
  const long = "这是一句二十个字左右的完整句子用来占掉预算。";
  const out = speechSentences(`${long}${long}${long}`);
  assert.ok(spokenLength(out.join("")) <= SPEECH_BUDGETS.brief.maxChars, `实际 ${spokenLength(out.join(""))} 字`);
});

test("展开最多 8 句", () => {
  const text = Array.from({ length: 10 }, (_, index) => `第${index + 1}句。`).join("");
  assert.equal(speechSentences(text, "detail").length, 8);
});

test("展开最多 360 字", () => {
  const sentence = `${"字".repeat(59)}。`;
  const out = speechSentences(sentence.repeat(8), "detail");
  assert.ok(spokenLength(out.join("")) <= SPEECH_BUDGETS.detail.maxChars);
});

test("短的展开回答不截断", () => {
  assert.deepEqual(speechSentences("一。二。", "detail"), ["一。", "二。"]);
});

test("超长首句退到逗号并补句号", () => {
  const text = `当前页面是曲目库，${"已经有五十多首曲目而且都分析完了".repeat(4)}，后面还有很多细节。`;
  const out = speechSentences(text);
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith("。"), out[0]);
  assert.ok(spokenLength(out[0]) <= SPEECH_BUDGETS.brief.maxChars, `实际 ${spokenLength(out[0])} 字`);
  assert.equal(out[0].includes("后面还有很多细节"), false, "截断之后的内容不许被念");
});

test("没有标点的长文本硬截断并以省略号收尾", () => {
  const out = speechSentences("字".repeat(300));
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith("……"), out[0]);
  assert.ok(spokenLength(out[0]) <= SPEECH_BUDGETS.brief.maxChars + 2);
});

test("用户贴的状态长回答：≤2 句 / ≤70 字 / 0 路径 / 0 表格 / 0 工具名", () => {
  const out = speechSentences(STATUS_FIXTURE);
  const spoken = out.join("");
  assert.ok(out.length <= 2, `句数 ${out.length}`);
  assert.ok(spokenLength(spoken) <= 70, `字数 ${spokenLength(spoken)}`);
  assert.equal(spoken.includes("/Users"), false);
  assert.equal(spoken.includes("|"), false);
  assert.equal(spoken.includes("MCP"), false);
  assert.equal(spoken.includes("https://"), false);
  assert.equal(spoken.includes("51 首曲都在库里"), true, "第一句应该是结论");
});

test("句子顺序保持不变", () => {
  assert.deepEqual(speechSentences("甲。乙。", "detail"), ["甲。", "乙。"]);
});

test("speechText 用换行连接句子", () => {
  assert.equal(speechText("甲。乙。"), "甲。\n乙。");
});

test("英文句号切分但不切小数", () => {
  assert.deepEqual(splitSpeechSentences("Volume is 0.85 now. Next line here."), [
    "Volume is 0.85 now.",
    "Next line here.",
  ]);
});

test("省略号不吞掉下一句", () => {
  assert.deepEqual(splitSpeechSentences("等一下……好了。"), ["等一下……", "好了。"]);
});

test("预算常量是产品口径", () => {
  assert.deepEqual(SPEECH_BUDGETS.brief, { maxSentences: 2, maxChars: 70 });
  assert.deepEqual(SPEECH_BUDGETS.detail, { maxSentences: 8, maxChars: 360 });
  assert.equal(SPEECH_TURN_MAX_MS, 90_000);
});

test("开头的纯垫话被剥掉，只剥一次", () => {
  assert.equal(stripForSpeech("好的，已经排好了。"), "已经排好了。");
  assert.equal(stripForSpeech("收到，加进去了。"), "加进去了。");
  assert.equal(stripForSpeech("当然可以。这是结果。"), "这是结果。");
  assert.equal(stripForSpeech("没问题，这就改。"), "这就改。");
});

test("垫话只剥开头，不误伤正文", () => {
  assert.equal(stripForSpeech("已经排好了。好的部分在第二段。"), "已经排好了。好的部分在第二段。");
  assert.equal(stripForSpeech("这个没问题。"), "这个没问题。");
});

test("剥掉 URL 后中文标点前不留空格", () => {
  assert.equal(stripForSpeech("看这个 https://example.com/x，然后继续。"), "看这个，然后继续。");
});

test("流式喂入：残句等更多 delta，flush 冲刷尾句", () => {
  // detail 模式：3 句都在预算内（brief 只放 2 句，那是另一条用例）。
  const feeder = createSpeechFeeder("detail");
  assert.deepEqual(feeder.push("第一句。第二"), ["第一句。"]);
  assert.deepEqual(feeder.push("句。第三"), ["第二句。"]);
  assert.deepEqual(feeder.flush(), ["第三"]);
  assert.deepEqual(feeder.stats(), { sentences: 3, chars: 10 });
});

test("流式喂入：没有边界的文本什么都不吐", () => {
  const feeder = createSpeechFeeder();
  assert.deepEqual(feeder.push("还没有说完"), []);
  assert.deepEqual(feeder.flush(), ["还没有说完"]);
});

test("流式喂入：预算是整轮的不是每段的", () => {
  const feeder = createSpeechFeeder();
  assert.deepEqual(feeder.push("一。"), ["一。"]);
  assert.deepEqual(feeder.push("二。"), ["二。"]);
  assert.deepEqual(feeder.push("三。"), [], "brief 整轮 2 句，第三句不再产出");
  assert.deepEqual(feeder.flush(), []);
});

test("流式喂入：跨 delta 的 URL 不会被念一半", () => {
  const feeder = createSpeechFeeder();
  assert.deepEqual(feeder.push("看这个 https://exa"), []);
  assert.deepEqual(feeder.push("mple.com/x，好。下一"), ["看这个，好。"]);
  assert.deepEqual(feeder.flush(), ["下一"]);
});

test("流式喂入：换行也是稳定边界，表格行被剥掉", () => {
  const feeder = createSpeechFeeder();
  assert.deepEqual(feeder.push("| 项目 | 数量 |\n共 51 首。"), ["共 51 首。"]);
});

test("流式喂入：detail 模式按 detail 预算累计", () => {
  const feeder = createSpeechFeeder("detail");
  const sentence = `${"字".repeat(59)}。`;
  const out = [];
  for (let index = 0; index < 10; index += 1) out.push(...feeder.push(sentence));
  out.push(...feeder.flush());
  assert.equal(out.length, 6, "detail 360 字 ÷ 60 字/句 = 6 句");
});
