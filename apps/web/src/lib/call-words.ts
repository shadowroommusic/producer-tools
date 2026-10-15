/**
 * 通话状态的说法只有一份（AGENTS.md 第一原则：同一件事只有一个真相）。
 *
 * 2026-10-16 用户点名的病：悬浮球旁边的字幕写「在听…/在想…」，对话栏通话条写「正在听/正在想」，
 * 同一秒钟两个地方两个词——用户看到的就是「这软件有病」。两处都从这里取词，改词只改这一处。
 *
 * F-1（ui-review-kimi §③）：五态。原来只有三态，识别空结果与断线都只能借 notice 一闪而过——
 * 用户看到的正是评审 P-1 的「矛盾同框」。unclear（说了话但没接住）与 offline（连接断了）
 * 各给一个真状态：进得去、有样子、退得出来（unclear 2.5s 自动回 listening；offline 等用户点球重连）。
 */
import type { CallState } from "./call-states.ts";

const WORDS: Record<CallState, string> = {
  listening: "在听…",
  thinking: "在想…",
  speaking: "在说…",
  unclear: "没听清…",
  offline: "断了…",
};

/** 状态词（球字幕、通话条状态位都用它）。 */
export const callWord = (state: CallState): string => WORDS[state];

/**
 * 「没听清」自动回聆听的时长：2.5s。
 *
 * 为什么不是「一闪而过的 notice」：用户刚说完一句话、系统没接住，如果提示只闪 200ms，
 * 他只会看到球突然安静下来，不知道该再说一遍还是系统坏了。2.5s = 够读完 9 个字 + 有余量重说，
 * 又不至于让人干等——中途点球（重说）或点「改成打字」都会立刻退出这个状态。
 */
export const UNCLEAR_HOLD_MS = 2500;

/**
 * 通话刚起时给第一次用的人看的一行用法：球是唯一的通话开关，先说清「怎么说话、怎么挂断」，
 * 第一句话开始就撤掉——提示不该在整通话里占着字幕位。
 */
export const CALL_START_HINT = "说就行 · 点球挂断";

/**
 * unclear / offline 两态的球字幕：状态词 + **行动指引**（两件事，所以不复用 WORDS 里那两行）。
 *
 * 为什么也放这里（MiniMax #393 ③ 的缺口）：字幕字面量散在 App.tsx 里时，改词表不会同步字幕、
 * 漂移也没有测试能发现；放进词表模块 = 「球上出现的通话文案只有一处」这条规矩才真的成立。
 * 两条都 ≤12 字（F-1 验收线），点球在 unclear=重说、offline=重连，Esc 永远是挂断。
 */
export const UNCLEAR_CAPTION = "没听清，再说一遍？";
export const OFFLINE_CAPTION = "断了 · 点球重连";
