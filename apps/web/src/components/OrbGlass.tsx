/**
 * 管家球 v5 的绘制（canvas 2D，方向 A「暗核光圈」——照 iOS 18 Siri 拆解重做）。
 *
 * v4 的病：白核实心球像颗塑料珠，五态只分两族颜色，thinking/working 与 idle 一模一样
 * （用户："跟人机一样"）。v5 的形态 = **深色半透明核 + 液态亮描边（色相沿边流动）+ 外发光**，
 * 五态走三条独立通道，任意两态至少在两个通道上不同（单测钉住）：
 *   色相族  说=青绿 / 其余蓝紫 / 干活=品牌酸绿进度弧
 *   运动    思考=色相快速追边+中心旋流 / 听=漂移加速+电平驱动边宽 / 闲=4s 慢呼吸
 *   亮度    听 > 思考 > 闲
 * 状态切换不做硬切：参数逐帧指数趋近， morph 过去。reduced-motion 冻结一切位移，
 * 但色相族/亮度/进度弧保留（信息不丢）。进 canvas 的数值先过 Number.isFinite（P0 教训）。
 */
import { useEffect, useRef } from "react";
import { ORB_STATES, lerpHue, type OrbVisualMode } from "../lib/orb-states.ts";

export type { OrbVisualMode } from "../lib/orb-states.ts";

