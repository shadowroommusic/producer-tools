import type { ChatMessage } from "./sessions";

const RECOVERY_MAX_MESSAGES = 6;
const RECOVERY_MAX_CHARS = 1800;

/**
 * A bounded text-only tail for a newly created agent thread.
 *
 * Codex keeps the real history inside its thread. This is only used when the bridge/core/provider
 * restarted and that thread is gone: enough to continue the current conversation without replaying
 * a 120-message transcript, tool payloads or old reasoning.
 */
export function conversationRecoveryBlock(messages: ChatMessage[]): string[] {
  const rows: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0 && rows.length < RECOVERY_MAX_MESSAGES; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.text.trim();
    if (text === "") continue;
    const remaining = RECOVERY_MAX_CHARS - used;
    if (remaining <= 0) break;
    const clipped = text.length > remaining ? `${text.slice(0, Math.max(0, remaining - 1))}…` : text;
    rows.unshift(`${message.role === "user" ? "用户" : "助手"}：${clipped}`);
    used += clipped.length;
  }
  if (rows.length === 0) return [];
  return [
    "",
    "[recent_conversation]",
    "下面只是引擎/供应商重启后的有限连续性副本；若你的线程里已经有这些内容，以原线程为准，不要重复执行。",
    ...rows,
    "[/recent_conversation]",
  ];
}
