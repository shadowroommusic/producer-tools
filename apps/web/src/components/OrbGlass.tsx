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
import "../styles/orb-refine.css";

export type { OrbVisualMode } from "../lib/orb-states.ts";

const TAU = Math.PI * 2;
const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

const SPIN_SECONDS: Record<OrbVisualMode, number> = {
  idle: 32,
  listening: 20,
  speaking: 15,
  thinking: 8.5,
  working: 22,
  unclear: 24,
  offline: 0,
};

const MAX_MOTES = 112;
const GLOW_CACHE = new Map<string, HTMLCanvasElement>();
const PARTICLE_COLORS = Array.from({ length: 360 }, (_, hue) => `hsl(${hue} 100% ${79 + (hue % 3) * 3}%)`);
const MOTES = Array.from({ length: MAX_MOTES }, (_, index) => {
  const depth = ((index * 17) % 31) / 30;
  return {
    phase: index * 0.61803398875 * TAU,
    depth,
    radius: (0.16 + ((index * 37) % 67) / 100) * (0.78 + depth * 0.32) * (index % 9 === 0 ? 1.42 : 1),
    direction: index % 3 === 0 ? -1 : 1,
    verticalScale: 0.78 + ((index * 11) % 9) / 50,
    waveLayer: index % 2 === 0 ? -1 : 1,
    waveJitter: (((index * 7) % 5) - 2) * 0.16,
    dot: 0.82 + depth * 1.05 + ((index * 13) % 7) / 24,
    hueMix: (index % 9) / 8,
    twinkle: index * 0.61803398875 * 8,
    trail: index % 2 === 0,
    sparkle: index % 7 === 0,
  };
});

/**
 * The plasma used to allocate four radial gradients every frame. Glow is visually soft, so a
 * 160px sprite quantised to eight hue degrees is indistinguishable after scaling and skips the
 * allocation cost while the orb is on screen all day.
 */