/** 品牌酸绿（--sr-accent #d9ff3d ≈ hsl(68,100%,62%)）：干活进度弧专用。 */
const ACID = { h: 68, s: 100, l: 62 };
const TAU = Math.PI * 2;
const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function GlassSphere({
  size,
  mode,
  level,
  progress,
  reducedMotion,
}: {
  size: number;
  mode: OrbVisualMode;
  /** 麦克风电平 0–1（listening 时驱动边宽与发光） */
  level: number;
  /** 干活进度 0–1；不给 = 不定态（酸绿弧追赶）。 */
  progress?: number;
  reducedMotion?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({ mode, level, progress, still: reducedMotion === true });
  state.current = { mode, level, progress, still: reducedMotion === true };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = FINITE(size, 64) * dpr;
    if (!Number.isFinite(px) || px <= 0) return;
    canvas.width = Math.round(px);
    canvas.height = Math.round(px);

    // 逐帧趋近的当前参数（初值=idle，首次 mode 切换也是 morph 过去的）
    const current = { ...ORB_STATES.idle };
    let smoothedLevel = 0;
    let frame = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = FINITE(now / 1000, 0);
      const { mode: m, level: rawLevel, progress: rawProgress, still } = state.current;
      const target = ORB_STATES[m] ?? ORB_STATES.idle;
      const k = 0.09; // morph 速率：~0.4s 内到位
      current.hueA = lerpHue(current.hueA, target.hueA, k);
      current.hueB = lerpHue(current.hueB, target.hueB, k);
      current.drift = lerp(current.drift, target.drift, k);
      current.rimAlpha = lerp(current.rimAlpha, target.rimAlpha, k);
      current.rimWidth = lerp(current.rimWidth, target.rimWidth, k);
      current.glow = lerp(current.glow, target.glow, k);
      current.breathe = lerp(current.breathe, target.breathe, k);
      current.wobble = lerp(current.wobble, target.wobble, k);
      current.ripple = lerp(current.ripple, target.ripple, k);
      current.swirl = lerp(current.swirl, target.swirl, k);
      smoothedLevel += (Math.max(0, Math.min(1, FINITE(rawLevel, 0))) - smoothedLevel) * 0.18;
      const voice = m === "listening" && !still ? smoothedLevel : 0;

      const r = px / 2;
      const cx = r;
      const cy = r;
      const breatheScale = still ? 1 : 1 + current.breathe * Math.sin(t * TAU * 0.25);
      const rimR = r * 0.66 * breatheScale * (1 + voice * 0.06);
      const rimW = Math.max(1, r * current.rimWidth * (1 + voice * 0.9));

      ctx.clearRect(0, 0, px, px);

      // 液态边（wobble 圆）：reduced-motion 下是正圆
      const wobblePath = new Path2D();
      for (let i = 0; i <= 96; i += 1) {
        const angle = (i / 96) * TAU;
        const w = still
          ? 0
          : Math.sin(angle * 3 + t * 1.1) * current.wobble + Math.sin(angle * 5 - t * 0.7) * current.wobble * 0.55;
        const radius = rimR * (1 + w);
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) wobblePath.moveTo(x, y);
        else wobblePath.lineTo(x, y);
      }
      wobblePath.closePath();

      // ① 外发光：同路径更宽更淡的一道描边（比 shadowBlur 便宜）
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const driftPhase = still ? 0 : (t * current.drift) % 1;
      const SEGMENTS = 32;
      const drawRim = (width: number, alphaScale: number) => {
        for (let i = 0; i < SEGMENTS; i += 1) {
          const a0 = (i / SEGMENTS) * TAU;
          const a1 = ((i + 1) / SEGMENTS) * TAU;
          const hue = lerpHue(current.hueA, current.hueB, (i / SEGMENTS + driftPhase) % 1);
          ctx.beginPath();
          ctx.arc(cx, cy, rimR, a0, a1 + 0.002);
          // 描边画在 wobble 圆的均值半径上；液态感靠色相流动承担（逐段 wobble 描边会断）
          ctx.strokeStyle = `hsla(${hue}, 95%, 66%, ${Math.min(1, current.rimAlpha * alphaScale)})`;
          ctx.lineWidth = width;
          ctx.stroke();
        }
      };
      drawRim(rimW * 2.4, current.glow * 0.22);
      drawRim(rimW, 1);

      // ② 暗核：半透明（背景微微透出来，球才不像贴上去的塑料片）
      const core = ctx.createRadialGradient(cx, cy, rimR * 0.1, cx, cy, rimR);
      core.addColorStop(0, `hsla(${lerpHue(current.hueA, current.hueB, 0.5)}, 55%, 14%, 0.86)`);
      core.addColorStop(0.75, `hsla(${current.hueA}, 60%, 10%, 0.62)`);
      core.addColorStop(1, `hsla(${current.hueA}, 70%, 12%, 0)`);
      ctx.fillStyle = core;
      ctx.fill(wobblePath);

      // ③ 思考：中心旋流（注意力在打转）
      if (current.swirl > 0.02 && !still) {
        const spin = (t * current.drift * 2.2) % 1;
        ctx.beginPath();
        ctx.arc(cx, cy, rimR * 0.42, spin * TAU, spin * TAU + TAU * 0.3);
        ctx.strokeStyle = `hsla(${current.hueB}, 95%, 78%, ${0.6 * current.swirl})`;
        ctx.lineWidth = Math.max(1, r * 0.05);
        ctx.stroke();
      }

      // ④ 说话：向外扩散的节拍波纹
      if (current.ripple > 0.02 && !still) {
        for (let i = 0; i < 2; i += 1) {
          const phase = (t * 0.55 + i * 0.5) % 1;
          const rr = rimR * (1 + phase * 0.6);
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, TAU);
          ctx.strokeStyle = `hsla(${current.hueA}, 95%, 72%, ${Math.max(0, 0.5 * (1 - phase) * current.ripple)})`;
          ctx.lineWidth = Math.max(1, r * 0.025);
          ctx.stroke();
        }
      }

      // ⑤ 干活（只属于 working）：品牌酸绿弧——有 progress 画完成度，没有画 0.35 圈追赶
      // （信息弧，reduced-motion 也画；此前 unconditional 画会把绿弧漏进 idle/thinking）。
      if (m === "working") {
        const p = rawProgress !== undefined && Number.isFinite(rawProgress) ? Math.max(0, Math.min(1, rawProgress)) : null;
        const chase = still ? 0.12 : (t * 0.45) % 1;
        const start = p !== null ? -Math.PI / 2 : chase * TAU;
        const length = p !== null ? p * TAU : TAU * 0.35;
        if (p === null || p > 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, rimR, start, start + Math.max(0.001, length));
          ctx.strokeStyle = `hsla(${ACID.h}, ${ACID.s}%, ${ACID.l}%, 0.95)`;
          ctx.lineWidth = rimW * 1.15;
          ctx.stroke();
        }
      }
      ctx.restore();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className="sr-orb-canvas"
      style={{ width: size, height: size, pointerEvents: "none" }}
    />
  );
}
