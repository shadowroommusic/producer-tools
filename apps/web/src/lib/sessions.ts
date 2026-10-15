/**
 * Session store: the transcript, the tool calls and the title, kept per session and persisted so a
 * reload does not throw the workbench away. The shape is the one the Codex core will write into
 * later — `messages` plus `calls` — so wiring the agent does not move any of this around.
 */
import type { ToolCall } from "../components/ToolCallRow";

export type ChatMessage =
  | { id: string; role: "user"; text: string; at: number }
  | { id: string; role: "assistant"; text: string; at: number; streaming?: boolean }
  | { id: string; role: "reasoning"; text: string; at: number; streaming?: boolean }
  | { id: string; role: "usage"; text: string; at: number }
  | { id: string; role: "notice"; title: string; text: string; at: number }
  | { id: string; role: "tool"; callId: string; at: number };

export type Session = {
  id: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
  calls: ToolCall[];
};

export type SessionStore = {
  sessions: Session[];
  activeId?: string;
};

const STORAGE_KEY = "shadowroom.sessions.v1";

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** A fresh, empty session (the hero state). */
export function createSession(): Session {
  return { id: newId(), title: "新会话", createdAt: Date.now(), messages: [], calls: [] };
}

/** Load the store, tolerating anything unreadable in localStorage. */
export function loadSessions(): SessionStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { sessions: [] };
    const parsed = JSON.parse(raw) as SessionStore;
    if (!Array.isArray(parsed.sessions)) return { sessions: [] };
    return { sessions: parsed.sessions, activeId: parsed.activeId };
  } catch {
    return { sessions: [] };
  }
}

/** Persist the store; a full quota simply means this browser keeps the session in memory only. */
export function saveSessions(store: SessionStore): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage full or blocked — in-memory state still works */
  }
}

/** Session title = the first line of the first user message, trimmed to something sidebar-sized. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const clean = line.replace(/\s+/g, " ");
  if (clean === "") return "新会话";
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}

// ---------------------------------------------------------------------------
// Ring buffer（S4 巡检遗留："连续通话 5 分钟内存 <30MB / 忘掉刚才"）：
//
// 通话一轮 = 1 条用户消息 + 1 条助手消息 + 1 个 tool 消息 + 1 个 ToolCall（detail 是
// 工具结果的完整 JSON，实测单条可达数 KB 到数十 KB）。没有上限时，长通话把整个会话
// 写进 localStorage（约 5MB 配额，超了 setItem 静默失败）并让内存随通话时长线性涨。
// 这里在唯一入口（patchSession → capSession）做环形缓冲：只留最近 N 条，老条目连同
// 它们的工具 detail 截断（旧调用完成后连渲染都退回纯文本，截断不损失可用信息）。
// ---------------------------------------------------------------------------

/** 会话里保留的最近消息条数（通话一轮约 3 条 → ≈40 轮）。 */
export const MAX_MESSAGES = 120;
/** 保留的最近工具调用个数。 */
export const MAX_CALLS = 60;
/** 旧条目的 detail 上限（字符）：超出只留开头并戳明截断。 */
export const MAX_DETAIL_CHARS = 8192;

const TRUNCATED_SUFFIX = "\n…（旧条目已截断——环形缓冲只保留最近内容）";

/**
 * 环形缓冲：把会话裁到上限内。返回原对象（无变化）或新对象（有裁剪）。
 * 运行中的调用不截断 detail——完成吸收（absorbToolResult）读的是事件对象，但运行时
 * 截断会让「轨迹」面板显示半截运行态，没必要。
 */
export function capSession(session: Session): Session {
  let messages = session.messages;
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);

  const needsCountTrim = session.calls.length > MAX_CALLS;
  const needsDetailTrim = session.calls.some(
    (call) => call.status !== "running" && (call.detail?.length ?? 0) > MAX_DETAIL_CHARS,
  );
  let calls = session.calls;
  if (needsCountTrim || needsDetailTrim) {
    calls = (needsCountTrim ? calls.slice(-MAX_CALLS) : calls).map((call) =>
      call.status !== "running" && (call.detail?.length ?? 0) > MAX_DETAIL_CHARS
        ? { ...call, detail: `${call.detail?.slice(0, MAX_DETAIL_CHARS)}${TRUNCATED_SUFFIX}` }
        : call,
    );
  }

  if (messages === session.messages && calls === session.calls) return session;
  return { ...session, messages, calls };
}

/** Relative time for the sidebar rows. */
export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
