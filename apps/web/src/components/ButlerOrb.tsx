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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { acquireMicrophone, onMicrophoneChange, releaseMicrophone } from "../lib/mic";
import {
  ORB_SIZE,
  avoidProtected,
  clampToViewport,
  defaultPosition,
  loadPosition,
  savePosition,
  snapToViewport,
  type Rect,
} from "../lib/orb-position.ts";
import { callOrbMode, type OrbVisualMode } from "../lib/orb-states.ts";
import type { CallState } from "../lib/call-states.ts";
import { createVoiceMeter, SpeechLatch, type VoiceMeter } from "../lib/vad";
import { GlassSphere } from "./OrbGlass";

/** 球的外观态：单一来源在 lib/orb-states.ts（七态），这里只做别名，别再抄一份字面量。 */
export type OrbMode = OrbVisualMode;

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

/**
 * 受保护控件（吸附点不得压上去）：新建会话/导入/导出/录音/缩放药丸/底部输入框/发送/左栏版本行。
 * 版本行是 Kimi UI 评审 P-8 的实证：浅色主题下球驻左下会盖住「AGPL-3.0 · v0.0.0」。
 */
const PROTECTED_SELECTORS = [
  ".sr-new-session",
  ".sr-studio-import",
  ".sr-studio-export",
  ".sr-studio-record",
  ".sr-transport-zoom button",
  ".sr-foot-version",
  ".sr-settings-pane input",
  ".sr-settings-pane select",
  ".sr-settings-pane textarea",
  ".sr-settings-pane button",
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
  voiceMode,
  voiceState = "listening",
  voiceLevel,
  onCallToggle,
  onCallEnd,
  caption,
  captionAction,
}: {
  mode?: OrbMode;
  progress?: number;
  draft?: string;
  onDraftChange?: (next: string) => void;
  onSubmit?: () => void;
  running?: boolean;
  /** 真通话（App.tsx 的通话状态机）开着没有——球的姿态随它走，不再自己骗自己。 */
  voiceMode?: boolean;
  /** 通话五态（类型住 lib/call-states，词与字幕住 lib/call-words——球只消费态，不碰词）。 */
  voiceState?: CallState;
  /** App 侧实时电平（0–1）：说话时球的呼吸跟着真麦克风，不另开一路采集。 */
  voiceLevel?: () => number;
  /** 有了它，点球 = 开始/挂断真通话；没有则退回本地电平演示（旧行为）。 */
  onCallToggle?: () => void;
  /**
   * Esc 的挂断出口（F-1 之后点球本身是「按当前态」的动作：没听清=重说、断了=重连）。
   * 键盘的约定不能跟着状态漂——Esc 永远挂断，与工具提示、AGENTS.md 的说法一致。
   */
  onCallEnd?: () => void;
  /** 球旁的一行字幕：在听（识别中的话）/ 在想（等待）/ 在说（正在念的那句）。 */
  caption?: string;
  /**
   * 字幕里的出路（F-1 / deepseek O-3）：unclear 态给第二条路「改成打字」——
   * 非语音 fallback 是 W3C 硬要求，不是加分项。只在有 caption 时出现，最多一颗。
   */
  captionAction?: { label: string; onAction: () => void };
}) {
  const [position, setPosition] = useState(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const controls = protectedRects();
    const stored = loadPosition(window.localStorage);
    return stored === null ? defaultPosition(viewport, controls) : avoidProtected(stored, controls, viewport);
  });
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** 本地演示通话（没有 onCallToggle 时的旧行为：只有麦克风电平，不接会话）。 */
  const [localCallOn, setLocalCallOn] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const meterRef = useRef<VoiceMeter | null>(null);
  const latch = useRef(new SpeechLatch(1500));
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const reducedMotion = useRef(false);
  /**
   * 字幕的贴边处理（2026-10-16 实测：球吸附右边缘时字幕越界 21px、吸附上边缘时整条字幕跑到视口外
   * 21px——用户说的「非常不清晰」有一半是字幕根本没在屏幕里）。贴着球量一次，越界就横移、上下没地方就
   * 翻到球下面；**只有算出的值真变了才 setState**——字幕跟着识别结果高频更新，别每次渲染都写状态。
   */
  const captionRef = useRef<HTMLDivElement | null>(null);
  const captionGeomRef = useRef({ shift: 0, placement: "above" as "above" | "below" });
  const [captionGeom, setCaptionGeom] = useState(captionGeomRef.current);
  const [viewportTick, setViewportTick] = useState(0);
  /** 点球即通话：面板/拖动之外，单击球的语义。 */
  /** 本地模式下球自己的麦克风电平（外部通话时改用 App 的 voiceLevel getter）。 */
  const [micLevel, setMicLevel] = useState(0);

  const value = draft ?? localDraft;
  const setValue = onDraftChange ?? setLocalDraft;
  const submit = onSubmit ?? (() => {
    window.dispatchEvent(new CustomEvent("shadowroom:orb-submit", { detail: { text: localDraft } }));
    setLocalDraft("");
  });

  const forced = (typeof window !== "undefined" ? window.localStorage.getItem("qa-orb-force") : null) as OrbMode | null;
  /**
   * 通话状态以 App 为准（外部模式）还是以球自己为准（本地模式）。
   * 用户点球最重要的期待是「说话它能听见并回答」——只要 App 给了 onCallToggle，
   * 球就不再自己维护一份 callOn，界面与真通话无法走散。
   */
  const externalCall = onCallToggle !== undefined;
  const callOn = externalCall ? voiceMode === true : localCallOn;
  /** 通话五态 → 球外观态：映射在 lib/orb-states.ts（callOrbMode），这里不再就地猜。 */
  const callPhase: OrbMode = externalCall ? callOrbMode(voiceState) : "listening";
  const effectiveMode: OrbMode =
    mode ?? forced ?? (running ? "working" : callOn ? callPhase : "idle");
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
  const size = active ? ACTIVE_SIZE : ORB_SIZE;

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
    if (!callOn || externalCall) return;
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
  }, [callOn, externalCall]);

  useEffect(() => {
    if (!callOn || externalCall) {
      setVoiceActive(false);
      setMicLevel(0);
      return;
    }
    const id = window.setInterval(() => {
      const meter = meterRef.current;
      if (meter === null) return;
      const level = FINITE(meter.level(), 0);
      setMicLevel(level);
      setVoiceActive(latch.current.update(level));
    }, 33);
    return () => window.clearInterval(id);
  }, [callOn, externalCall]);

  const toggleCall = useCallback(() => {
    if (externalCall) onCallToggle?.();
    else setLocalCallOn((on) => !on);
  }, [externalCall, onCallToggle]);

  // Esc 挂断。
  useEffect(() => {
    if (!callOn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (externalCall) {
        if (!voiceMode) return;
        (onCallEnd ?? onCallToggle)?.();
      } else {
        setLocalCallOn(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [callOn, externalCall, onCallEnd, onCallToggle, voiceMode]);

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
      setPosition(clampToViewport(drag.originX + dx, drag.originY + dy, { width: window.innerWidth, height: window.innerHeight }, size));
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
    if (wasDrag) setPosition(snapToViewport(position, { width: window.innerWidth, height: window.innerHeight }, protectedRects(), size));
    if (wasClick && !expanded) toggleCall();
    else if (wasClick) setExpanded(false);
  };

  useEffect(() => {
    if (dragging) return;
    savePosition(window.localStorage, position);
  }, [position, dragging]);

  /**
   * SPA navigation and tab switches replace protected controls without resizing the orb. Re-check
   * after those DOM changes so a remembered position cannot sit on top of the settings form.
   * rAF coalesces bursts; equal positions do not write state and therefore cannot loop.
   */
  useEffect(() => {
    let frame: number | null = null;
    const revalidate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setPosition((current) => {
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const next = avoidProtected(current, protectedRects(), viewport, size);
          return next.x === current.x && next.y === current.y ? current : next;
        });
      });
    };
    const observer = new MutationObserver(revalidate);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", revalidate);
    window.addEventListener("scroll", revalidate, true);
    revalidate();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", revalidate);
      window.removeEventListener("scroll", revalidate, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [size]);


  // 单 rAF：把 RMS 平滑进 level ref，交给 r3f 的 useFrame（玻璃珠渲染在 Canvas 内部循环）。
  const levelRef = useRef(0);
  useEffect(() => {
    let last = performance.now();
    const tick = (now: number) => {
      const dt = FINITE(now - last, 16) / 120;
      last = now;
      /* 外部通话的电平来自 App 的同一条采集流；本地模式才用球自己的表。 */
      const live = externalCall ? (voiceLevel?.() ?? 0) : micLevel;
      const target = effectiveMode === "listening" ? live : 0;
      levelRef.current += (FINITE(target, 0) - levelRef.current) * Math.min(1, dt);
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, [effectiveMode, voiceLevel, micLevel, externalCall]);

  /**
   * 尺寸切换时重新夹取：球从 64 长到 80（或退回）时，旧坐标是按另一个尺寸算的，
   * 会让多出来的 16px 悬在视口外（P-8 实证）。只在真的越界时 setState，避免抖动。
   */
  useEffect(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const snapped = snapToViewport(position, viewport, protectedRects(), size);
    if (snapped.x !== position.x || snapped.y !== position.y) setPosition(snapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // 视口变了要重新量字幕（换窗口大小/全屏）。
  useEffect(() => {
    const onResize = () => setViewportTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    const el = captionRef.current;
    if (el === null) return;
    const EDGE = 8; // 字幕离视口边缘的最小留白
    const GAP = 6; // 字幕与球的缝（与 CSS 的 calc(100% + 6px) 同一口径）
    const rect = el.getBoundingClientRect();
    const orbCenterX = position.x + size / 2;
    const minCenter = EDGE + rect.width / 2;
    const maxCenter = Math.max(minCenter, window.innerWidth - EDGE - rect.width / 2);
    const center = Math.min(Math.max(orbCenterX, minCenter), maxCenter);
    const shift = Math.round(center - orbCenterX);
    const placement = position.y - GAP - rect.height < EDGE ? "below" : "above";
    const previous = captionGeomRef.current;
    if (previous.shift === shift && previous.placement === placement) return;
    captionGeomRef.current = { shift, placement };
    setCaptionGeom({ shift, placement });
  }, [caption, position.x, position.y, size, viewportTick]);

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
        aria-label={
          !callOn
            ? "开始通话"
            : externalCall && voiceState === "unclear"
              ? "重说"
              : externalCall && voiceState === "offline"
                ? "重连"
                : "结束通话"
        }
        title={
          !callOn
            ? "点一下开始说话（共享麦克风）· 拖动移动"
            : externalCall && voiceState === "unclear"
              ? "没听清：点一下重说 · 或按 Esc 挂断"
              : externalCall && voiceState === "offline"
                ? "连接断了：点一下重连 · 或按 Esc 挂断"
                : "通话中：再点一下或按 Esc 挂断"
        }
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
      {/*
        通话字幕（用户 2026-10：「球看着还行但非常不清晰」）。三态各有一行字：
        在听（识别中的话）/ 在想（等待，含「正在识别…」「没听清」这类可读提示）/ 在说（正在念的句子）。
        pointer-events:none——字幕绝不能挡球或页面的点击。
      */}
      {caption !== undefined && caption !== "" && (
        <div
          className="sr-orb-caption"
          aria-live="polite"
          data-call-caption
          data-placement={captionGeom.placement}
          ref={captionRef}
          style={{ ["--sr-caption-shift" as string]: `${captionGeom.shift}px` }}
        >
          {/* 状态点：与对话栏通话条同一个语义色（听=红点闪/想=琥珀/说=酸绿），扫一眼就分得清。 */}
          {callOn && <span className="sr-orb-caption-dot" data-state={voiceState} aria-hidden="true" />}
          <span className="sr-orb-caption-text">{caption}</span>
          {/* F-1：unclear 的「改成打字」出口。字幕本身 pointer-events:none（不许挡球），
              只有这颗按钮单独把事件收回来——它是这一态里除点球之外唯一的出路。 */}
          {captionAction !== undefined && (
            <button
              type="button"
              className="sr-orb-caption-action"
              data-caption-action
              onClick={captionAction.onAction}
            >
              {captionAction.label}
            </button>
          )}
        </div>
      )}

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
