/**
 * 思考行折叠标题只有一处说法（Kimi UI 评审 F-5，2026-10-16）。
 *
 * 病：折叠行直接漏模型思考的英文原句（「› 思考 The user wants a two-bar drum patter…」），
 * 消息尾再挂一行「32,091 tokens · 13s」——tokens 计数是开发者读数，不该在对话页。
 * 改法：折叠行只说「想了 N 秒」（进行中「在想…」，与通话状态词同一来源），英文原文只留在
 * 展开层；usage 行收进 title。
 *
 * N 不另存状态：思考块只记开始（at），结束取「下一条消息何时到」，在 Transcript 推导。
 */
import { callWord } from "./call-words.ts";

/**
 * 想了多少秒：下一条消息的 at − 思考块的 at。不足 1 秒按 1 秒——「想了 0 秒」不是人话，
 * 负差值（时钟异常）同样落回 1。
 */
export function reasoningSeconds(startedAt: number, endedAt: number): number {
  return Math.max(1, Math.round((endedAt - startedAt) / 1000));
}

/**
 * 折叠行标题。running → 「在想…」（直接取通话状态词表，「在想…」全产品一个来源）；
 * 想完但推不出结束时刻（环形缓冲把思考块裁成会话最后一条）→ 「想好了」，不编数字。
 */
export function reasoningTitle(running: boolean, seconds?: number): string {
  if (running) return callWord("thinking");
  if (seconds === undefined) return "想好了";
  return `想了 ${seconds} 秒`;
}
