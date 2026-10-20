/**
 * 回合内的消息分段——assistant 文字为什么是「几个气泡」的唯一规则。
 *
 * 文字、reasoning、tool 按真实到达顺序进 messages；assistant 的每一段正文按事件的
 * itemId 归属（旧 core 没有 itemId 时按 turnId 退化成一段）。**末尾检查**：只有消息数组
 * 末尾就是这一段时 delta 才追加；否则（中间插进了 tool 行、reasoning 行，或乱序回放）
 * 开新气泡。所以 `textA → tool1 → textB → tool2 → textC` 渲染成 A、tool1、B、tool2、C
 * ——3 个 assistant 气泡、2 个 tool 行，顺序精确。
 */
import type { ChatMessage } from "./sessions";

/** delta 事件的分段键：itemId 优先，没有就退到 turnId（一段），再没有用回合序号兜底。 */
export function segmentKeyFor(itemId: string | undefined, turnId: string | undefined, fallback: string): string {
  if (itemId !== undefined && itemId !== "") return itemId;
  if (turnId !== undefined && turnId !== "") return `turn-${turnId}`;
  return fallback;
}

/**
 * Append one delta to its segment. Pure: returns the next messages array.
 * Same key + already last → grow it. Anything else → a new bubble (id collisions get a suffix,
 * which also covers a core that reuses an itemId after a tool row).
 */
export function appendAssistantDelta(
  messages: ChatMessage[],
  delta: string,
  key: string,
  at: number,
): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "assistant" && last.id === `a-${key}`) {
    return [...messages.slice(0, -1), { ...last, text: last.text + delta }];
  }
  let id = `a-${key}`;
  let n = 2;
  while (messages.some((message) => message.id === id)) id = `a-${key}-${n++}`;
  return [...messages, { id, role: "assistant", text: delta, at }];
}
