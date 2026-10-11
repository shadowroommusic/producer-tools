/**
 * 悬浮球 v5 的五态参数表与色相插值（从 OrbGlass.tsx 拆出来：.tsx 进不了 node 单测）。
 * 通道分工见表头；任意两态至少在两个通道上不同（tests/orb.test.mjs 钉住）。
 */

export type OrbVisualMode = "idle" | "listening" | "speaking" | "thinking" | "working";

/** 五态参数表：drift 单位 turns/s；rimWidth 相对球半径；ripple/swirl/breathe 是强度开关。
 *  终验口径（orb-v5-acceptance ⑧）：五态同尺寸截图两两 mean-abs-diff ≥ 8/255——所以色相族
 *  按态错开（闲=钢蓝窄带 / 听=靛→紫宽亮边 / 说=青绿 / 思=紫→品红快追边 / 干=蓝底+酸绿弧），
 *  边宽与亮度也拉开梯度，不靠「同一族颜色只调亮度」糊弄。 */
export const ORB_STATES: Record<
  OrbVisualMode,
  { hueA: number; hueB: number; drift: number; rimAlpha: number; rimWidth: number; glow: number; breathe: number; wobble: number; ripple: number; swirl: number }
> = {
  idle: { hueA: 205, hueB: 235, drift: 0.02, rimAlpha: 0.5, rimWidth: 0.08, glow: 0.45, breathe: 0.035, wobble: 0.02, ripple: 0, swirl: 0 },
  listening: { hueA: 228, hueB: 300, drift: 0.06, rimAlpha: 0.88, rimWidth: 0.16, glow: 0.7, breathe: 0, wobble: 0.03, ripple: 0, swirl: 0 },
  speaking: { hueA: 140, hueB: 190, drift: 0.05, rimAlpha: 0.85, rimWidth: 0.12, glow: 0.72, breathe: 0, wobble: 0.03, ripple: 1, swirl: 0 },
  thinking: { hueA: 272, hueB: 318, drift: 0.55, rimAlpha: 0.9, rimWidth: 0.1, glow: 0.75, breathe: 0, wobble: 0.02, ripple: 0, swirl: 1 },
  working: { hueA: 210, hueB: 262, drift: 0.08, rimAlpha: 0.6, rimWidth: 0.1, glow: 0.55, breathe: 0, wobble: 0.025, ripple: 0, swirl: 0 },
};

/** 色相沿最短路径插值（350°→10° 走 +20° 而不是 -340°）。 */
export function lerpHue(a: number, b: number, t: number): number {
  const delta = (((b - a) % 360) + 540) % 360 - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}
