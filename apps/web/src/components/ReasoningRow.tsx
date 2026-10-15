/**
 * Assistant reasoning, folded into a 24px row — the shape DeepSeek Harness gives a Think block.
 *
 * Collapsed, the row only says how long the model thought（「想了 N 秒」，进行中「在想…」）——
 * the English text never shows here, it lives in the expand body only（Kimi UI 评审 F-5）.
 * Streaming still sweeps across the row so "working" stays visible at a glance.
 */
import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconThink } from "./icons";
import { reasoningTitle } from "../lib/reasoning-title";

export function ReasoningRow({
  text,
  running,
  seconds,
}: {
  text: string;
  running: boolean;
  /** 想了的秒数——Transcript 从「下一条消息的 at」推导，推不出（无可推导的结束点）就不传。 */
  seconds?: number;
}) {
  const [expanded, setExpanded] = useState(false);
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
        <span className="sr-think-title">{reasoningTitle(running, seconds)}</span>
      </button>
      {expanded && <div className="sr-think-body">{text}</div>}
    </div>
  );
}
