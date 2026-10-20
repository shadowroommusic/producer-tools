/**
 * 屏幕上能看的东西，不等于耳朵里该听的东西。
 *
 * 一个回答里混着代码块、表格、绝对路径、URL、工具调用日志和三四段状态清单；全文念出来就是
 * 用户说的"死板地念"。这里把「朗读版」抽成一个**确定性**函数：先剥掉只对眼睛有意义的成分，
 * 再按句子和字数预算截断，超预算时退到分句标点，绝不念半句。
 *
 * 为什么不靠模型自觉：同一份提示词下模型仍会把清单念完；也不额外调一次"口语摘要"小模型——
 * 那会把首声延迟再推 1–2 秒。模型侧只负责"第一句先说结论"，长度由这里兜底（ADR 见 HANDOFF）。
 *
 * 纯函数、无 DOM 依赖。
 */

export type SpeechMode = "brief" | "detail";

export type SpeechBudget = {
  /** 最多念几句。 */
  maxSentences: number;
  /** 最多念多少个字（空白不计，汉字与拉丁字符都算 1）。 */
  maxChars: number;
};

/** 默认短答：2 句 / 70 字；用户说"详细说"才放宽到 8 句 / 360 字。 */
export const SPEECH_BUDGETS: Record<SpeechMode, SpeechBudget> = {
  brief: { maxSentences: 2, maxChars: 70 },
  detail: { maxSentences: 8, maxChars: 360 },
};

/** 单轮朗读的硬顶时长：预算正常时到不了，它是"模型失控"的安全带（App 用它掐表）。 */
export const SPEECH_TURN_MAX_MS = 90_000;

/** 句末标点（和 splitSentences 同一套，故意不含逗号）。 */
const SENTENCE_END = /[。！？!?…]/;
/**
 * 英文句号要单独判：`0.85`、`2.5 秒` 里的点不是句末。
 * 只有「后面是空白或结尾」且「前面不是数字」时才算。
 */
function isSentenceEnd(chars: string[], index: number): boolean {
  const char = chars[index];
  if (SENTENCE_END.test(char)) return true;
  if (char !== ".") return false;
  const next = chars[index + 1];
  const previous = chars[index - 1] ?? "";
  return (next === undefined || /\s/.test(next)) && !/\d/.test(previous);
}
/** 分句标点：整句超预算时，退到这里收尾，仍是完整的语调单位。 */
const CLAUSE_END = /[，,、；;：:]/;

/**
 * 只对眼睛有意义的整块内容：代码、think、表格、工具日志。
 *
 * 顺序有讲究：先整块丢（代码/think），再逐行丢（表格/工具行），最后才去标记符号——
 * 反过来的话，代码里的 `**` 会被当成 Markdown 强调先改掉。
 */
const THINK_BLOCK = /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?\s*>/gi;
/** 只有开标签、没有闭合：只去掉标签本身，不吞后面的正文（与 bridge 同口径）。 */
const THINK_TAG_ONLY = /<\/?think(?:ing)?\b[^>]*>/gi;
/** 未闭合的围栏也要整段丢掉：念代码比念错更糟。 */
const FENCE = /```[^\n]*\n?[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`([^`\n]*)`/g;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const URL = /https?:\/\/[^\s，。；、）)】」》]+/gi;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s，。；、）)】」》]*/g;
const UNIX_PATH = /(^|[\s（(【「])(?:~|\/Users|\/Volumes|\/private|\/tmp|\/var|\/opt|\/etc)\/[^\s，。；、）)】」》]*/g;
/** `MCP · library · stats`、`[library.stats]`、`✓ 180ms` 这类行是日志，不是回答。 */
const TOOL_LINE =
  /^[ \t]*(?:MCP\s*·.*|·.*·.*|[✓✗✔✘].*|\[[a-z0-9][a-z0-9_.-]*\.[a-z0-9_]+\].*|(?:工具|调用|tool|Tool)\s*[:：].*)$/gm;
