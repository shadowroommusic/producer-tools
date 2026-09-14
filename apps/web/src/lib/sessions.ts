/**
 * Session store: the transcript, the tool calls and the title, kept per session and persisted so a
 * reload does not throw the workbench away. The shape is the one the Codex core will write into
 * later — `messages` plus `calls` — so wiring the agent does not move any of this around.
 */
import type { ToolCall } from "../components/ToolCallRow";

export type ChatMessage =
  | { id: string; role: "user"; text: string; at: number }
  | { id: string; role: "assistant"; text: string; at: number }
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
