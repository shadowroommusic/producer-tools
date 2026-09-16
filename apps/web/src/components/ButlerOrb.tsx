/**
 * 悬浮球 = 全 app 的管家（任务 13，ZCode 半边）。
 *
 * 契约要点：
 * - 三层：内核（RMS 驱动缩放+高光）、能量环（转速跟话音量）、外圈细刻度环（空闲时缓慢呼吸）。
 *   空闲要极淡、几乎像玻璃；用户说话才亮。
 * - 双色语义：你说=青蓝（波形向上扩散）、它说=青绿（波形向下收敛）；思考中=两道反向流动细弧；
 *   干活中=外圈变进度刻度（走满=任务完成）。亮度变化 120–200ms 缓动，不弹跳。
 * - 常驻右下、可拖动并记住位置、拖动时半透明；点一下展开成小面板（语音 + 一行文字输入）。
 * - 麦克风走 `lib/mic.ts` 的共享流（引用计数），**绝不自己 getUserMedia**。
 * - 静音 1.5 秒回待机亮度（`SpeechLatch`）。
 *
 * 会话接线（App.tsx 归 Codex）：传入 `draft`/`onDraftChange`/`onSubmit` 时输入与右侧对话栏
 * 同一条会话；没传时本地草稿 + 一个 window 事件（`shadowroom:orb-submit`），并提示未接线。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { acquireMicrophone, onMicrophoneChange, releaseMicrophone } from "../lib/mic";
import { createVoiceMeter, SpeechLatch, type VoiceMeter } from "../lib/vad";

export type OrbMode = "idle" | "listening" | "speaking" | "thinking" | "working";

const POSITION_KEY = "shadowroom.orb.position";
const ORB_SIZE = 56;
/** 拖动判定阈值：指针移动超过这个像素算拖，否则算点按（展开/收起）。 */
const DRAG_THRESHOLD = 4;