/** 一行里出现竖线，基本就是 Markdown 表格（含没有前导竖线的 `曲目 | 51` 写法）。 */
const TABLE_LINE = /^[ \t]*\S.*\|.*$/gm;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
const BULLET = /^[ \t]{0,3}[-*+][ \t]+/gm;
const ORDERED = /^[ \t]{0,3}\d+[.)][ \t]+/gm;
const QUOTE = /^[ \t]{0,3}>[ \t]?/gm;
const DIVIDER = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm;
const BOLD = /\*\*([^*\n]+)\*\*/g;
const ITALIC = /(?<![\w*])[*_]([^*_\n]+)[*_](?![\w*])/g;
const STRIKE = /~~([^~\n]+)~~/g;
/**
 * 纯垫话开头：只剥文本最开头的「好的，/收到，/当然可以，」这类不带信息的客套，
 * 只剥一次、只剥开头，绝不按语义删正文（Codex 裁决 #492-1：状态报告不许语义过滤）。
 */
const LEADING_FILLER = /^(?:好的呀|好的|当然可以|没问题|收到|嗯嗯|嗯)[，,。.!！]\s*/;
/** 中文标点前多余空格（剥掉 URL/路径后的残留）：「看这个 ，然后」→「看这个，然后」。 */
const SPACE_BEFORE_PUNCT = /\s+([，。；、：？！…])/g;

/**
 * 把回答变成"可以念的文字"：剥掉只对屏幕有意义的部分，保留句子与顺序。
 * @param text - 转录里的原文（可能带 Markdown、think、日志）。
 * @returns 只剩可念内容的文本（段落之间仍是换行）。
 */
export function stripForSpeech(text: string): string {
  if (text === "") return "";
  const stripped = text
    .replace(FENCE, "")
    .replace(THINK_BLOCK, "")
    .replace(THINK_TAG_ONLY, "")
    .replace(TABLE_LINE, "")
    .replace(TOOL_LINE, "")
    .replace(URL, "")
    .replace(WINDOWS_PATH, "")
    .replace(UNIX_PATH, "$1")
    .replace(MARKDOWN_LINK, "$1")
    .replace(INLINE_CODE, "$1")
    .replace(HEADING, "")
    .replace(DIVIDER, "")
    .replace(BULLET, "")
    .replace(ORDERED, "")
    .replace(QUOTE, "")
    .replace(BOLD, "$1")
    .replace(STRIKE, "$1")
    .replace(ITALIC, "$1")
    .replace(SPACE_BEFORE_PUNCT, "$1");
  // 垫话只剥到"还剩东西可说"为止：整句都是垫话时宁可念出来，也不要让回答凭空消失。
  const unfilled = stripped.replace(LEADING_FILLER, "");
  const spoken = unfilled.trim() === "" ? stripped : unfilled;
  return spoken
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    // 段落之间只留一个换行：朗读时换行就是停顿，空行没有额外意义。
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}

/** 预算口径：空白不计，其余每个字符算 1（对中文偏严，宁可少念）。 */
export function spokenLength(text: string): number {
  return Array.from(text.replace(/\s+/g, "")).length;
}

/**
 * 按句子切开，标点留在前一句里。
 *
 * 换行也算边界：屏幕上的段落通常没有句号结尾，直接连读会把两段拼成一句。
 * 末尾没有标点的残句保留——它可能是整段话的最后一句；是不是"半句"由预算层处理。
 */
export function splitSpeechSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const chars = Array.from(trimmed);
    let start = 0;
    for (let index = 0; index < chars.length; index += 1) {
      if (!isSentenceEnd(chars, index)) continue;
      let end = index + 1;
      // `……`、`！？` 这类连续标点算同一个句末。
      while (end < chars.length && isSentenceEnd(chars, end)) end += 1;
      const piece = chars.slice(start, end).join("").trim();
      if (piece !== "") sentences.push(piece);
      start = end;
      index = end - 1;
    }
    const tail = chars.slice(start).join("").trim();
    if (tail !== "") sentences.push(tail);
  }
  return sentences;
}

/** 整句超预算时退到分句标点（逗号/顿号/分号），补句号收尾；没有分句标点返回 null。 */
function cutAtClause(sentence: string, maxChars: number): string | null {
  const chars = Array.from(sentence);
  let best = -1;
  let count = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (!/\s/.test(chars[index])) count += 1;
    if (count > maxChars) break;
    if (CLAUSE_END.test(chars[index])) best = index;
  }
  if (best < 0) return null;
  return `${chars.slice(0, best).join("").trim()}。`;
}

/**
 * 连分句标点都没有的长文本：按预算硬截，用省略号收尾。
 *
 * 这是"绝不念半句"的唯一例外——没有标点就没有任何合法边界，念到预算处收住，比整段沉默好。
 */
