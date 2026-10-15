/**
 * 通话三个状态的说法只有一份（AGENTS.md 第一原则：同一件事只有一个真相）。
 *
 * 2026-10-16 用户点名的病：悬浮球旁边的字幕写「在听…/在想…」，对话栏通话条写「正在听/正在想」，
 * 同一秒钟两个地方两个词——用户看到的就是「这软件有病」。两处都从这里取词，改词只改这一处。
 */
export type CallState = "listening" | "thinking" | "speaking";

const WORDS: Record<CallState, string> = {
  listening: "在听…",
  thinking: "在想…",
  speaking: "在说…",
};

/** 状态词（球字幕、通话条状态位都用它）。 */
export const callWord = (state: CallState): string => WORDS[state];

/**
 * 通话刚起时给第一次用的人看的一行用法：球是唯一的通话开关，先说清「怎么说话、怎么挂断」，
 * 第一句话开始就撤掉——提示不该在整通话里占着字幕位。
 */
export const CALL_START_HINT = "说就行 · 点球挂断";
