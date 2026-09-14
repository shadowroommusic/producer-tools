/**
 * One tool call, as a disclosure row: name + status at rest, arguments/results on expand.
 * The chrome follows DeepSeek Harness's tool rows (24px row, hover fill, chevron leading).
 */
import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconTool } from "./icons";

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
  const Chevron = open ? IconChevronDown : IconChevronRight;

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
