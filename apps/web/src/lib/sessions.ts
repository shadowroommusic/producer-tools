/**
 * Session store: the transcript, the tool calls and the title, kept per session and persisted so a
 * reload does not throw the workbench away. The shape is the one the Codex core will write into
 * later — `messages` plus `calls` — so wiring the agent does not move any of this around.
 */
import type { ToolCall } from "../components/ToolCallRow";
import { normalizeAgentSettings, type AgentSettings } from "./agent-settings.ts";

export type ChatMessage =
  | { id: string; role: "user"; text: string; at: number; scope?: MessageScope }
  | { id: string; role: "assistant"; text: string; at: number; streaming?: boolean }
  | { id: string; role: "reasoning"; text: string; at: number; streaming?: boolean }
  | { id: string; role: "usage"; text: string; at: number; title?: string }
  | { id: string; role: "notice"; title: string; text: string; at: number }
  | { id: string; role: "tool"; callId: string; at: number };

export type Session = {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  /** The only objects that own history. A page worker is deliberately not split per project yet. */
  kind: SessionKind;
  scope: SessionScope;
  messages: ChatMessage[];
  calls: ToolCall[];
  /**
   * 会话自己的模型/思考深度/访问权限。未设置 = 继承全局默认快照（lib/agent-settings）；
   * 只存经 thread/settings/updated 确认过的值。
   */
  settings?: AgentSettings;
};

export type SessionKind = "butler" | "studio" | "dj" | "library";
export type WorkerSessionKind = Exclude<SessionKind, "butler">;

export type SessionScope = {
  workspaceId: SessionKind;
};

/** Per-message attribution. This is not the thread boundary; changing it never changes history. */
export type MessageScope = {
  workspaceId: SessionKind;
  /** Human label captured at send time, so history stays readable after renames. */
  label?: string;
  projectId?: string;
  setId?: string;
  revision?: string;
};

export type SessionStore = {
  sessions: Session[];
  /** Sidebar and `/conversation` only ever select butler topics. */
  activeButlerId?: string;
  /** Studio / DJ / library each have exactly one endpoint worker. */
  activeWorkerIds?: Partial<Record<WorkerSessionKind, string>>;
};

const STORAGE_KEY = "shadowroom.sessions.v1";

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const KIND_TITLES: Record<SessionKind, string> = {
  butler: "新对话",
  studio: "Studio 助手",
  dj: "DJ 助手",
  library: "曲目库助手",
};

const isKind = (value: unknown): value is SessionKind =>
  value === "butler" || value === "studio" || value === "dj" || value === "library";

/** A fresh endpoint session. Butler topics are user-created; worker sessions are page-owned. */
export function createSession(kind: SessionKind = "butler"): Session {
  const now = Date.now();
  return {
    id: newId(),
    title: KIND_TITLES[kind],
    createdAt: now,
    lastActiveAt: now,
    kind,
    scope: { workspaceId: kind },
    messages: [],
    calls: [],
  };
}

/** Load the store, tolerating anything unreadable in localStorage. */
export function loadSessions(): SessionStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { sessions: [] };
    const parsed = JSON.parse(raw) as SessionStore & { activeId?: string };
    if (!Array.isArray(parsed.sessions)) return { sessions: [] };
    const sessions = parsed.sessions.map((entry) => {
      const rawEntry = entry as Session & { activeId?: string };
      const kind = isKind(rawEntry.kind) ? rawEntry.kind : "butler";
      return {
        ...entry,
        kind,
        scope: rawEntry.scope?.workspaceId === kind ? rawEntry.scope : { workspaceId: kind },
        lastActiveAt:
          typeof rawEntry.lastActiveAt === "number" && Number.isFinite(rawEntry.lastActiveAt)
            ? rawEntry.lastActiveAt
            : rawEntry.createdAt,
        // 旧数据没有 settings 字段就保持没有——「未设置」表示继承全局默认（App 侧逐字段合并），
        // 存过的才补齐形状（access 落回默认），不重写已经存过的值。
        ...(rawEntry.settings === undefined ? {} : { settings: normalizeAgentSettings(rawEntry.settings) }),
        // 历史里被存成正文的一部分 <think>：一次性幂等搬进 reasoning 行（见 migrateSessionThink）。
        messages: migrateSessionThink(rawEntry.messages ?? []),
      };
    });
    const legacyActive = sessions.find((entry) => entry.id === parsed.activeId);
    const activeButlerId =
      parsed.activeButlerId ??
      (legacyActive?.kind === "butler" ? legacyActive.id : sessions.find((entry) => entry.kind === "butler")?.id);
    const activeWorkerIds = { ...(parsed.activeWorkerIds ?? {}) };
    if (legacyActive !== undefined && legacyActive.kind !== "butler") {
      activeWorkerIds[legacyActive.kind] = legacyActive.id;
    }
    return {
      sessions,
      ...(activeButlerId === undefined ? {} : { activeButlerId }),
      ...(Object.keys(activeWorkerIds).length === 0 ? {} : { activeWorkerIds }),
    };
  } catch {
    return { sessions: [] };
  }
}

