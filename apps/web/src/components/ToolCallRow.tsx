/**
 * One tool call, as a disclosure row.
 *
 * 收起态：`MCP · {server} · {tool}`（shell 行是 `SHELL · command` 片段），状态与耗时常驻——
 * 用户扫一眼就知道每次调用是哪一个 server 的哪个 tool、成没成、跑了多久。
 * 展开态：参数 / 结果 / 错误 三个分区，JSON 美化；超长结果默认截断、可继续展开。
 * The chrome follows DeepSeek Harness's tool rows (24px row, hover fill, chevron leading).
 */
import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconTool } from "./icons";
import { RouteIntentCard, type RouteIntent } from "./RouteIntentCard";
import { routeNeedsConfirmation } from "../lib/route-policy.ts";
import { parseButlerCommand } from "../lib/butler-command.ts";

export type ToolCall = {
  id: string;
  server: string;
  name: string;
  status: "running" | "ok" | "error";
  summary?: string;
  detail?: string;
  /** The core reports it for MCP calls; the app measures shell rows itself. */
  durationMs?: number;
  startedAt?: number;
  finishedAt?: number;
  turnId?: string;
  /** Request provenance for a completed butler route; stored so confirmation survives reloads. */
  routeSource?: {
    text: string;
    mentions: Array<{ name: string; path: string; label: string }>;
    sessionId: string;
  };
  /** Set the moment the user opens or dismisses the route card, so reload never re-offers it. */
  routeConsumed?: boolean;
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

/** 412ms → “412ms”；6230ms → “6.2s”；没有实测时长就不编。 */
function durationLabel(call: ToolCall): string | null {
  if (typeof call.durationMs !== "number" || Number.isNaN(call.durationMs)) return null;
  return call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`;
}

const RESULT_PREVIEW_CHARS = 1600;

/**
 * The detail field is one JSON envelope `{arguments, result, error}` for MCP rows (it stays the
 * single source of truth — the absorbers in App read it). The expanded body splits it into the
 * three sections a user actually reads; shell rows keep their plain text.
 */
function callSections(call: ToolCall): Array<{ label: string; text: string }> {
  if (call.server === "shell") {
    return [{ label: "命令与输出", text: readable(call.detail ?? "") }];
  }
  try {
    const parsed = JSON.parse(call.detail ?? "{}") as {
      arguments?: unknown;
      result?: unknown;
      error?: { message?: string } | string | null;
    };
    const sections: Array<{ label: string; text: string }> = [];
    if (parsed.arguments !== undefined && parsed.arguments !== null) {
      sections.push({ label: "参数", text: typeof parsed.arguments === "string" ? parsed.arguments : JSON.stringify(parsed.arguments, null, 2) });
    }
    if (parsed.result !== undefined && parsed.result !== null && parsed.result !== "") {
      const resultText =
        typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result, null, 2);
      if (resultText !== "{}" && resultText !== "null") sections.push({ label: "结果", text: resultText });
    }
    const errorText =
      typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (errorText !== undefined && errorText !== "") sections.push({ label: "错误", text: errorText });
    if (sections.length > 0) return sections;
  } catch {
    /* not JSON — fall through to the raw text below */
  }
  return [{ label: "详情", text: readable(call.detail ?? "") }];
}

function CallSection({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > RESULT_PREVIEW_CHARS;
  const shown = long && !expanded ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…` : text;
  return (
    <section className="sr-call-section" data-label={label}>
      <p className="sr-call-section-title sr-mono">{label}</p>
      <pre className="sr-call-detail sr-scroll">{shown}</pre>
      {long && (
        <button type="button" className="sr-call-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : `展开全部（${text.length.toLocaleString("en-US")} 字符）`}
        </button>
      )}
    </section>
  );
}

export function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.status === "error");
  const Chevron = open ? IconChevronDown : IconChevronRight;
  const parsedCommand = call.status === "ok" ? parseButlerCommand(call) : null;
  /**
   * Navigation is an effect, not an offer. Only a dispatch that needs authorization grows into a
   * confirmation card; a page switch stays a compact tool row after it has already happened.
   */
  const route = parsedCommand?.op === "dispatch" ? parsedCommand.route : null;
  const isShell = call.server === "shell";
  const duration = durationLabel(call);

  /**
   * The card is the *offer*, not history: once the user answered it (open or 稍后) the stored
   * `routeConsumed` flag flips and this row falls back to the normal tool row — one answer for
   * "was this route handled", shared with the page toast, so a reload never re-offers it.
   */
  if (route !== null && call.routeConsumed !== true && routeNeedsConfirmation(route)) {
    return (
      <RouteIntentCard
        route={route}
        onOpen={(next) => window.dispatchEvent(new CustomEvent("shadowroom:route-open", { detail: next }))}
        onDismiss={() =>
          window.dispatchEvent(new CustomEvent("shadowroom:route-consumed", { detail: route }))
        }
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
        <span className="sr-call-name">
          <span className="sr-call-kind sr-mono">{isShell ? "SHELL" : "MCP"}</span>
          {isShell ? <span className="sr-call-tool sr-mono">{call.summary ?? call.name}</span> : (
            <>
              <span className="sr-call-tool sr-mono">{call.server}</span>
              <span className="sr-call-dot" aria-hidden="true">·</span>
              <span className="sr-call-tool sr-mono">{call.name}</span>
            </>
          )}
        </span>
        {call.status === "error" && call.summary !== undefined && (
          <span className="sr-call-summary" title={call.summary}>
            {call.summary.length > 48 ? `${call.summary.slice(0, 48)}…` : call.summary}
          </span>
        )}
        <span className="sr-call-timing sr-mono">{duration ?? ""}</span>
        <span className="sr-call-state sr-mono">
          {call.status === "running" ? "运行中" : call.status === "error" ? "失败" : "完成"}
        </span>
      </button>
      {open && call.detail && (
        <div className="sr-call-body">
          {callSections(call).map((section) => (
            <CallSection key={section.label} label={section.label} text={section.text} />
          ))}
        </div>
      )}
    </div>
  );
}

export function parseRouteFromCall(call: ToolCall): RouteIntent | null {
  const command = parseButlerCommand(call);
  return command?.op === "dispatch" ? command.route : null;
}
