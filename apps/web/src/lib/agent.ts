/**
 * Client for the agent bridge (`tools/agent-bridge.mjs`), which drives `codex app-server` and
 * streams a turn's events as server-sent events.
 */
import type { ToolCall } from "../components/ToolCallRow";

export type AgentHealth = {
  ok: boolean;
  threads: number;
  model?: string;
  userAgent?: string;
  cwd: string;
  sandbox: string;
  approval: string;
  plugins: string[];
  error?: string;
};

/** One streamed event from a running turn. */
export type AgentEvent =
  | { type: "turn"; threadId: string; turnId: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "item"; phase: string; item: AgentItem }
  | { type: "done"; turn?: unknown }
  | { type: "error"; message: string };

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
};

export async function fetchAgentHealth(): Promise<AgentHealth> {
  const response = await fetch("/api/agent/health");
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as AgentHealth;
}

/** Ask the running turn to stop. */
export async function interruptTurn(sessionId: string): Promise<void> {
  await fetch("/api/agent/interrupt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
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
): Promise<void> {
  const response = await fetch("/api/agent/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
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
export function toolCallFromItem(item: AgentItem, phase: string): ToolCall | null {
  if (item.type === "mcpToolCall") {
    const failed = item.status === "failed" || item.error != null;
    const running = phase === "started" || item.status === "inProgress";
    return {
      id: item.id,
      server: item.server ?? "mcp",
      name: item.tool ?? "tool",
      status: running ? "running" : failed ? "error" : "ok",
      summary:
        item.error?.message ??
        (typeof item.durationMs === "number" ? `${item.durationMs}ms` : undefined),
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
      summary: command.slice(0, 80),
      detail: `${command}\n\n${item.aggregatedOutput ?? ""}`.slice(0, 4000),
    };
  }
  return null;
}
