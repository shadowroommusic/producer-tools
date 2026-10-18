/**
 * One tool call, as a disclosure row: name + status at rest, arguments/results on expand.
 * The chrome follows DeepSeek Harness's tool rows (24px row, hover fill, chevron leading).
 */
import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconTool } from "./icons";
import { RouteIntentCard, type RouteIntent, type RouteTarget } from "./RouteIntentCard";

export type ToolCall = {
  id: string;
  server: string;
  name: string;
  status: "running" | "ok" | "error";
  summary?: string;
  detail?: string;
};

/** Tool results arrive as one long JSON line; readers deserve indentation. */
function readable(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return detail;
    }
  }
  return detail;
}

export function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.status === "error");
  const [routeDismissed, setRouteDismissed] = useState(false);
  const Chevron = open ? IconChevronDown : IconChevronRight;
  const route = call.name === "route_intent" && call.status === "ok" ? parseRouteFromCall(call) : null;

  if (route !== null && !routeDismissed) {
    return (
      <RouteIntentCard
        route={route}
        onOpen={(next) => window.dispatchEvent(new CustomEvent("shadowroom:route-intent", { detail: next }))}
        onDismiss={() => setRouteDismissed(true)}
      />
    );
  }

  return (
    <div className="sr-call" data-state={call.status}>
      <button
        type="button"
        className="sr-call-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="sr-call-chevron">
          <Chevron size={14} />
        </span>
        <span className="sr-call-glyph">
          <IconTool size={14} />
        </span>
        <span className="sr-call-name">{call.name}</span>
        <span className="sr-call-server sr-mono">{call.server}</span>
        {call.summary && <span className="sr-call-summary">{call.summary}</span>}
        <span className="sr-call-state sr-mono">
          {call.status === "running" ? "运行中" : call.status === "error" ? "失败" : "完成"}
        </span>
      </button>
      {open && call.detail && <pre className="sr-call-detail sr-scroll">{readable(call.detail)}</pre>}
    </div>
  );
}

export function parseRouteFromCall(call: ToolCall): RouteIntent | null {
  try {
    const envelope = JSON.parse(call.detail ?? "{}") as Record<string, unknown>;
    let result = envelope.result;
    if (result !== null && typeof result === "object" && Array.isArray((result as { content?: unknown[] }).content)) {
      const text = (result as { content: Array<{ text?: unknown }> }).content
        .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
        .join("");
      if (text !== "") result = JSON.parse(text);
    }
    if (typeof result === "string") result = JSON.parse(result);
    if (result === null || typeof result !== "object") return null;
    const row = result as Record<string, unknown>;
    const valid = new Set<RouteTarget>(["studio", "dj", "library", "butler_direct", "ask_user"]);
    const target = String(row.target ?? "") as RouteTarget;
    if (!valid.has(target)) return null;
    return {
      target,
      actionSummary: String(row.action_summary ?? ""),
      confidence: typeof row.confidence === "number" ? row.confidence : 0,
      contextSatisfied: row.context_satisfied === true,
      missingContext: Array.isArray(row.missing_context)
        ? row.missing_context.map((entry) => String(entry)).filter(Boolean)
        : [],
      routeId: call.id,
    };
  } catch {
    return null;
  }
}
