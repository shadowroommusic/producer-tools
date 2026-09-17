/**
 * 悬浮球 v4：玻璃珠（react-three-fiber）+ 一行输入面板 + 点球即通话。
 *
 * 规格：空闲 56px / 说话 72px（transform，布局零抖动）；形态=细玻璃描边环 + 内部小光核 +
 * 2-3 颗极小高光绕行（OrbGlass.tsx，fresnel shader）；空闲整体 alpha≈0.35；面板**没有标题、
 * 没有听话开关**——只有一行输入 + 发送 + 一条细把手；文字说明只进 hover tooltip。
 * 交互：**点一下球立刻进入通话动态**（listening 动画 + 波形，麦克风经 lib/mic.ts 共享流），
 * 再点一下 / Esc 挂断回静态；面板输入照旧提交到当前工作区的会话（App 传 onSubmit）。
 *
 * 架构（用户强调）：干活的不是球——球只是管家/调度：它把话交给**当前工作区**的 agent 会话，
 * 工具执行、落轨、导出都是那条会话在做；球负责「知道全局 + 派活 + 汇报」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { acquireMicrophone, onMicrophoneChange, releaseMicrophone } from "../lib/mic";
import { createVoiceMeter, SpeechLatch, type VoiceMeter } from "../lib/vad";
import { GlassSphere } from "./OrbGlass";

export type OrbMode = "idle" | "listening" | "speaking" | "thinking" | "working";

const POSITION_KEY = "shadowroom.orb.position";
/**
 * 尺寸：用户两次否掉小尺寸（"这么小给谁看呢""太小"），定 **120px 空闲 / 150px 说话**——
 * 像 Siri 那颗球一样，一眼就能看见，但默认待机时仍比说话时淡、不抢视线。
 */
const ORB_SIZE = 120;
const ACTIVE_SIZE = 150;
const DRAG_THRESHOLD = 4;
const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

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

/** 视口边界夹取：窗口内留 12px 边距，不许只露半个球。 */
function clampToViewport(x: number, y: number): { x: number; y: number } {
  const margin = 12;
  return {
    x: Math.max(margin, Math.min(window.innerWidth - ORB_SIZE - margin, x)),
    y: Math.max(margin, Math.min(window.innerHeight - ORB_SIZE - margin, y)),
  };
}

/** 松手吸附：离任一边缘不足 48px 时贴到该边缘的 12px 边距处；再对受保护控件做保护性退避。 */
function snapToViewport(pos: { x: number; y: number }): { x: number; y: number } {
  const margin = 12;
  const snapDistance = 48;
  const maxX = window.innerWidth - ORB_SIZE - margin;
  const maxY = window.innerHeight - ORB_SIZE - margin;
  const next = clampToViewport(pos.x, pos.y);
  if (next.x - margin < snapDistance) next.x = margin;
  if (maxX - next.x < snapDistance) next.x = maxX;
  if (next.y - margin < snapDistance) next.y = margin;
  if (maxY - next.y < snapDistance) next.y = maxY;
  return avoidProtected(next);
}

/**
 * 保护性退避：吸附点若与受保护控件（新建会话/导入/导出/录音/缩放药丸/底部输入框/发送）相交，
 * 垂直退、退不动整行扫描，直到无相交——球永不停在控件上。
 */
function avoidProtected(next: { x: number; y: number }): { x: number; y: number } {
  const selectors = [
    ".sr-new-session",
    ".sr-studio-import",
    ".sr-studio-export",
    ".sr-studio-record",
    ".sr-transport-zoom button",
    "textarea",
    'button[title="发送"]',
  ];
  const protectedRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      protectedRects.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
    }
  }
  const hits = (point: { x: number; y: number }) =>
    protectedRects.some(
      (rect) => !(point.x > rect.x + rect.w || point.x + ORB_SIZE < rect.x || point.y > rect.y + rect.h || point.y + ORB_SIZE < rect.y),
    );
  if (!hits(next)) return next;
  let nearest = protectedRects[0];
  let bestDistance = Infinity;
  for (const rect of protectedRects) {
    const dx = rect.x + rect.w / 2 - (next.x + ORB_SIZE / 2);
    const dy = rect.y + rect.h / 2 - (next.y + ORB_SIZE / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = rect;
    }
  }
  const awayX = Math.sign(next.x + ORB_SIZE / 2 - (nearest.x + nearest.w / 2)) || -1;
  const awayY = Math.sign(next.y + ORB_SIZE / 2 - (nearest.y + nearest.h / 2)) || -1;
  let candidate = { ...next };
  // 垂直优先退让，顶住后整行水平扫描。
  for (let step = 0; step < 24; step += 1) {
    const moved = clampToViewport(candidate.x, candidate.y + awayY * 24);
    if (moved.y === candidate.y) break;
    candidate = moved;
    if (!hits(candidate)) return candidate;
  }
  const scanStart = awayX > 0 ? next.x : window.innerWidth - ORB_SIZE - 12;
  for (let step = 0; step < 24; step += 1) {
    const moved = clampToViewport(scanStart + (awayX > 0 ? step : -step) * 32, candidate.y);
    if (moved.x === candidate.x) continue;
    candidate = moved;
    if (!hits(candidate)) return candidate;
  }
  return candidate;
}

function defaultPosition(): { x: number; y: number } {
  // 屏幕中下方：水平居中、距底 140px——不压任何控件（用户定稿，两次迭代结论）。
  return { x: (window.innerWidth - ORB_SIZE) / 2, y: window.innerHeight - 140 - ORB_SIZE };
}

