/**
 * Conversation column: the scroll body and the composer seat pinned to the bottom. Empty sessions
 * centre the composer as the hero instead — the phase switch DeepSeek Harness's ConversationRoot
 * performs. No header chrome: the workbench is the transcript plus the input.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { Transcript } from "./Transcript";
import type { ToolCall } from "./ToolCallRow";
import type { ChatMessage } from "../lib/sessions";

/** Dragged transcript width preference (px), remembered per browser. */
const WIDTH_KEY = "shadowroom.chat.width";
/** Floor for the dragged width; matches the CSS clamp's lower bound. */
const CONTENT_MIN = 640;
/** Room the column must keep free so both handles stay reachable. */
const CONTENT_EDGE_BUDGET = 176;

function readWidthPreference(): number | null {
  const raw = window.localStorage.getItem(WIDTH_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * One transcript width handle: a 40px strip beside the column, dragging outwards widens the content
 * symmetrically (both sides write the one centred width), and the glow follows the pointer's Y.
 * DeepSeek Harness's ConversationRoot owns the same gesture.
 */
function WidthHandle({
  side,
  onStart,
  onWidth,
  onCommit,
}: {
  side: "left" | "right";
  onStart: () => number;
  onWidth: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const base = useRef(0);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null);
  const outwardWidth = useCallback(() => {
    const dx = latest.current - origin.current;
    return base.current + (side === "right" ? dx : -dx) * 2;
  }, [side]);

  const end = useCallback(() => {
    const active = capture.current;
    if (active === null) return;
    capture.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    setDragging(false);
  }, []);

  useEffect(() => end, [end]);

  return (
    <div
      className="sr-width-handle"
      data-side={side}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || capture.current !== null) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        capture.current = { element: event.currentTarget, id: event.pointerId };
        origin.current = event.clientX;
        latest.current = event.clientX;
        base.current = onStart();
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty("--sr-handle-y", `${event.clientY - box.top}px`);
        if (capture.current?.id !== event.pointerId) return;
        latest.current = event.clientX;
        frame.current ??= requestAnimationFrame(() => {
          frame.current = null;
          onWidth(outwardWidth());
        });
      }}
      onPointerUp={(event) => {
        if (capture.current?.id !== event.pointerId) return;
        latest.current = event.clientX;
        if (latest.current !== origin.current) onCommit(outwardWidth());
        end();
      }}
      onPointerCancel={(event) => {
        if (capture.current?.id === event.pointerId) end();
      }}
      onLostPointerCapture={(event) => {
        if (capture.current?.id === event.pointerId) end();
      }}
      onDoubleClick={() => {
        window.localStorage.removeItem(WIDTH_KEY);
        onWidth(0);
      }}
      title="拖动调整正文宽度，双击复位"
    />
  );
}

export function Conversation({
  messages,
  calls,
  running,
  quiet = false,
  composer,
  suggestions,
  onSuggestion,
}: {
  messages: ChatMessage[];
  calls: ToolCall[];
  running: boolean;
  quiet?: boolean;
  composer: ReactNode;
  suggestions: string[];
  onSuggestion: (text: string) => void;
}) {
  /** Empty session: the composer rides the column as the hero. */
  const heroPhase = messages.length === 0;

  // Transcript width: the adaptive clamp lives in CSS; a drag replaces it with a stored preference.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  const [userWidth, setUserWidth] = useState<number | null>(() => readWidthPreference());

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    let raf: number | null = null;
    const measure = () => setColumnWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  const maxWidth = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET);
  const clamp = useCallback(
    (width: number) => Math.min(maxWidth, Math.max(CONTENT_MIN, Math.round(width))),
    [maxWidth],
  );
  const contentWidth = userWidth === null ? undefined : `${clamp(userWidth)}px`;
  /** The rendered content width is the drag base — the CSS variable itself is unresolved. */
  const measureContent = useCallback(
    () => columnRef.current?.getBoundingClientRect().width || CONTENT_MIN,
    [],
  );

  return (
    <div
      ref={rootRef}
      className="sr-conversation"
      data-phase={heroPhase ? "hero" : "active"}
      data-hero={heroPhase || undefined}
      style={contentWidth === undefined ? undefined : ({ "--sr-content-width": contentWidth } as React.CSSProperties)}
    >
      <div className="sr-conversation-body">
        <WidthHandle
          side="left"
          onStart={measureContent}
          onWidth={(width) => setUserWidth(clamp(width))}
          onCommit={(width) => {
            const clamped = clamp(width);
            setUserWidth(clamped);
            window.localStorage.setItem(WIDTH_KEY, String(clamped));
          }}
        />
        <WidthHandle
          side="right"
          onStart={measureContent}
          onWidth={(width) => setUserWidth(clamp(width))}
          onCommit={(width) => {
            const clamped = clamp(width);
            setUserWidth(clamped);
            window.localStorage.setItem(WIDTH_KEY, String(clamped));
          }}
        />
        <div className="sr-conversation-scroll sr-scroll">
          <div className="sr-conversation-column" ref={columnRef}>
            {heroPhase ? (
              <>
                <section className="sr-hero">
                  <span className="sr-hero-mark">
                    <BrandMark height={46} strokeWidth={4} />
                  </span>
                  <h1 className="sr-hero-title">把灵感交给智能体</h1>
                </section>
                <div className="sr-hero-suggestions">
                  {suggestions.map((text) => (
                    <button
                      key={text}
                      type="button"
                      className="sr-suggestion"
                      onClick={() => onSuggestion(text)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                {composer}
              </>
            ) : (
              <Transcript messages={messages} calls={calls} running={running} quiet={quiet} />
            )}
          </div>
        </div>
        {!heroPhase && composer !== null && <div className="sr-composer-seat">{composer}</div>}
      </div>
    </div>
  );
}
