/**
 * 悬浮球 v6：玻璃球体 + 液态双边缘 + 粒子内核 + 点球即通话。
 *
 * 形态与五态口径见 OrbGlass.tsx 头注；这里只管交互：**点一下球立刻进入通话动态**
 * （listening 动画 + 波形，麦克风经 lib/mic.ts 共享流），再点一下 / Esc 挂断回静态；
 * 面板**没有标题、没有听话开关**——只有一行输入 + 发送 + 一条细把手；文字说明只进 hover tooltip。
 *
 * 架构（用户强调）：干活的不是球——球只是全局管家/调度。无论当前在哪一页，它都写 butler 会话；
 * 页面 dock 才写该页 worker。球负责「知道全局 + 路由 + 汇报」，领域执行由用户确认后进入 worker。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { acquireMicrophone, onMicrophoneChange, releaseMicrophone } from "../lib/mic";
import {
  DEFAULT_ORB_SCALE,
  MAX_ORB_SCALE,
  MIN_ORB_SCALE,
  ORB_ACTIVE_SIZE,
  ORB_SCALE_STEP,
  avoidProtected,
  clampOrbScale,
  clampToViewport,
  defaultPosition,
  loadOrbScale,
  loadPosition,
  orbHitSize,
  orbSizeAtScale,
  saveOrbScale,
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
type CallTransition = "idle" | "opening" | "open" | "closing";

const ORB_HIDDEN_KEY = "shadowroom.orb.hidden.v1";
/** 开合动画（Kimi 主审 2026-10-20）：opening 1100±100ms、closing 800±100ms；reduced-motion 0ms 直接落态。 */
const OPEN_TRANSITION_MS = 1100;
const CLOSE_TRANSITION_MS = 800;
/** 通话没真正建立时的回退收束：360ms，快速退回，不再演一遍慢动画。 */
const FAIL_CLOSE_MS = 360;
const OPENING_FAILSAFE_MS = 3200;