function loadPosition(): { x: number; y: number } | null {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { x: number; y: number };
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function ButlerOrb({
  mode,
  progress,
  draft,
  onDraftChange,
  onSubmit,
  running = false,
}: {
  /** 外部指定的模式（通话/智能体在跑时由 App 传）；不传时按话音自动：说话=listening，安静=idle。 */
  mode?: OrbMode;
  /** 干活中的进度 0–1（外圈刻度走满=完成）。 */
  progress?: number;
  draft?: string;
  onDraftChange?: (next: string) => void;
  onSubmit?: () => void;
  running?: boolean;
}) {
  const [position, setPosition] = useState(() => loadPosition() ?? defaultPosition());
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [listening, setListening] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const meterRef = useRef<VoiceMeter | null>(null);
  const latch = useRef(new SpeechLatch(1500));
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  const value = draft ?? localDraft;
  const setValue = onDraftChange ?? setLocalDraft;
  const submit = onSubmit ?? (() => {
    window.dispatchEvent(new CustomEvent("shadowroom:orb-submit", { detail: { text: localDraft } }));
    setLocalDraft("");
  });

  // 位置写回 localStorage（拖动结束时一次）。
  const move = useCallback((x: number, y: number) => {
    const clamped = {
      x: Math.max(8, Math.min(window.innerWidth - ORB_SIZE - 8, x)),
      y: Math.max(8, Math.min(window.innerHeight - ORB_SIZE - 8, y)),
    };
    setPosition(clamped);
    return clamped;
  }, []);

  useEffect(() => {
    const save = (next: { x: number; y: number }) => window.localStorage.setItem(POSITION_KEY, JSON.stringify(next));
    if (!dragging) save(position);
  }, [position, dragging]);

  // 共享麦克风：球开着就持有一个引用；流来了建表，走了拆表。
  useEffect(() => {
    if (!micOn) return;
    let cancelled = false;
    let detach: (() => void) | null = null;
    void acquireMicrophone()
      .then((stream) => {
        if (cancelled) return;
        const meter = createVoiceMeter(stream);
        meterRef.current = meter;
        const tick = () => {
          if (meterRef.current !== meter) return;
          const current = meter.level();
          setLevel(current);
          setListening(latch.current.update(current));
          window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
      })
      .catch(() => undefined);
    detach = onMicrophoneChange((stream) => {
      if (stream === null) setLevel(0);
    });
    return () => {
      cancelled = true;
      meterRef.current?.stop();
      meterRef.current = null;
      detach?.();
      releaseMicrophone();
    };
  }, [micOn]);

  // 拖动：指针事件 + 捕获，4px 阈值区分拖/点。
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) setDragging(true);
    if (drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      drag.moved = true;
      move(drag.originX + dx, drag.originY + dy);
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if ((event.currentTarget as HTMLDivElement).hasPointerCapture(event.pointerId)) {
      (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
    }
    const wasDrag = drag?.moved === true;
    setDragging(false);
    if (!wasDrag) setExpanded((open) => !open);
  };

  const effectiveMode: OrbMode = mode ?? (micOn && listening ? "listening" : micOn ? "idle-awake" as OrbMode : "idle");
  const showSpeaking = effectiveMode === "speaking";
  const showListening = effectiveMode === "listening";
  const showThinking = effectiveMode === "thinking";
  const showWorking = effectiveMode === "working";
  const awake = effectiveMode !== "idle";
  /** 能量环转速跟话音量。 */
  const energySeconds = showListening || showSpeaking ? Math.max(1.2, 4 - level * 3) : 0;

  return (
    <div
      className={`sr-orb${expanded ? " sr-orb--expanded" : ""}${dragging ? " sr-orb--dragging" : ""}`}
      data-mode={effectiveMode}
      data-awake={awake || undefined}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="sr-orb-ball"
        role="button"
        tabIndex={0}
        aria-label="管家悬浮球"
        title="管家：点一下展开，拖到别处不碍事"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setExpanded((open) => !open);
        }}
        style={{ ["--sr-orb-level" as string]: showListening || showSpeaking ? level.toFixed(3) : "0" }}
      >
        {/* 外圈细刻度环：空闲呼吸；干活中变进度刻度 */}
        <span
          className="sr-orb-ring"
          style={showWorking && progress !== undefined ? { ["--sr-orb-progress" as string]: `${Math.round(progress * 100)}%` } : undefined}
          data-progress={showWorking && progress !== undefined ? true : undefined}
          aria-hidden="true"
        />
        {/* 能量环：转速跟话音量 */}
        <span
          className="sr-orb-energy"
          data-listening={showListening || undefined}
          data-speaking={showSpeaking || undefined}
          style={energySeconds > 0 ? { animationDuration: `${energySeconds.toFixed(2)}s` } : undefined}
          aria-hidden="true"
        />
        {/* 思考：两道反向流动细弧 */}
        {showThinking && (
          <>
            <span className="sr-orb-arc sr-orb-arc--a" aria-hidden="true" />
            <span className="sr-orb-arc sr-orb-arc--b" aria-hidden="true" />
          </>
        )}
        {/* 内核：RMS 驱动缩放 + 高光 */}
        <span className="sr-orb-core" aria-hidden="true">
          <span className="sr-orb-gloss" />
        </span>
        {/* 双色波形：你说=向上扩散（青蓝），它说=向下收敛（青绿） */}
        <span className="sr-orb-wave" data-up={showListening || undefined} data-down={showSpeaking || undefined} aria-hidden="true">
          {[0, 1, 2, 3, 4].map((bar) => (
            <i key={bar} style={{ ["--sr-orb-bar" as string]: String(bar) }} />
          ))}
        </span>
      </div>

      {expanded && (
        <div className="sr-orb-panel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="sr-orb-panel-head">
            <span className="sr-orb-title">管家</span>
            <button
              type="button"
              className="sr-btn"
              data-on={micOn || undefined}
              aria-pressed={micOn}
              onClick={() => setMicOn((on) => !on)}
              title="开/关话音监听（共享麦克风：通话和录音不受影响）"
            >
              {micOn ? "听话中" : "听话"}
            </button>
          </div>
          <form
            className="sr-orb-input"
            onSubmit={(event) => {
              event.preventDefault();
              if (value.trim() === "" || running) return;
              submit();
              setValue("");
            }}
          >
            <input
              className="sr-input"
              value={value}
              placeholder={running ? "管家正在干活…" : "跟管家说一句…"}
              aria-label="跟管家说一句话"
              onChange={(event) => setValue(event.target.value)}
            />
            <button type="submit" className="sr-btn sr-btn--accent" disabled={value.trim() === "" || running}>
              发送
            </button>
          </form>
          {onSubmit === undefined && (
            <p className="sr-orb-hint sr-mono">还没接会话（App 挂载时传 onSubmit 即同右侧对话栏）</p>
          )}
        </div>
      )}
    </div>
  );
}

/** 默认落脚点：右下角，离边 24px——绝不遮导入/导出/BPM（它们在顶部走带区）。 */
function defaultPosition(): { x: number; y: number } {
  return { x: window.innerWidth - ORB_SIZE - 24, y: window.innerHeight - ORB_SIZE - 24 };
}
