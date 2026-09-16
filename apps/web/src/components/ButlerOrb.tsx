/**
 * 悬浮球 = 全 app 的管家（v2：canvas 粒子等离子球）。
 *
 * 规格（别自由发挥）：约 180 粒子斐波那契球面 + 慢自转 + 2D 透视投影（见 lib/orb-particles.ts）；
 * 空闲 72px、说话/干活 96px（transform 放大，不引起布局抖动）；中心径向渐变内核半径跟 RMS
 * 走（120ms 平滑）；你说=青蓝向外扩散、它说=青绿向内收、空闲 alpha≈0.15 慢漂移；干活外圈细
 * 进度弧 + 弧头发光点；面板毛玻璃、开合 180ms（scale 0.96→1 + 淡入）；拖动 4px 阈值、拖时 70%
 * 透明不展开；单 canvas 单 rAF、粒子 ≤240；prefers-reduced-motion → 静态发光。
 *
 * 麦克风走 `lib/mic.ts` 共享流（引用计数），**绝不自己 getUserMedia**。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { acquireMicrophone, onMicrophoneChange, releaseMicrophone } from "../lib/mic";
import { createVoiceMeter, SpeechLatch, type VoiceMeter } from "../lib/vad";
import { PALETTES, FluidOrb } from "../lib/orb-particles";

export type OrbMode = "idle" | "listening" | "speaking" | "thinking" | "working";

const POSITION_KEY = "shadowroom.orb.position";
const ORB_SIZE = 88;
const ACTIVE_SIZE = 112;
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
  /** 干活中的进度 0–1（外圈细进度弧走满=完成）。 */
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
  const [voiceActive, setVoiceActive] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const meterRef = useRef<VoiceMeter | null>(null);
  const latch = useRef(new SpeechLatch(1500));
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<FluidOrb | null>(null);
  const rafRef = useRef<number | null>(null);
  const levelRef = useRef(0);
  /** 内核半径的 120ms 平滑值。 */
  const smoothRef = useRef(0);
  const lastFrameRef = useRef(0);
  const reducedMotion = useRef(false);

  const value = draft ?? localDraft;
  const setValue = onDraftChange ?? setLocalDraft;
  const submit = onSubmit ?? (() => {
    window.dispatchEvent(new CustomEvent("shadowroom:orb-submit", { detail: { text: localDraft } }));
    setLocalDraft("");
  });

  // QA/测试覆盖口：localStorage.qa-orb-force 优先于自动判定（生产环境不会设这个键）。
  const forced = (typeof window !== "undefined" ? window.localStorage.getItem("qa-orb-force") : null) as OrbMode | null;
  const effectiveMode: OrbMode = mode ?? forced ?? (micOn && voiceActive ? "listening" : "idle");
  const showWorking = effectiveMode === "working";
  const paletteKey = effectiveMode === "listening" ? "listening" : effectiveMode === "speaking" ? "speaking" : "idle";
  const active = effectiveMode !== "idle";

  // prefers-reduced-motion：静态发光（不自转不漂移不呼吸）。
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reducedMotion.current = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // 共享麦克风：球开着听话才持有引用；流来了建表。
  useEffect(() => {
    if (!micOn) return;
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
        levelRef.current = 0;
      }
    });
    return () => {
      cancelled = true;
      meterRef.current?.stop();
      meterRef.current = null;
      detach?.();
      releaseMicrophone();
    };
  }, [micOn]);

  // 话音表 → levelRef + voiceActive（1.5s 静音回待机），采样率 30fps 足够（不占渲染帧）。
  useEffect(() => {
    if (!micOn) {
      setVoiceActive(false);
      return;
    }
    const id = window.setInterval(() => {
      const meter = meterRef.current;
      if (meter === null) return;
      const level = meter.level();
      levelRef.current = level;
      setVoiceActive(latch.current.update(level));
    }, 33);
    return () => window.clearInterval(id);
  }, [micOn]);

  // 单 canvas 单 rAF：粒子 + 内核 + 进度弧全在这一个循环里画。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const particles = particlesRef.current ?? (particlesRef.current = new FluidOrb());
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const render = (now: number) => {
      // P0 防线：canvas API 吃到 NaN/Infinity 会整帧抛错（createRadialGradient: non-finite），
      // rAF 循环里一抛就是**每帧都抛**，控制台瞬间刷屏、球永久黑掉。所有进 canvas 的值先过
      // Number.isFinite，洗不掉的输入把本帧降级成「保持上一帧」——宁可静止也不崩。
      if (!Number.isFinite(now)) return;
      const size = active ? ACTIVE_SIZE : ORB_SIZE;
      if (!Number.isFinite(size) || size <= 0) return;
      if (canvas.width !== size * dpr) {
        canvas.width = size * dpr;
        canvas.height = size * dpr;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 内核半径 120ms 平滑：向目标电平指数逼近。
      const target = Number.isFinite(levelRef.current) ? levelRef.current : 0;
      const dt = Math.min(64, Math.max(4, Number.isFinite(now - lastFrameRef.current) ? now - lastFrameRef.current : 16));
      lastFrameRef.current = now;
      smoothRef.current += (target - smoothRef.current) * Math.min(1, dt / 120);
      if (!Number.isFinite(smoothRef.current)) smoothRef.current = 0;
      const palette = PALETTES[paletteKey];
      particles.step(context, size, {
        level: smoothRef.current,
        palette,
        mode: paletteKey,
        motion: !reducedMotion.current,
        time: now / 1000,
      });
      // 中心径向渐变内核（白→色），半径跟平滑后的 RMS。non-finite 一律跳过（保上一帧）。
      const coreRadius = size * (0.10 + smoothRef.current * 0.16);
      if (Number.isFinite(coreRadius) && coreRadius > 0) {
        const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, coreRadius);
        const coreAlpha = Number.isFinite(0.5 + smoothRef.current * 0.4) ? 0.5 + smoothRef.current * 0.4 : 0.5;
        gradient.addColorStop(0, `rgba(255,255,255,${coreAlpha.toFixed(3)})`);
        gradient.addColorStop(1, `rgba(${palette.r},${palette.g},${palette.b},0)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(size / 2, size / 2, coreRadius, 0, Math.PI * 2);
        context.fill();
      }
      // 干活：外圈细进度弧 + 弧头发光点。
      if (showWorking && progress !== undefined && Number.isFinite(progress)) {
        const clamped = Math.max(0, Math.min(1, progress));
        context.lineWidth = 2;
        context.strokeStyle = "rgba(148,163,184,0.25)";
        context.beginPath();
        context.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
        context.stroke();
        const head = -Math.PI / 2 + clamped * Math.PI * 2;
        context.strokeStyle = "#38BDF8";
        context.beginPath();
        context.arc(size / 2, size / 2, size / 2 - 3, -Math.PI / 2, head);
        context.stroke();
        context.fillStyle = "#7DD3FC";
        context.shadowColor = "#38BDF8";
        context.shadowBlur = 8;
        context.beginPath();
        context.arc(size / 2 + Math.cos(head) * (size / 2 - 3), size / 2 + Math.sin(head) * (size / 2 - 3), 3, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
      }
      rafRef.current = window.requestAnimationFrame(render);
    };
    rafRef.current = window.requestAnimationFrame(render);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [active, paletteKey, showWorking, progress]);

  // 拖动：4px 阈值区分点/拖。
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
      setPosition((current) => ({
        x: Math.max(8, Math.min(window.innerWidth - ORB_SIZE - 8, drag.originX + dx)),
        y: Math.max(8, Math.min(window.innerHeight - ORB_SIZE - 8, drag.originY + dy)),
      }));
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

  useEffect(() => {
    if (dragging) return;
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  }, [position, dragging]);

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
        aria-label="管家悬浮球"
        title="管家：点一下展开，拖到别处不碍事"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setExpanded((open) => !open);
        }}
      >
        <canvas ref={canvasRef} className="sr-orb-canvas" aria-hidden="true" />
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
