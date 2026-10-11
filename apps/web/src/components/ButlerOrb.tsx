/**
 * 悬浮球 v5：暗核光圈（方向 A，照 iOS 18 Siri）+ 一行输入面板 + 点球即通话。
 *
 * 形态与五态口径见 OrbGlass.tsx 头注；这里只管交互：**点一下球立刻进入通话动态**
 * （listening 动画 + 波形，麦克风经 lib/mic.ts 共享流），再点一下 / Esc 挂断回静态；
 * 面板**没有标题、没有听话开关**——只有一行输入 + 发送 + 一条细把手；文字说明只进 hover tooltip。
 *
 * 架构（用户强调）：干活的不是球——球只是管家/调度：它把话交给**当前工作区**的 agent 会话，
 * 工具执行、落轨、导出都是那条会话在做；球负责「知道全局 + 派活 + 汇报」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { acquireMicrophone, onMicrophoneChange, releaseMicrophone } from "../lib/mic";
import {
  ORB_SIZE,
  clampToViewport,
  defaultPosition,
  loadPosition,
  savePosition,
  snapToViewport,
  type Rect,
} from "../lib/orb-position.ts";
import { createVoiceMeter, SpeechLatch, type VoiceMeter } from "../lib/vad";
import { GlassSphere } from "./OrbGlass";

export type OrbMode = "idle" | "listening" | "speaking" | "thinking" | "working";

/**
 * 尺寸：用户巡检 2026-09-25（D2）指出 120px 空闲球压在推荐卡末行与 Studio 时间线中央、还吃掉
 * 点击——收敛为 **64px 空闲 / 80px 说话**：够一眼看见，又不再抢戏；历史定稿 120/150 作废。
 */
const ACTIVE_SIZE = 80;
/**
 * 通话开关的命中半径（球心到指针的距离）：可见球面直径 64px，命中半径再宽一圈（64px 直径 =
 * 44×44 最小点击目标），点"边上"也算；球面之外的方形角落（容器吃掉的区域）只拖不点。
 */
const HIT_RADIUS = 32;
const DRAG_THRESHOLD = 4;
const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

/** 受保护控件（吸附点不得压上去）：新建会话/导入/导出/录音/缩放药丸/底部输入框/发送。 */
const PROTECTED_SELECTORS = [
  ".sr-new-session",
  ".sr-studio-import",
  ".sr-studio-export",
  ".sr-studio-record",
  ".sr-transport-zoom button",
  "textarea",
  'button[title="发送"]',
];

function protectedRects(): Rect[] {
  const rects: Rect[] = [];
  for (const selector of PROTECTED_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      rects.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
    }
  }
  return rects;
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
  const [position, setPosition] = useState(
    () =>
      loadPosition(window.localStorage) ??
      defaultPosition({ width: window.innerWidth, height: window.innerHeight }, protectedRects()),
  );
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
  // 验收钩子（生产不触发）：qa-orb-progress 只在强制模式下顶替 progress，让「干活」弧可确定性截图。
  const qaProgress =
    forced !== null && typeof window !== "undefined"
      ? (() => {
          const raw = Number(window.localStorage.getItem("qa-orb-progress"));
          return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;
        })()
      : undefined;
  const effectiveProgress = progress ?? qaProgress;
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

  // 拖动 + 点球即通话。
  // 指针事件只挂在球面上，但**只有距球心 32px 内（64px 命中圆）的轻点才是点球**：球面外圈
  // 边角只拖不点，底下的内容不再被"看不见的手"按到（D2）。
  const hitBall = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2)) <= HIT_RADIUS
    );
  };
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
      setPosition(clampToViewport(drag.originX + dx, drag.originY + dy, { width: window.innerWidth, height: window.innerHeight }));
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if ((event.currentTarget as HTMLDivElement).hasPointerCapture(event.pointerId)) {
      (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
    }
    const wasDrag = drag?.moved === true;
    const wasClick = drag?.moved === false && hitBall(event);
    setDragging(false);
    if (wasDrag) setPosition(snapToViewport(position, { width: window.innerWidth, height: window.innerHeight }, protectedRects()));
    if (wasClick && !expanded) toggleCall();
    else if (wasClick) setExpanded(false);
  };

  useEffect(() => {
    if (dragging) return;
    savePosition(window.localStorage, position);
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

  return (
    <div
      className={`sr-orb${expanded ? " sr-orb--expanded" : ""}${dragging ? " sr-orb--dragging" : ""}${active ? " sr-orb--active" : ""}`}
      data-mode={effectiveMode}
      style={{ left: position.x, top: position.y, ["--sr-orb-size" as string]: `${size}px` }}
    >
      {/* 容器不吃事件（fixed 方块盖住内容就是 D2 的病根）；事件只挂在球面上，点空白穿透。 */}
      <div
        className="sr-orb-ball"
        role="button"
        tabIndex={0}
        aria-label={callOn ? "结束通话" : "开始通话"}
        title={callOn ? "通话中：再点一下或按 Esc 挂断" : "点一下开始说话（共享麦克风）· 拖动移动"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setExpanded((open) => !open);
        }}
      >
        {/* v5 暗核光圈：五态三通道 + 干活酸绿弧都画在这一层（无 3D 依赖、不会 NaN 崩）。 */}
        <GlassSphere size={size} mode={effectiveMode} level={levelRef.current} progress={effectiveProgress} reducedMotion={reducedMotion.current} />
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
              placeholder={running ? "正在干活…" : "说一句…"}
              aria-label="给悬浮球的一句话"
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
