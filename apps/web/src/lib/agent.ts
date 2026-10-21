/**
 * Client for the agent bridge (`tools/agent-bridge.mjs`), which drives `codex app-server` and
 * streams a turn's events as server-sent events.
 */
import type { ToolCall } from "../components/ToolCallRow";

export type AgentHealth = {
  ok: boolean;
  /** Changes when the bridge process restarts; provider bindings do not survive it. */
  instanceId?: string;
  threads: number;
  model?: string;
  userAgent?: string;
  cwd: string;
  sandbox: string;
  approval: string;
  plugins: string[];
  error?: string;
};

/** One entry of the core's model picker. */
export type AgentModel = {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: Array<{ effort: string; description: string }>;
  /**
   * effort 怎么送到服务端。内核模型原生走 openai-responses；自定义模型来自 ModelProfile.reasoning
   * 的声明。effort 的显示/发送规则（list / locked / hidden）由 lib/agent-settings 推导。
   */
  reasoningProtocol?: string;
};

/** A plugin (or skill) reference attached to the next message. */
export type Mention = { name: string; path: string; label: string };

/** One streamed event from a running turn. */
export type AgentEvent =
  | { type: "turn"; threadId: string; turnId: string }
  | { type: "delta"; text: string; itemId?: string; turnId?: string }
  | { type: "reasoning"; itemId?: string; turnId?: string; text: string }
  | { type: "item"; phase: string; item: AgentItem; turnId?: string }
  | { type: "usage"; turnId?: string; usage: TokenUsage }
  | { type: "approval"; approvalId: string; sessionId?: string; kind: string; title: string; detail?: string }
  | { type: "done"; turn?: { status?: string } }
  | { type: "error"; message: string };

/** Token accounting for one turn (`thread/tokenUsage/updated`). */
export type TokenUsage = {
  total?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
  last?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
};

/** A decision the core is waiting for. */
export type ApprovalDecision = "allow" | "allow_session" | "deny";

/** The subset of Codex thread items this UI cares about. */
export type AgentItem = {
  type: string;
  id: string;
  server?: string;
  tool?: string;
  status?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  durationMs?: number | null;
  command?: string | string[];
  aggregatedOutput?: string | null;
  text?: string;
  /** reasoning items carry both the model's summary and its full content */
  summary?: string[];
  content?: string[];
};

export async function fetchAgentHealth(): Promise<AgentHealth> {
  const response = await fetch("/api/agent/health");
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as AgentHealth;
}

export async function fetchModels(): Promise<AgentModel[]> {
  const response = await fetch("/api/agent/models");
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const data = (await response.json()) as { models: AgentModel[] };
  return data.models;
}

/** Ask the running turn to stop. */
export async function interruptTurn(sessionId: string): Promise<void> {
  await fetch("/api/agent/interrupt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

/** Answer one pending approval request. */
export async function answerApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
  const response = await fetch("/api/agent/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approvalId, decision }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

/** What `applyAgentSettings` returns: the settings the core confirmed via thread/settings/updated. */
export type ConfirmedThreadSettings = {
  model?: string;
  effort?: string;
  sandboxPolicy?: { type?: string };
  approvalPolicy?: string;
};

/**
 * Apply model / effort / access to a session's thread. Resolves only after the core echoes
 * `thread/settings/updated`; the caller persists exactly what came back, never what was wished.
 */
export async function applyAgentSettings(
  sessionId: string,
  settings: { model?: string; effort?: string; access: string },
  scope: "butler" | "studio" | "dj" | "library" = "butler",
): Promise<ConfirmedThreadSettings> {
  const response = await fetch("/api/agent/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      scope,
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.effort === undefined ? {} : { effort: settings.effort }),
      access: settings.access,
    }),
  });
  const data = (await response.json()) as { threadSettings?: ConfirmedThreadSettings; error?: string };
  if (!response.ok || data.threadSettings === undefined) {
    throw new Error(data.error ?? `${response.status} ${response.statusText}`);
  }
  return data.threadSettings;
}

/**
 * Send one message and stream the turn's events.
 *
 * Resolves when the stream ends (turn completed, failed, or the caller aborted).
 */
export async function sendTurn(
  sessionId: string,
  text: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  options: {
    model?: string;
    effort?: string;
    mentions?: Mention[];
    /** The single endpoint worker this turn belongs to. The bridge uses it for tool scoping/thread creation. */
    scope?: "butler" | "studio" | "dj" | "library";
    /** Object attribution carried into model turns and adapter-side media events. */
    eventContext?: { projectId?: string; setId?: string };
    /** Run this turn on a provider the user configured in Settings instead of the built-in one. */
    provider?: { id: string; label: string; baseUrl: string; credentialRef: string | null; endpointFormat: string };
    /** The session's confirmed settings; the bridge parameterizes thread/start and turn/start with them. */
    settings?: { model?: string; effort?: string; access: string };
  } = {},
): Promise<void> {
  const response = await fetch("/api/agent/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      text,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.settings === undefined
        ? {}
        : {
            settings: {
              ...(options.settings.model === undefined ? {} : { model: options.settings.model }),
              ...(options.settings.effort === undefined ? {} : { effort: options.settings.effort }),
              access: options.settings.access,
            },
          }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.eventContext?.projectId === undefined ? {} : { projectId: options.eventContext.projectId }),
      ...(options.eventContext?.setId === undefined ? {} : { setId: options.eventContext.setId }),
      ...(options.mentions === undefined || options.mentions.length === 0
        ? {}
        : { mentions: options.mentions.map(({ name, path }) => ({ name, path })) }),
    }),
    signal,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`agent bridge: ${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
      if (line !== undefined) {
        try {
          onEvent(JSON.parse(line.slice(6)) as AgentEvent);
        } catch {
          /* ignore malformed frames */
        }
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

/** Map one Codex item onto a tool row (MCP calls and shell commands both land in 轨迹). */
export function toolCallFromItem(item: AgentItem, phase: string, turnId?: string): ToolCall | null {
  const turn = typeof turnId === "string" && turnId !== "" ? { turnId } : {};
  if (item.type === "mcpToolCall") {
    const failed = item.status === "failed" || item.error != null;
    const running = phase === "started" || item.status === "inProgress";
    const durationMs = typeof item.durationMs === "number" ? item.durationMs : undefined;
    return {
      id: item.id,
      server: item.server ?? "mcp",
      name: item.tool ?? "tool",
      status: running ? "running" : failed ? "error" : "ok",
      ...(durationMs === undefined ? {} : { durationMs }),
      ...turn,
      summary: item.error?.message,
      detail: JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }, null, 2),
    };
  }
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command ?? "";
    const running = phase === "started" || item.status === "inProgress";
    return {
      id: item.id,
      server: "shell",
      name: "command",
      status: running ? "running" : item.status === "failed" ? "error" : "ok",
      ...turn,
      summary: command.slice(0, 80),
      detail: `${command}\n\n${item.aggregatedOutput ?? ""}`.slice(0, 4000),
    };
  }
  return null;
}
