/**
 * Butler orb v6.
 *
 * v5 tried to draw the whole sphere in one 2D canvas. Its dark core was painted after the rim,
 * which softened the only sharp edge, and thirty-two independently stroked arcs exposed seams as
 * soon as the active orb grew. v6 splits the visual by material instead:
 *   CSS glass + conic rim   → geometrically smooth at any DPR, always crisp
 *   canvas plasma + motes  → cheap organic motion and microphone response
 *   CSS orbit / ripples    → state-specific motion that does not muddy the silhouette
 *
 * The active orb is deliberately larger than idle. Clarity is a product requirement here, not a
 * decoration: the thing users click must remain legible while speech subtitles and app content move
 * underneath it.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { ORB_STATES, lerpHue, type OrbVisualMode } from "../lib/orb-states.ts";

export type { OrbVisualMode } from "../lib/orb-states.ts";

const TAU = Math.PI * 2;
const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

const SPIN_SECONDS: Record<OrbVisualMode, number> = {
  idle: 17,
  listening: 7.5,
  speaking: 5.2,
  thinking: 1.9,
  working: 6,
  unclear: 8.5,
  offline: 0,
};

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
  const visualRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({ mode, level, progress, still: reducedMotion === true });
  state.current = { mode, level, progress, still: reducedMotion === true };
  const visual = ORB_STATES[mode] ?? ORB_STATES.idle;
  const rim = Math.max(1, size * visual.rimWidth * 0.14);
  const progressValue =
    progress !== undefined && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : undefined;
  const style = {
    width: size,
    height: size,
    "--orb-hue-a": visual.hueA,
    "--orb-hue-b": visual.hueB,
    "--orb-rim-alpha": visual.rimAlpha,
    "--orb-glow": visual.glow,
    "--orb-spin": `${SPIN_SECONDS[mode] ?? 12}s`,
    "--orb-rim-size": `${rim}px`,
    "--orb-rim-inner-size": `${Math.max(1, rim * 0.52)}px`,
    "--orb-progress": progressValue ?? 0.35,
    "--orb-progress-turn": `${(progressValue ?? 0.35) * 1}turn`,
  } as CSSProperties;

  useEffect(() => {
    const visualElement = visualRef.current;
    const canvas = canvasRef.current;
    if (visualElement === null || canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    /**
     * Supersample beyond Retina: the active orb is only ~112 CSS px and has fine dust/voice ticks.
     * A 3× backing store removes the stair-stepping visible in v5 even when the window is scaled.
     */
    const dpr = Math.min(3, Math.max(2.75, window.devicePixelRatio || 1));
    const px = FINITE(size, 64) * dpr;
    if (!Number.isFinite(px) || px <= 0) return;
    canvas.width = Math.round(px);
    canvas.height = Math.round(px);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const current = { ...ORB_STATES.idle };
    let smoothedLevel = 0;
    let frame = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = FINITE(now / 1000, 0);
      const { mode: m, level: rawLevel, still } = state.current;
      const motionTime = still ? 0 : t;
      const target = ORB_STATES[m] ?? ORB_STATES.idle;
      const k = 0.11;
      current.hueA = lerpHue(current.hueA, target.hueA, k);
      current.hueB = lerpHue(current.hueB, target.hueB, k);
      current.drift = lerp(current.drift, target.drift, k);
      current.rimAlpha = lerp(current.rimAlpha, target.rimAlpha, k);
      current.glow = lerp(current.glow, target.glow, k);
      current.ripple = lerp(current.ripple, target.ripple, k);
      current.swirl = lerp(current.swirl, target.swirl, k);
      smoothedLevel += (Math.max(0, Math.min(1, FINITE(rawLevel, 0))) - smoothedLevel) * 0.18;
      visualElement.style.setProperty("--orb-voice", smoothedLevel.toFixed(3));
      const r = size / 2;
      const cx = r;
      const cy = r;
      const plasmaR = r * 0.47;
      ctx.clearRect(0, 0, size, size);

      // Three independently moving plasma lobes. They stay inside a circular clip so the hero rim
      // remains the crisp boundary instead of being softened by a large shadow.
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, plasmaR, 0, TAU);
      ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 3; i += 1) {
        const phase = (still ? 0 : t * (0.22 + i * 0.055)) + i * 2.1;
        const x = cx + Math.cos(phase) * plasmaR * (0.2 + i * 0.07);
        const y = cy + Math.sin(phase * 1.23) * plasmaR * (0.17 + i * 0.055);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, plasmaR * (0.62 + current.glow * 0.3));
        glow.addColorStop(0, `hsla(${i === 1 ? current.hueB : current.hueA}, 100%, 70%, ${0.14 + current.glow * 0.08})`);
        glow.addColorStop(0.55, `hsla(${i === 1 ? current.hueB : current.hueA}, 95%, 58%, 0.065)`);
        glow.addColorStop(1, `hsla(${current.hueB}, 95%, 55%, 0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(cx - plasmaR, cy - plasmaR, plasmaR * 2, plasmaR * 2);
      }
      const core = ctx.createRadialGradient(
        cx - plasmaR * 0.08,
        cy - plasmaR * 0.12,
        0,
        cx,
        cy,
        plasmaR * 0.92,
      );
      core.addColorStop(0, `hsla(${current.hueA}, 100%, 82%, ${0.15 + current.glow * 0.11})`);
      core.addColorStop(0.3, `hsla(${current.hueB}, 100%, 66%, ${0.055 + current.glow * 0.05})`);
      core.addColorStop(1, `hsla(${current.hueB}, 100%, 55%, 0)`);
      ctx.fillStyle = core;
      ctx.fillRect(cx - plasmaR, cy - plasmaR, plasmaR * 2, plasmaR * 2);

      /**
       * Speaking is a material morph, not a second animation pasted on top. Every mote has a stable
       * orbital home and a stable lane on a horizontal waveform; `current.ripple` smoothly blends
       * between the two. The result reads as the same organism changing form instead of a waveform
       * appearing over unrelated particles.
       */
      const voiceBlend = m === "speaking" ? smoothstep(current.ripple) : 0;
      const waveYAt = (nx: number, layer: number) => {
        const envelope = Math.pow(Math.max(0, Math.sin(nx * Math.PI)), 0.72);
        const primary = Math.sin(nx * TAU * 1.35 + motionTime * 3.4) * 0.62;
        const detail = Math.sin(nx * TAU * 3.1 - motionTime * 2.05 + layer * 0.8) * 0.38;
        return cy + (primary + detail) * plasmaR * 0.23 * envelope + layer * 0.55;
      };

      if (voiceBlend > 0.02) {
        for (const layer of [-1, 1]) {
          ctx.beginPath();
          for (let step = 0; step <= 56; step += 1) {
            const nx = step / 56;
            const x = cx + (nx - 0.5) * plasmaR * 1.72;
            const y = waveYAt(nx, layer);
            if (step === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsla(${layer < 0 ? current.hueA : current.hueB}, 100%, 76%, ${voiceBlend * 0.34})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }

      const count =
        m === "offline"
          ? 10
          : m === "thinking"
            ? 64
            : m === "listening"
              ? 56
              : m === "speaking"
                ? 52
                : m === "working"
                  ? 54
                  : 42;
      for (let i = 0; i < count; i += 1) {
        const seed = i * 0.61803398875;
        const depth = ((i * 17) % 31) / 30;
        const radius =
          plasmaR *
          (0.16 + ((i * 37) % 67) / 100) *
          (0.78 + depth * 0.32) *
          (i % 9 === 0 ? 1.42 : 1) *
          (m === "listening" ? 1 + smoothedLevel * 0.08 : 1);
        const direction = i % 3 === 0 ? -1 : 1;
        const angle = seed * TAU + (still ? 0 : t * (0.055 + current.drift * direction));
        const orbitX = cx + Math.cos(angle) * radius;
        const orbitY = cy + Math.sin(angle) * radius * (0.78 + ((i * 11) % 9) / 50);
        const trailAngle = angle - (still ? 0 : 0.06 + current.drift * 0.22) * direction;
        const trailX = cx + Math.cos(trailAngle) * radius;
        const trailY = cy + Math.sin(trailAngle) * radius * (0.78 + ((i * 11) % 9) / 50);
        const lane = (i + 0.5) / count;
        const waveX = cx + (lane - 0.5) * plasmaR * 1.72 + (((i * 7) % 5) - 2) * 0.16;
        const waveY = waveYAt(lane, i % 2 === 0 ? -1 : 1);
        const x = lerp(orbitX, waveX, voiceBlend);
        const y = lerp(orbitY, waveY, voiceBlend);
        const sparkle = still ? 0.65 : 0.42 + Math.sin(t * 1.7 + seed * 8) * 0.3;
        const dot = (0.42 + depth * 0.62 + ((i * 13) % 7) / 20) * (1 + voiceBlend * 0.16);
        const hue = lerpHue(current.hueA, current.hueB, voiceBlend > 0.25 ? lane : (i % 9) / 8);
        if (!still && voiceBlend < 0.2 && i % 2 === 0) {
          const tx = lerp(trailX, waveX, voiceBlend);
          const ty = lerp(trailY, waveY, voiceBlend);
          ctx.strokeStyle = `hsla(${hue}, 100%, 72%, ${0.05 + depth * 0.07})`;
          ctx.lineWidth = Math.max(0.45, dot * 0.5);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        if (voiceBlend > 0.36 && i % 5 === 0) {
          ctx.fillStyle = `hsla(${hue}, 100%, 68%, ${voiceBlend * 0.12})`;
          ctx.beginPath();
          ctx.arc(x, y, dot * 3.2, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = `hsla(${hue}, 100%, ${72 + (i % 3) * 4}%, ${Math.max(0.06, sparkle * current.rimAlpha)})`;
        ctx.beginPath();
        ctx.arc(x, y, dot, 0, TAU);
        ctx.fill();
        if (i % 7 === 0) {
          ctx.fillStyle = "rgba(255,255,255,.52)";
          ctx.beginPath();
          ctx.arc(x, y, dot * 0.38, 0, TAU);
          ctx.fill();
        }
      }

      if (m === "listening") {
        // A tiny radial meter makes microphone response legible without changing the outer geometry.
        const ticks = 44;
        ctx.translate(cx, cy);
        for (let i = 0; i < ticks; i += 1) {
          const angle = (i / ticks) * TAU;
          const wave = Math.abs(Math.sin(angle * 3 + motionTime * 2.1)) * smoothedLevel;
          const inner = plasmaR * 0.93;
          const outer = inner + 0.8 + wave * size * 0.055;
          ctx.beginPath();
          ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
          ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
          ctx.strokeStyle = `hsla(${current.hueB}, 100%, 78%, ${0.2 + wave * 0.72})`;
          ctx.lineWidth = i % 4 === 0 ? 1.2 : 0.65;
          ctx.stroke();
        }
        ctx.translate(-cx, -cy);
      }

      if (m === "thinking") {
        ctx.translate(cx, cy);
        for (let i = 0; i < 2; i += 1) {
          const spin = motionTime * (0.52 + i * 0.17) * (i === 0 ? 1 : -1);
          ctx.save();
          ctx.rotate(spin);
          ctx.strokeStyle = `hsla(${i === 0 ? current.hueB : current.hueA}, 100%, 79%, ${0.25 + current.swirl * 0.3})`;
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          ctx.ellipse(0, 0, plasmaR * (0.66 + i * 0.14), plasmaR * (0.23 + i * 0.035), 0, 0, TAU);
          ctx.stroke();
          const comet = plasmaR * (0.66 + i * 0.14);
          ctx.fillStyle = `hsla(${current.hueB}, 100%, 82%, .95)`;
          ctx.beginPath();
          ctx.arc(comet, 0, 1.6, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
        ctx.translate(-cx, -cy);
      }
      ctx.restore();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  return (
    <div ref={visualRef} className="sr-orb-visual" data-mode={mode} style={style}>
      <span className="sr-orb-aura" aria-hidden="true" />
      <span className="sr-orb-ripple sr-orb-ripple--one" aria-hidden="true" />
      <span className="sr-orb-ripple sr-orb-ripple--two" aria-hidden="true" />
      <span className="sr-orb-orbit sr-orb-orbit--one" aria-hidden="true" />
      <span className="sr-orb-orbit sr-orb-orbit--two" aria-hidden="true" />
      <span className="sr-orb-shell" aria-hidden="true" />
      <span className="sr-orb-plasma" aria-hidden="true">
        <canvas ref={canvasRef} className="sr-orb-canvas" />
      </span>
      <span className="sr-orb-sheen" aria-hidden="true" />
      <span className="sr-orb-rim sr-orb-rim--outer" aria-hidden="true" />
      <span className="sr-orb-rim sr-orb-rim--inner" aria-hidden="true" />
      <svg className="sr-orb-progress" viewBox="0 0 100 100" aria-hidden="true">
        <circle
          className="sr-orb-progress-track"
          cx="50"
          cy="50"
          r="46.5"
          pathLength="100"
        />
        <circle
          className={`sr-orb-progress-value${progressValue === undefined ? " sr-orb-progress-value--chase" : ""}`}
          cx="50"
          cy="50"
          r="46.5"
          pathLength="100"
          style={{
            strokeDasharray: `${Math.max(1, (progressValue ?? 0.35) * 100)} ${100 - Math.max(1, (progressValue ?? 0.35) * 100)}`,
          }}
        />
      </svg>
      <span
        className={`sr-orb-progress-spark${progressValue === undefined ? " sr-orb-progress-spark--chase" : ""}`}
        aria-hidden="true"
      />
    </div>
  );
}