/** Read the one session owned by a scope. */
export function sessionForKind(store: SessionStore, kind: SessionKind): Session | undefined {
  const id = kind === "butler" ? store.activeButlerId : store.activeWorkerIds?.[kind];
  return store.sessions.find((entry) => entry.id === id && entry.kind === kind);
}

/** Add a session and select it in its own scope without creating a second source of truth. */
export function selectSession(store: SessionStore, session: Session): SessionStore {
  const exists = store.sessions.some((entry) => entry.id === session.id);
  return {
    ...store,
    sessions: exists ? store.sessions.map((entry) => (entry.id === session.id ? session : entry)) : [session, ...store.sessions],
    ...(session.kind === "butler"
      ? { activeButlerId: session.id }
      : { activeWorkerIds: { ...(store.activeWorkerIds ?? {}), [session.kind]: session.id } }),
  };
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

// ---------------------------------------------------------------------------
// 历史 think 迁移（conversation-controls-20261020 阻断项的后半段）：
//
// bridge 现在在 delta 出口就把 <think> 剥成 reasoning 事件，但修复之前存进 localStorage 的
// 会话把思考原文留在了 assistant 正文里（真机截图实证）。加载时做一次幂等迁移：
// 思考内容搬成它前面的 reasoning 行、正文剥净；消息顺序不动、重复加载不重复插入。
//
// 剥离规则与 tools/think-stream.mjs 的 splitThinkBlocks 同源（闭合块成段、末尾未闭合算
// 思考）；这里是整串一次成型，不需要跨 chunk 状态机。两份实现各自被单测钉住。
// ---------------------------------------------------------------------------

function splitThinkOnce(text: string): { clean: string; thinks: string[] } {
  if (!text.includes("<think")) return { clean: text, thinks: [] };
  const thinks: string[] = [];
  let rest = text;
  let clean = "";
  for (;;) {
    const open = rest.indexOf("<think>");
    if (open === -1) {
      clean += rest;
      break;
    }
    clean += rest.slice(0, open);
    rest = rest.slice(open + "<think>".length);
    const close = rest.indexOf("</think>");
    if (close === -1) {
      thinks.push(rest);
      break;
    }
    thinks.push(rest.slice(0, close));
    rest = rest.slice(close + "</think>".length);
  }
  return { clean, thinks };
}

/** 幂等：think 已剥净的会话原样返回；同一条 assistant 的迁移行 id 稳定（`th-<id>-<n>`）。 */
export function migrateSessionThink(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((message) => message.role === "assistant" && message.text.includes("<think"))) return messages;
  const knownIds = new Set(messages.map((message) => message.id));
  const next: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.text.includes("<think")) {
      next.push(message);
      continue;
    }
    const { clean, thinks } = splitThinkOnce(message.text);
    thinks.forEach((think, index) => {
      const id = `th-${message.id}-${index}`;
      if (knownIds.has(id)) return; // 已迁过（老迁移行还在），不重复插入
      knownIds.add(id);
      next.push({ id, role: "reasoning", text: think, at: message.at });
    });
    next.push(clean === message.text ? message : { ...message, text: clean });
  }
  return next;
}
