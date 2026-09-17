/**
 * 管家球的绘制（canvas 2D，照着新版 Siri 那颗球抄）。
 *
 * 为什么不用 three.js：用户要的是「一眼就看见、像 Siri 那样有体积的发光球」，不是一颗小玻璃珠。
 * 2D 画布足够做出 Siri 的关键特征，而且没有依赖、不会 NaN 崩：
 *   ① 柔和外发光（青蓝→透明）② 球体=白核偏左上→青蓝→蓝紫→透明的多段径向渐变（虹彩感来源）
 *   ③ 边缘不是正圆：半径按 3 条不同频率的正弦随时间起伏（有机流体边）④ 边缘光 + 左上镜面高光
 *   ⑤ 6 颗高光粒子沿球面绕行（越靠后越暗越小）⑥ 你说=青蓝外扩波纹，它说=青绿向内容
 * 所有进 canvas 的数值先过 Number.isFinite（P0 教训：NaN 会让整块画布炸掉）。
 */
import { useEffect, useRef } from "react";

const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

export function GlassSphere({
  size,
  mode,
  level,
  reducedMotion,
}: {
  size: number;
  /** "idle" | "listening"（你说）| "speaking"（它说）| "working" */
  mode: string;
  /** 麦克风电平 0–1（上层每帧更新，这里平滑后使用） */
  level: number;
  reducedMotion?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 动画脱离 React 重渲染：每帧从 ref 读最新值。 */
  const state = useRef({ mode, level, reducedMotion: reducedMotion === true });
  state.current = { mode, level, reducedMotion: reducedMotion === true };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = FINITE(size, 120) * dpr;
    canvas.width = Math.round(px);
    canvas.height = Math.round(px);
    let frame = 0;
    let smoothed = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = FINITE(now / 1000, 0);
      const current = state.current.mode;
      const still = state.current.reducedMotion;
      const r = px / 2;
      const cx = r;
      const cy = r;
      smoothed += (Math.max(0, Math.min(1, FINITE(state.current.level, 0))) - smoothed) * 0.18;
      const level = smoothed;
      const speaking = current === "speaking";
      const active = current !== "idle";
      const hue = speaking ? 158 : 216;
      const alphaBody = active ? 0.95 : 0.72;
      if (!Number.isFinite(px) || px <= 0) return;

      ctx.clearRect(0, 0, px, px);

      // ① 外发光
      const halo = ctx.createRadialGradient(cx, cy, r * 0.32, cx, cy, r);
      halo.addColorStop(0, `hsla(${hue}, 100%, 66%, ${0.32 + level * 0.26})`);
      halo.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // ② 有机流体边
      const wobble = (angle: number): number => {
        if (still) return 0;
        const k = level * 0.07 + 0.035;
        return Math.sin(angle * 3 + t * 0.9) * k + Math.sin(angle * 5 - t * 0.6) * k * 0.6;
      };
      const bodyR = r * (0.84 + level * 0.05);
      const path = new Path2D();
      for (let i = 0; i <= 96; i += 1) {
        const angle = (i / 96) * Math.PI * 2;
        const radius = bodyR * (1 + wobble(angle));
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();

      // ③ 球体（虹彩）
      const core = ctx.createRadialGradient(cx - r * 0.26, cy - r * 0.3, r * 0.03, cx, cy, bodyR * 1.05);
      core.addColorStop(0, `hsla(${hue}, 100%, 98%, ${alphaBody})`);
      core.addColorStop(0.22, `hsla(${hue}, 100%, 80%, ${alphaBody})`);
      core.addColorStop(0.55, `hsla(${hue + 24}, 92%, 62%, ${alphaBody * 0.85})`);
      core.addColorStop(0.82, `hsla(${hue + 60}, 88%, 58%, ${alphaBody * 0.45})`);
      core.addColorStop(1, `hsla(${hue + 80}, 90%, 60%, 0)`);
      ctx.fillStyle = core;
      ctx.fill(path);

      // ④ 边缘光 + 镜面高光
      ctx.save();
      ctx.clip(path);
      const rim = ctx.createRadialGradient(cx, cy, bodyR * 0.7, cx, cy, bodyR);
      rim.addColorStop(0, "rgba(255,255,255,0)");
      rim.addColorStop(1, `hsla(${hue + 10}, 100%, 90%, ${0.6 + level * 0.35})`);
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, px, px);
      const spec = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.38, 0, cx - r * 0.34, cy - r * 0.38, r * 0.34);
      spec.addColorStop(0, "rgba(255,255,255,0.9)");
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = spec;
      ctx.fillRect(0, 0, px, px);
      ctx.restore();

      // ⑤ 绕行火花
      if (!still) {
        for (let i = 0; i < 6; i += 1) {
          const phase = t * 0.6 + (i / 6) * Math.PI * 2;
          const depth = Math.cos(phase);
          const radius = bodyR * 1.06;
          const x = cx + Math.cos(phase) * radius;
          const y = cy + Math.sin(phase * 0.9) * radius * 0.86;
          const scale = 0.5 + (depth + 1) * 0.35;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0.8, r * 0.04 * scale), 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${hue + 10}, 100%, 93%, ${0.35 + (depth + 1) * 0.3})`;
          ctx.fill();
        }
      }

      // ⑥ 状态波纹
      if (active && !still) {
        for (let i = 0; i < 2; i += 1) {
          const phase = (t * (speaking ? -0.5 : 0.5) + i * 0.5) % 1;
          const ringR = speaking ? bodyR * (0.92 - phase * 0.36) : bodyR * (0.86 + phase * 0.4);
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1, ringR), 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${Math.max(0, 0.38 * (1 - phase))})`;
          ctx.lineWidth = Math.max(1, r * 0.02);
          ctx.stroke();
        }
      }
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