function glowSprite(hue: number, kind: "lobe" | "core"): HTMLCanvasElement {
  const bucket = Math.round(hue / 8) * 8;
  const key = `${kind}:${bucket}`;
  const cached = GLOW_CACHE.get(key);
  if (cached !== undefined) return cached;
  const sprite = document.createElement("canvas");
  sprite.width = 160;
  sprite.height = 160;
  const context = sprite.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(80, 80, 0, 80, 80, 80);
    if (kind === "core") {
      gradient.addColorStop(0, `hsl(${bucket} 100% 97% / 0.96)`);
      gradient.addColorStop(0.18, `hsl(${bucket} 100% 84% / 0.72)`);
      gradient.addColorStop(0.46, `hsl(${bucket} 100% 68% / 0.22)`);
    } else {
      gradient.addColorStop(0, `hsl(${bucket} 100% 86% / 0.78)`);
      gradient.addColorStop(0.24, `hsl(${bucket} 100% 74% / 0.46)`);
      gradient.addColorStop(0.58, `hsl(${bucket} 100% 62% / 0.12)`);
    }
    gradient.addColorStop(1, `hsl(${bucket} 100% 58% / 0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 160, 160);
  }
  if (GLOW_CACHE.size >= 56) {
    const oldest = GLOW_CACHE.keys().next().value;
    if (oldest !== undefined) GLOW_CACHE.delete(oldest);
  }
  GLOW_CACHE.set(key, sprite);
  return sprite;
}

export function GlassSphere({
  size,
  mode,
  level,
  progress,
  reducedMotion,
  transitioning = false,
}: {
  size: number;
  mode: OrbVisualMode;
  /** 麦克风电平 0–1（listening 时驱动边宽与发光） */
  level: number;
  /** 干活进度 0–1；不给 = 不定态（酸绿弧追赶）。 */
  progress?: number;
  reducedMotion?: boolean;
  /** Opening/closing spends longer blending material states so the handshake reads as a morph. */
  transitioning?: boolean;
}) {
  const visualRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({ mode, level, progress, still: reducedMotion === true, transitioning });
  state.current = { mode, level, progress, still: reducedMotion === true, transitioning };
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
      const { mode: m, level: rawLevel, still, transitioning: morphing } = state.current;
      const motionTime = still ? 0 : t;
      const target = ORB_STATES[m] ?? ORB_STATES.idle;
      const k = morphing ? 0.035 : 0.095;
      current.hueA = lerpHue(current.hueA, target.hueA, k);
      current.hueB = lerpHue(current.hueB, target.hueB, k);
      current.drift = lerp(current.drift, target.drift, k);
      current.rimAlpha = lerp(current.rimAlpha, target.rimAlpha, k);
      current.glow = lerp(current.glow, target.glow, k);
      current.ripple = lerp(current.ripple, target.ripple, k);
      current.swirl = lerp(current.swirl, target.swirl, k);
      smoothedLevel +=
        (Math.max(0, Math.min(1, FINITE(rawLevel, 0))) - smoothedLevel) * (morphing ? 0.075 : 0.16);
      visualElement.style.setProperty("--orb-voice", smoothedLevel.toFixed(3));
      const voiceBlend = m === "speaking" ? smoothstep(current.ripple) : 0;
      const r = size / 2;
      const cx = r;
      const cy = r;
      const plasmaR = r * 0.51;
      ctx.clearRect(0, 0, size, size);

      // Three independently moving plasma lobes. They stay inside a circular clip so the hero rim
      // remains the crisp boundary instead of being softened by a large shadow.
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, plasmaR, 0, TAU);
      ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      const hueA = Math.round(current.hueA) % 360;
      const hueB = Math.round(current.hueB) % 360;
      for (let i = 0; i < 3; i += 1) {
        const phase = motionTime * (0.085 + i * 0.026) + i * 2.1;
        const x = cx + Math.cos(phase) * plasmaR * (0.18 + i * 0.065);
        const y = cy + Math.sin(phase * 1.13) * plasmaR * (0.15 + i * 0.05);
        const radius = plasmaR * (1.05 + current.glow * 0.24);
        ctx.globalAlpha = 0.74 + current.glow * 0.18;
        ctx.drawImage(glowSprite(i === 1 ? hueB : hueA, "lobe"), x - radius, y - radius, radius * 2, radius * 2);
      }
      const coreRadius = plasmaR * 0.96;
      ctx.globalAlpha = (0.76 + current.glow * 0.2) * (1 - voiceBlend * 0.3);
      ctx.drawImage(
        glowSprite(hueA, "core"),
        cx - coreRadius * 1.08,
        cy - coreRadius * 1.14,
        coreRadius * 2,
        coreRadius * 2,
      );
      ctx.globalAlpha = (0.34 + current.glow * 0.14) * (1 - voiceBlend * 0.24);
      ctx.drawImage(glowSprite(hueB, "core"), cx - coreRadius * 0.64, cy - coreRadius * 0.64, coreRadius * 1.28, coreRadius * 1.28);
      ctx.globalAlpha = 1;

      /**
       * Speaking is a material morph, not a second animation pasted on top. Every mote has a stable
       * orbital home and a stable lane on a horizontal waveform; `current.ripple` smoothly blends
       * between the two. The result reads as the same organism changing form instead of a waveform
       * appearing over unrelated particles.
       */
      const waveYAt = (nx: number, layer: number) => {
        const envelope = Math.pow(Math.max(0, Math.sin(nx * Math.PI)), 0.72);
        const primary = Math.sin(nx * TAU * 1.35 + motionTime * 1.18) * 0.62;
        const detail = Math.sin(nx * TAU * 3.1 - motionTime * 0.76 + layer * 0.8) * 0.38;
        return cy + (primary + detail) * plasmaR * 0.3 * envelope + layer * 0.9;
      };

      if (voiceBlend > 0.02) {
        for (const layer of [-1, 1]) {
          ctx.beginPath();
          for (let step = 0; step <= 56; step += 1) {
            const nx = step / 56;
            const x = cx + (nx - 0.5) * plasmaR * 1.96;
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
          ? 16
          : m === "thinking"
            ? 112
            : m === "listening"
              ? 104
              : m === "speaking"
                ? 88
                : m === "working"
                  ? 108
                  : m === "idle"
                    ? 96
                    : 104;
      const angularSpeed = 0.016 + current.drift * 0.24;
      ctx.strokeStyle = PARTICLE_COLORS[hueB];
      ctx.lineWidth = 0.8;
      for (let i = 0; i < count; i += 1) {
        const mote = MOTES[i];
        const depth = mote.depth;
        const radius =
          plasmaR * mote.radius *
          (still ? 1 : 1 + Math.sin(motionTime * 0.24 + mote.phase) * 0.025) *
          (m === "listening" ? 1 + smoothedLevel * 0.08 : 1);
        const direction = mote.direction;
        const angle =
          mote.phase +
          (still ? 0 : motionTime * angularSpeed * (0.72 + depth * 0.54) * direction);
        const orbitX = cx + Math.cos(angle) * radius;
        const orbitY = cy + Math.sin(angle) * radius * mote.verticalScale;
        const trailAngle = angle - (still ? 0 : 0.035 + current.drift * 0.08) * direction;
        const trailX = cx + Math.cos(trailAngle) * radius;
        const trailY = cy + Math.sin(trailAngle) * radius * mote.verticalScale;
        const lane = (i + 0.5) / count;
        const waveX = cx + (lane - 0.5) * plasmaR * 1.96 + mote.waveJitter;
        const waveY = waveYAt(lane, mote.waveLayer);
        const x = lerp(orbitX, waveX, voiceBlend);
        const y = lerp(orbitY, waveY, voiceBlend);
        const sparkle = still ? 0.82 : 0.72 + Math.sin(motionTime * 0.78 + mote.twinkle) * 0.2;
        const dot = mote.dot * (1 - voiceBlend * 0.42);
        const hue = Math.round(lerpHue(current.hueA, current.hueB, voiceBlend > 0.25 ? lane : mote.hueMix)) % 360;
        if (!still && voiceBlend < 0.2 && mote.trail) {
          const tx = lerp(trailX, waveX, voiceBlend);
          const ty = lerp(trailY, waveY, voiceBlend);
          ctx.strokeStyle = PARTICLE_COLORS[hue];
          ctx.globalAlpha = 0.08 + depth * 0.1;
          ctx.lineWidth = Math.max(0.55, dot * 0.42);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        if (voiceBlend > 0.36 && i % 5 === 0) {
          ctx.fillStyle = PARTICLE_COLORS[hue];
          ctx.globalAlpha = voiceBlend * 0.12;
          ctx.beginPath();
          ctx.arc(x, y, dot * 3.2, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = PARTICLE_COLORS[hue];
        ctx.globalAlpha =
          Math.max(0.2, Math.min(1, (0.3 + sparkle * 0.58) * current.rimAlpha)) * (1 - voiceBlend * 0.16);
        ctx.beginPath();
        ctx.arc(x, y, dot, 0, TAU);
        ctx.fill();
        if (mote.sparkle) {
          ctx.globalAlpha = 0.82;
          ctx.fillStyle = "rgba(255,255,255,.82)";
          ctx.beginPath();
          ctx.arc(x, y, dot * 0.5, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      if (m === "listening") {
        // A tiny radial meter makes microphone response legible without changing the outer geometry.
        const ticks = 44;
        ctx.translate(cx, cy);
        ctx.strokeStyle = PARTICLE_COLORS[hueB];
        for (let i = 0; i < ticks; i += 1) {
          const angle = (i / ticks) * TAU;
          const wave = Math.abs(Math.sin(angle * 3 + motionTime * 1.15)) * smoothedLevel;
          const inner = plasmaR * 0.93;
          const outer = inner + 0.8 + wave * size * 0.055;
          ctx.beginPath();
          ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
          ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
          ctx.globalAlpha = 0.2 + wave * 0.72;
          ctx.lineWidth = i % 4 === 0 ? 1.2 : 0.65;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.translate(-cx, -cy);
      }

      if (m === "thinking") {
        ctx.translate(cx, cy);
        for (let i = 0; i < 2; i += 1) {
          const spin = motionTime * (0.34 + i * 0.11) * (i === 0 ? 1 : -1);
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
      <span className="sr-orb-arc sr-orb-arc--one" aria-hidden="true" />
      <span className="sr-orb-arc sr-orb-arc--two" aria-hidden="true" />
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