export function ButlerOrb({
  mode,
  progress,
  draft,
  onDraftChange,
  onSubmit,
  running = false,
}: {
  mode?: OrbMode;
  progress?: number;
  draft?: string;
  onDraftChange?: (next: string) => void;
  onSubmit?: () => void;
  running?: boolean;
}) {
  const [position, setPosition] = useState(() => loadPosition() ?? defaultPosition());
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [callOn, setCallOn] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const meterRef = useRef<VoiceMeter | null>(null);
  const latch = useRef(new SpeechLatch(1500));
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const reducedMotion = useRef(false);
  /** 点球即通话：面板/拖动之外，单击球的语义。 */
  const [voiceLevel, setVoiceLevel] = useState(0);

  const value = draft ?? localDraft;
  const setValue = onDraftChange ?? setLocalDraft;
  const submit = onSubmit ?? (() => {
    window.dispatchEvent(new CustomEvent("shadowroom:orb-submit", { detail: { text: localDraft } }));
    setLocalDraft("");
  });

  const forced = (typeof window !== "undefined" ? window.localStorage.getItem("qa-orb-force") : null) as OrbMode | null;
  const effectiveMode: OrbMode =
    mode ?? forced ?? (running ? "working" : callOn ? (voiceActive ? "listening" : "listening") : "idle");
  const active = effectiveMode !== "idle";

  // prefers-reduced-motion。
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reducedMotion.current = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // 点球即通话：通话开着才持有共享麦克风引用；RMS 喂给玻璃珠。
  useEffect(() => {
    if (!callOn) return;
    let cancelled = false;
    let detach: (() => void) | null = null;
    void acquireMicrophone()
      .then((stream) => {
        if (cancelled) return;
        const meter = createVoiceMeter(stream);
        meterRef.current = meter;
      })
      .catch(() => undefined);
    detach = onMicrophoneChange((stream) => {
      if (stream === null) {
        meterRef.current?.stop();
        meterRef.current = null;
      }
    });
    return () => {
      cancelled = true;
      meterRef.current?.stop();
      meterRef.current = null;
      detach?.();
      releaseMicrophone();
    };
  }, [callOn]);

  useEffect(() => {
    if (!callOn) {
      setVoiceActive(false);
      setVoiceLevel(0);
      return;
    }
    const id = window.setInterval(() => {
      const meter = meterRef.current;
      if (meter === null) return;
      const level = FINITE(meter.level(), 0);
      setVoiceLevel(level);
      setVoiceActive(latch.current.update(level));
    }, 33);
    return () => window.clearInterval(id);
  }, [callOn]);

  const toggleCall = useCallback(() => setCallOn((on) => !on), []);

  // Esc 挂断。
  useEffect(() => {
    if (!callOn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCallOn(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [callOn]);

  // 拖动。
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
      setPosition(clampToViewport(drag.originX + dx, drag.originY + dy));
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
    if (wasDrag) setPosition(snapToViewport(position));
    if (!wasDrag && !expanded) toggleCall();
    else if (!wasDrag) setExpanded(false);
  };

  useEffect(() => {
    if (dragging) return;
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  }, [position, dragging]);

  // 单 rAF：把 RMS 平滑进 level ref，交给 r3f 的 useFrame（玻璃珠渲染在 Canvas 内部循环）。
  const levelRef = useRef(0);
  useEffect(() => {
    let last = performance.now();
    const tick = (now: number) => {
      const dt = FINITE(now - last, 16) / 120;
      last = now;
      const target = effectiveMode === "listening" ? voiceLevel : 0;
      levelRef.current += (FINITE(target, 0) - levelRef.current) * Math.min(1, dt);
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, [effectiveMode, voiceLevel]);

  const size = active ? ACTIVE_SIZE : ORB_SIZE;
  const glassColour = effectiveMode === "speaking" ? "#34d399" : "#38bdf8";

  return (
    <div
      className={`sr-orb${expanded ? " sr-orb--expanded" : ""}${dragging ? " sr-orb--dragging" : ""}${active ? " sr-orb--active" : ""}`}
      data-mode={effectiveMode}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="sr-orb-ball"
        role="button"
        tabIndex={0}
        aria-label={callOn ? "结束通话" : "开始通话"}
        title={callOn ? "通话中：再点一下或按 Esc 挂断" : "点一下开始说话（共享麦克风）· 拖动移动 · 双击打开面板"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setExpanded((open) => !open);
        }}
      >
        {/* canvas 2D 的 Siri 式发光球（无 3D 依赖、不会 NaN 崩；尺寸 120/150）。 */}
        <GlassSphere size={size} mode={effectiveMode} level={levelRef.current} reducedMotion={reducedMotion.current} />
        {showProgress(effectiveMode, progress)}
      </div>

      {expanded && (
        <div className="sr-orb-panel" onPointerDown={(event) => event.stopPropagation()}>
          {/* 细把手：无文字 */}
          <span className="sr-orb-handle" aria-hidden="true" />
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

function showProgress(mode: OrbMode, progress: number | undefined) {
  if (mode !== "working" || progress === undefined || !Number.isFinite(progress)) return null;
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <svg className="sr-orb-progress" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(148,163,184,0.3)" strokeWidth="2" />
      <circle
        cx="50"
        cy="50"
        r="47"
        fill="none"
        stroke="#38bdf8"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${clamped * 2 * Math.PI * 47} ${2 * Math.PI * 47}`}
        transform="rotate(-90 50 50)"
      />
    </svg>
  );
}