function clipHard(sentence: string, maxChars: number): string {
  const chars = Array.from(sentence);
  let out = "";
  let count = 0;
  for (const char of chars) {
    if (!/\s/.test(char)) count += 1;
    if (count > maxChars) break;
    out += char;
  }
  return `${out.trim()}……`;
}

/** 这一轮已经念掉的量（流式喂入时预算要跨 chunk 累计，不能每段重新给 70 字）。 */
export type SpeechSpent = { sentences: number; chars: number };

/**
 * 朗读版句子列表（队列逐句播放，句间由队列给自然停顿）。
 * @param text - 转录原文（或流式里新稳定下来的一段）。
 * @param mode - `brief` 默认短答；`detail` 用户明确要展开时用。
 * @param spent - 本轮已念句数/字数；预算按剩余量计算。
 */
export function speechSentences(text: string, mode: SpeechMode = "brief", spent: SpeechSpent = { sentences: 0, chars: 0 }): string[] {
  const cleaned = stripForSpeech(text);
  if (cleaned === "") return [];
  const budget = SPEECH_BUDGETS[mode];
  const remainingSentences = budget.maxSentences - spent.sentences;
  const remainingChars = budget.maxChars - spent.chars;
  if (remainingSentences <= 0 || remainingChars <= 0) return [];
  const sentences = splitSpeechSentences(cleaned);
  const spoken: string[] = [];
  let used = 0;
  for (const sentence of sentences) {
    if (spoken.length >= remainingSentences) break;
    const length = spokenLength(sentence);
    if (used + length <= remainingChars) {
      spoken.push(sentence);
      used += length;
      continue;
    }
    // 本轮一句都还没念：这一句本身超预算，退到分句或硬截，保证"有声音"且不念半句。
    if (spoken.length === 0 && used === 0 && spent.sentences === 0 && spent.chars === 0) {
      spoken.push(cutAtClause(sentence, remainingChars) ?? clipHard(sentence, remainingChars));
    }
    break;
  }
  return spoken;
}

/** 朗读版纯文本（句间用换行，交给一次性朗读的调用方）。 */
export function speechText(text: string, mode: SpeechMode = "brief"): string {
  return speechSentences(text, mode).join("\n");
}

/**
 * 流式喂入器：回答是一边生成一边到的，但朗读只能念"已经稳定"的部分。
 *
 * 两条规则（Codex 裁决 #492-8）：
 * - 只把**以句末标点/换行结束**的完整句交给队列，最后一个边界之后的残句等更多 delta 或 flush；
 * - 每个 delta 只追加、不重算历史——已消费的原文从 pending 里切走，句子边界一旦判定就不回头。
 *   （strip 发生在"稳定之后"：URL/表格跨 delta 时，残段还压在 pending 里，不会被念一半。）
 *
 * 预算跨 chunk 累计：brief 整轮就是 2 句/70 字，不是每段 70 字。
 */
export type SpeechFeeder = {
  /** 追加流式原文；返回新稳定下来的可念句子（通常 0 或 1 句）。 */
  push: (rawDelta: string) => string[];
  /** 回合结束：把剩余文本（可能没有句末标点）冲刷成最后的句子。 */
  flush: () => string[];
  /** 已产出的句数/字数（队列与硬顶用）。 */
  stats: () => SpeechSpent;
};

export function createSpeechFeeder(mode: SpeechMode = "brief"): SpeechFeeder {
  let pending = "";
  let sentences = 0;
  let chars = 0;
  /** 最后稳定边界的下一个位置（按码点索引）；没有稳定边界返回 -1。 */
  const lastBoundary = (charsArr: string[]): number => {
    let last = -1;
    for (let index = 0; index < charsArr.length; index += 1) {
      if (isSentenceEnd(charsArr, index) || charsArr[index] === "\n") last = index + 1;
    }
    return last;
  };
  const take = (text: string): string[] => {
    const out = speechSentences(text, mode, { sentences, chars });
    sentences += out.length;
    chars += out.reduce((count, sentence) => count + spokenLength(sentence), 0);
    return out;
  };
  return {
    push: (rawDelta) => {
      if (rawDelta === "") return [];
      pending += rawDelta;
      const charsArr = Array.from(pending);
      const boundary = lastBoundary(charsArr);
      if (boundary < 0) return [];
      const stable = charsArr.slice(0, boundary).join("");
      pending = charsArr.slice(boundary).join("");
      return take(stable);
    },
    flush: () => {
      const rest = pending;
      pending = "";
      return take(rest);
    },
    stats: () => ({ sentences, chars }),
  };
}
