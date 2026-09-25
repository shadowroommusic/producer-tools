/**
 * 悬浮球 v5 的五态参数表与色相插值（从 OrbGlass.tsx 拆出来：.tsx 进不了 node 单测）。
 * 通道分工见表头；任意两态至少在两个通道上不同（tests/orb.test.mjs 钉住）。
 */

export type OrbVisualMode = "idle" | "listening" | "speaking" | "thinking" | "working";

/** 五态参数表：drift 单位 turns/s；rimWidth 相对球半径；ripple/swirl/breathe 是强度开关。 */
export const ORB_STATES: Record<
  OrbVisualMode,
  { hueA: number; hueB: number; drift: number; rimAlpha: number; rimWidth: number; glow: number; breathe: number; wobble: number; ripple: number; swirl: number }
> = {
  idle: { hueA: 216, hueB: 282, drift: 0.02, rimAlpha: 0.55, rimWidth: 0.1, glow: 0.5, breathe: 0.035, wobble: 0.025, ripple: 0, swirl: 0 },
  listening: { hueA: 216, hueB: 282, drift: 0.06, rimAlpha: 0.82, rimWidth: 0.12, glow: 0.68, breathe: 0, wobble: 0.03, ripple: 0, swirl: 0 },
  speaking: { hueA: 152, hueB: 196, drift: 0.04, rimAlpha: 0.85, rimWidth: 0.11, glow: 0.72, breathe: 0, wobble: 0.03, ripple: 1, swirl: 0 },
  thinking: { hueA: 216, hueB: 300, drift: 0.55, rimAlpha: 0.9, rimWidth: 0.09, glow: 0.75, breathe: 0, wobble: 0.02, ripple: 0, swirl: 1 },
  working: { hueA: 216, hueB: 282, drift: 0.08, rimAlpha: 0.55, rimWidth: 0.1, glow: 0.55, breathe: 0, wobble: 0.025, ripple: 0, swirl: 0 },
};

/** 色相沿最短路径插值（350°→10° 走 +20° 而不是 -340°）。 */
export function lerpHue(a: number, b: number, t: number): number {
  const delta = (((b - a) % 360) + 540) % 360 - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}
