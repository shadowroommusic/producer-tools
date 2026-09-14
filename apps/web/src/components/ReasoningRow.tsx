/**
 * Assistant reasoning, folded into a 24px row — the shape DeepSeek Harness gives a Think block.
 *
 * Collapsed, the row shows a one-line summary: while the block is still streaming it follows the
 * latest line (with a sweep across the row), and once it settles it shows the first line. Expanding
 * shows the whole text.
 */
import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconThink } from "./icons";

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf("\n");
  return newline === -1 ? visible : visible.slice(newline + 1);
}

export function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const summary = (running ? latestLine(text) : firstLine(text)).replaceAll("**", "");
  const Chevron = expanded ? IconChevronDown : IconChevronRight;

  return (
    <div className="sr-think" data-state={running ? "running" : "ok"} data-expanded={expanded || undefined}>
      <button
        type="button"
        className="sr-think-row"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="sr-think-chevron">
          <Chevron size={14} />
        </span>
        <span className="sr-think-glyph">
          <IconThink size={14} />
        </span>
        <span className="sr-think-title">思考</span>
        {!expanded && (
          <>
            <span className="sr-think-sep" aria-hidden="true" />
            <span className="sr-think-summary" data-follow-end={running || undefined}>
              <span className="sr-think-summary-text">{summary}</span>
            </span>
          </>
        )}
      </button>
      {expanded && <div className="sr-think-body">{text}</div>}
    </div>
  );
}