/**
 * 尺寸：闲置与通话各有一个基准径（84 / 124），都按用户缩放档（25%–125%）同比缩放——
 * 21px 的小球通话时是 31px，105px 的大球通话时是 155px。位置/夹取按当前视觉径算，
 * 命中区单独兜底（最小 32px，见 orb-position.ts 的 orbHitSize）。
 */
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
  ".sr-settings-pane",
  ".sr-provider-card",
  ".sr-role-row",
  ".sr-capability-card",
  ".sr-home-action",
  ".sr-plugin-card",
  ".sr-project-new",
  ".sr-project-card",
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
  onOpenHistory,
  onNewConversation,
  onOpenSettings,
  caption,
  captionAction,
  contextKey,
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
  /** 右键菜单里的全局导航；数据和页面切换都仍由 App 掌管。 */
  onOpenHistory?: () => void;
  onNewConversation?: () => void;
  onOpenSettings?: () => void;
  /** 球旁的一行字幕：在听（识别中的话）/ 在想（等待）/ 在说（正在念的那句）。 */
  caption?: string;
  /**
   * 字幕里的出路（F-1 / deepseek O-3）：unclear 态给第二条路「改成打字」——
   * 非语音 fallback 是 W3C 硬要求，不是加分项。只在有 caption 时出现，最多一颗。
   */
  captionAction?: { label: string; onAction: () => void };
  /** Page identity used to re-check protected controls after navigation, without watching scroll. */
  contextKey?: string;
}) {
  const externalCall = onCallToggle !== undefined;
  const [orbScale, setOrbScale] = useState(() => loadOrbScale(window.localStorage));
  const idleSize = orbSizeAtScale(orbScale);
  const activeSize = orbSizeAtScale(orbScale, ORB_ACTIVE_SIZE);
  const initialCallActive = running || mode !== undefined || (externalCall && voiceMode === true);
  const initialSize = initialCallActive ? activeSize : idleSize;
  const [position, setPosition] = useState(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const controls = protectedRects();
    const stored = loadPosition(window.localStorage);
    return stored === null
      ? defaultPosition(viewport, controls, initialSize)
      : avoidProtected(stored, controls, viewport, initialSize);
  });
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem(ORB_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const previousSizeRef = useRef(initialSize);
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

  /**
   * Empty pages can hand an intent to the global butler without importing App state. The Studio
   * empty-state CTA dispatches this cancelable event; accepting it opens the orb composer with a
   * concrete first prompt. If no orb is mounted (isolated component test), Studio reports the miss.
   */
  useEffect(() => {
    const onButlerStart = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { projectName?: unknown; intent?: unknown } | null;
      event.preventDefault();
      const projectName = typeof detail?.projectName === "string" ? detail.projectName.trim() : "";
      setValue(projectName === "" ? "帮我先起一个 demo。" : `在 Studio 工程《${projectName}》里帮我先起一个 demo。`);
      setExpanded(true);
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>(".sr-orb-input .sr-input")?.focus();
      });
    };
    window.addEventListener("shadowroom:butler-start", onButlerStart);
    return () => window.removeEventListener("shadowroom:butler-start", onButlerStart);
  }, [setValue]);

  const forced = (typeof window !== "undefined" ? window.localStorage.getItem("qa-orb-force") : null) as OrbMode | null;
  /**
   * 通话状态以 App 为准（外部模式）还是以球自己为准（本地模式）。
   * 用户点球最重要的期待是「说话它能听见并回答」——只要 App 给了 onCallToggle，
   * 球就不再自己维护一份 callOn，界面与真通话无法走散。
   */
  const callOn = externalCall ? voiceMode === true : localCallOn;
  /** 通话五态 → 球外观态：映射在 lib/orb-states.ts（callOrbMode），这里不再就地猜。 */
  const callPhase: OrbMode = externalCall ? callOrbMode(voiceState) : "listening";
  const [callTransition, setCallTransition] = useState<CallTransition>(callOn ? "open" : "idle");
  const [closeShrink, setCloseShrink] = useState(false);
  /** 通话没建立起来的收束走 360ms 快路径（data-fail-close），不占用户等一遍慢动画。 */
  const [failClose, setFailClose] = useState(false);
  const lastCallMode = useRef<OrbMode>("listening");
  const callOnRef = useRef(callOn);
  const previousCallOn = useRef(callOn);
  const transitionTimer = useRef<number | null>(null);
  const openingFailsafe = useRef<number | null>(null);
  const openingStartedAt = useRef(0);
  const closeFrame = useRef<number | null>(null);
  callOnRef.current = callOn;
  if (callOn && callPhase !== "idle") lastCallMode.current = callPhase;
  const effectiveMode: OrbMode =
    forced ??
    (callTransition === "closing" || (callTransition === "open" && !callOn)
      ? lastCallMode.current
      : mode ?? (running ? "working" : callOn ? callPhase : "idle"));
  // 验收钩子（生产不触发）：qa-orb-progress 只在强制模式下顶替 progress，让「干活」弧可确定性截图。
  const qaProgress =
    forced !== null && typeof window !== "undefined"
      ? (() => {
          const raw = Number(window.localStorage.getItem("qa-orb-progress"));
          return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;
        })()
      : undefined;
  const effectiveProgress = progress ?? qaProgress;
  const active = callOn || callTransition === "opening" || callTransition === "closing" || effectiveMode !== "idle";
  const size =
    callTransition === "closing"
      ? closeShrink
        ? idleSize
        : activeSize
      : callOn || callTransition === "opening" || (callTransition === "open" && !callOn) || effectiveMode !== "idle"
        ? activeSize
        : idleSize;
  const callBusy = callOn || callTransition !== "idle";

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

  /**
   * The call itself remains App-owned. This local state only lets the visual finish opening or
   * closing even when the underlying state flips immediately.
   */
  useEffect(() => {
    const wasOn = previousCallOn.current;
    previousCallOn.current = callOn;
    if (wasOn === callOn) return;
    if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
    if (callOn) {
      if (openingFailsafe.current !== null) {
        window.clearTimeout(openingFailsafe.current);
        openingFailsafe.current = null;
      }
      setCloseShrink(false);
      setFailClose(false);
      setCallTransition("opening");
      const elapsed = openingStartedAt.current > 0 ? performance.now() - openingStartedAt.current : OPEN_TRANSITION_MS;
      transitionTimer.current = window.setTimeout(() => {
        transitionTimer.current = null;
        openingStartedAt.current = 0;
        setCallTransition("open");
      }, reducedMotion.current ? 0 : Math.max(0, OPEN_TRANSITION_MS - elapsed));
    } else if (wasOn) {
      openingStartedAt.current = 0;
      if (reducedMotion.current) {
        setCloseShrink(true);
        setCallTransition("idle");
      } else {
        setCloseShrink(false);
        setCallTransition("closing");
        if (closeFrame.current !== null) cancelAnimationFrame(closeFrame.current);
        closeFrame.current = requestAnimationFrame(() => {
          closeFrame.current = requestAnimationFrame(() => {
            closeFrame.current = null;
            setCloseShrink(true);
          });
        });
        transitionTimer.current = window.setTimeout(() => {
          transitionTimer.current = null;
          setCallTransition("idle");
        }, CLOSE_TRANSITION_MS);
      }
    }
    return () => {
      if (transitionTimer.current !== null) {
        window.clearTimeout(transitionTimer.current);
        transitionTimer.current = null;
      }
      if (closeFrame.current !== null) {
        cancelAnimationFrame(closeFrame.current);
        closeFrame.current = null;
      }
    };
  }, [callOn]);

  useEffect(
    () => () => {
      if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
      if (openingFailsafe.current !== null) window.clearTimeout(openingFailsafe.current);
      if (closeFrame.current !== null) cancelAnimationFrame(closeFrame.current);
    },
    [],
  );

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

  const changeOrbScale = useCallback(
    (next: number) => {
      if (callBusy) return;
      const normalized = clampOrbScale(next);
      setOrbScale(normalized);
      saveOrbScale(window.localStorage, normalized);
    },
    [callBusy],
  );

  const startCallWithAnimation = useCallback(() => {
    if (callOn || callTransition === "opening" || callTransition === "closing") return;
    setExpanded(false);
    setMenuOpen(false);
    setCloseShrink(false);
    openingStartedAt.current = performance.now();
    setCallTransition("opening");
    if (openingFailsafe.current !== null) window.clearTimeout(openingFailsafe.current);
    openingFailsafe.current = window.setTimeout(() => {
      openingFailsafe.current = null;
      if (callOnRef.current) return;
      setFailClose(true);
      setCloseShrink(false);
      setCallTransition("closing");
      if (closeFrame.current !== null) cancelAnimationFrame(closeFrame.current);
      closeFrame.current = requestAnimationFrame(() => {
        closeFrame.current = requestAnimationFrame(() => {
          closeFrame.current = null;
          setCloseShrink(true);
        });
      });
      if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current);
      transitionTimer.current = window.setTimeout(() => {
        transitionTimer.current = null;
        setCallTransition("idle");
      }, FAIL_CLOSE_MS);
    }, OPENING_FAILSAFE_MS);
    toggleCall();
  }, [callOn, callTransition, toggleCall]);

  const resetOrbPosition = useCallback(() => {
    setMenuOpen(false);
    setPosition(defaultPosition({ width: window.innerWidth, height: window.innerHeight }, protectedRects(), size));
  }, [size]);

  const hideOrb = useCallback(() => {
    if (callOn || callTransition !== "idle") return;
    setMenuOpen(false);
    setExpanded(false);
    setHidden(true);
    try {
      window.localStorage.setItem(ORB_HIDDEN_KEY, "1");
    } catch {
      // A storage-denied browser can still hide for this session.
    }
  }, [callOn, callTransition]);

  const restoreOrb = useCallback(() => {
    setHidden(false);
    try {
      window.localStorage.removeItem(ORB_HIDDEN_KEY);
    } catch {
      // Nothing persisted; the current session still restores.
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const focusables = () =>
      [...(menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    window.requestAnimationFrame(() => focusables()[0]?.focus());
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && menu?.contains(event.target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = focusables();
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (current + 1 + items.length) % items.length
              : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

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
  // 指针事件只挂在球面上，命中区随当前球径变化（留 3px 防误触边缘）；球面方形角落只拖不点，
  // 底下的内容不会被"看不见的手"按到（D2）。
  const hitBall = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2)) <=
      rect.width / 2 - 3
    );
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    /**
     * macOS 的触控板 Control+点击会先发一个 button=0 的 pointerdown，再发 contextmenu。
     * 如果这里不排除 ctrlKey，pointerup 会把同一次手势当成左键点击并启动通话，表现为
     * “右键和左键做了同一件事”。设备发原生 button=2 时也走同一个提前返回。
     */
    if (event.button !== 0 || event.ctrlKey) return;
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
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
    if (!wasClick) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (callOn) {
      if (callTransition === "closing") return;
      toggleCall();
      return;
    }
    startCallWithAnimation();
  };

  useEffect(() => {
    if (dragging) return;
    savePosition(window.localStorage, position);
  }, [position, dragging]);

  /**
   * Re-check only when the page or viewport changes. A capture-phase scroll listener used to react
   * to every list scroll and could walk the orb across the screen as protected controls moved.
   * `shadowroom:orb-revalidate` is the page-side hook (App dispatches it on mainView change);
   * `contextKey` covers the same thing via props for isolated mounts.
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
    window.addEventListener("resize", revalidate);
    window.addEventListener("shadowroom:orb-revalidate", revalidate);
    revalidate();
    return () => {
      window.removeEventListener("resize", revalidate);
      window.removeEventListener("shadowroom:orb-revalidate", revalidate);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [contextKey, size]);


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
  useLayoutEffect(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const previous = previousSizeRef.current;
    previousSizeRef.current = size;
    if (previous === size) return;
    setPosition((current) =>
      snapToViewport(
        {
          x: current.x - (size - previous) / 2,
          y: current.y - (size - previous) / 2,
        },
        viewport,
        protectedRects(),
        size,
      ),
    );
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

  if (hidden) {
    const restoreSize = 34;
    return (
      <button
        type="button"
        className="sr-orb-restore"
        style={{
          left: Math.max(8, position.x + (size - restoreSize) / 2),
          top: Math.max(8, position.y + (size - restoreSize) / 2),
        }}
        aria-label="显示悬浮球"
        title="显示悬浮球"
        onClick={restoreOrb}
      >
        <span aria-hidden="true" />
      </button>
    );
  }

  const menuVertical = position.y + size + 12 + 330 <= window.innerHeight ? "below" : "above";
  const menuHorizontal = position.x + size - 208 >= 8 ? "right" : "left";

  return (
    <div
      className={`sr-orb${expanded ? " sr-orb--expanded" : ""}${dragging ? " sr-orb--dragging" : ""}${active ? " sr-orb--active" : ""}`}
      data-mode={effectiveMode}
      data-call-transition={callTransition}
      data-fail-close={failClose || undefined}
      style={{
        left: position.x,
        top: position.y,
        ["--sr-orb-size" as string]: `${size}px`,
        ["--sr-orb-hit-size" as string]: `${orbHitSize(size)}px`,
      }}
    >
      {/* 容器不吃事件（fixed 方块盖住内容就是 D2 的病根）；事件只挂在球面上，点空白穿透。 */}
      <div
        className="sr-orb-ball"
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
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
            ? "点一下开始说话 · 右键打开菜单 · 拖动移动"
            : externalCall && voiceState === "unclear"
              ? "没听清：点一下重说 · 或按 Esc 挂断"
              : externalCall && voiceState === "offline"
                ? "连接断了：点一下重连 · 或按 Esc 挂断"
            : "通话中：再点一下或按 Esc 挂断 · 右键打开菜单"
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
          setMenuOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            setExpanded(false);
            setMenuOpen(true);
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((open) => !open);
          }
        }}
      >
        {/* v6 材质分层：CSS 负责高清玻璃/双边缘，canvas 只画粒子和语音细节。 */}
        <GlassSphere
          size={size}
          mode={effectiveMode}
          level={levelRef.current}
          progress={effectiveProgress}
          reducedMotion={reducedMotion.current}
          transitioning={callTransition === "opening" || callTransition === "closing"}
        />
      </div>
      {menuOpen && (
        <div
          ref={menuRef}
          className="sr-orb-menu"
          role="menu"
          aria-label="语音助手菜单"
          data-vertical={menuVertical}
          data-horizontal={menuHorizontal}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="sr-orb-menu-item"
            disabled={callTransition === "opening" || callTransition === "closing"}
            onClick={() => {
              setMenuOpen(false);
              if (callOn) (onCallEnd ?? onCallToggle)?.();
              else startCallWithAnimation();
            }}
          >
            <span className="sr-orb-menu-mark" aria-hidden="true">{callOn ? "■" : "▶"}</span>
            <span>
              {callTransition === "opening"
                ? "正在连接…"
                : callTransition === "closing"
                  ? "正在挂断…"
                  : callOn
                    ? "结束通话"
                    : "开始通话"}
            </span>
          </button>
          {onOpenHistory !== undefined && (
            <button
              type="button"
              role="menuitem"
              className="sr-orb-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onOpenHistory();
              }}
            >
              <span className="sr-orb-menu-mark" aria-hidden="true">⌁</span>
              <span>聊天记录</span>
            </button>
          )}
          {onNewConversation !== undefined && (
            <button
              type="button"
              role="menuitem"
              className="sr-orb-menu-item"
              disabled={callBusy}
              title={callBusy ? "先结束通话，再新建对话" : undefined}
              onClick={() => {
                setMenuOpen(false);
                onNewConversation();
              }}
            >
              <span className="sr-orb-menu-mark" aria-hidden="true">＋</span>
              <span>新对话</span>
            </button>
          )}
          <div className="sr-orb-menu-size" role="group" aria-label={`悬浮球大小 ${Math.round(orbScale * 100)}%`}>
            <span className="sr-orb-menu-size-label">悬浮球大小</span>
            <button
              type="button"
              role="menuitem"
              className="sr-orb-menu-size-btn"
              aria-label="缩小悬浮球"
              title={callBusy ? "先结束通话，再调整大小" : "缩小悬浮球"}
              disabled={callBusy || orbScale <= MIN_ORB_SCALE}
              onClick={() => changeOrbScale(orbScale - ORB_SCALE_STEP)}
            >
              −
            </button>
            <button
              type="button"
              role="menuitem"
              className="sr-orb-menu-size-value"
              aria-label="恢复悬浮球默认大小"
              title="恢复 100%"
              disabled={callBusy}
              onClick={() => changeOrbScale(DEFAULT_ORB_SCALE)}
            >
              {Math.round(orbScale * 100)}%
            </button>
            <button
              type="button"
              role="menuitem"
              className="sr-orb-menu-size-btn"
              aria-label="放大悬浮球"
              title={callBusy ? "先结束通话，再调整大小" : "放大悬浮球"}
              disabled={callBusy || orbScale >= MAX_ORB_SCALE}
              onClick={() => changeOrbScale(orbScale + ORB_SCALE_STEP)}
            >
              ＋
            </button>
          </div>
          <span className="sr-orb-menu-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="sr-orb-menu-item"
            onClick={resetOrbPosition}
          >
            <span className="sr-orb-menu-mark" aria-hidden="true">◎</span>
            <span>重置位置</span>
          </button>
          {onOpenSettings !== undefined && (
            <button
              type="button"
              role="menuitem"
              className="sr-orb-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <span className="sr-orb-menu-mark" aria-hidden="true">⚙</span>
              <span>设置</span>
            </button>
          )}
          <span className="sr-orb-menu-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="sr-orb-menu-item sr-orb-menu-item--quiet"
            disabled={callBusy}
            title={callBusy ? "先结束通话，再隐藏悬浮球" : "隐藏后会留下一个小恢复点"}
            onClick={hideOrb}
          >
            <span className="sr-orb-menu-mark" aria-hidden="true">×</span>
            <span>关闭悬浮球</span>
          </button>
        </div>
      )}
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
