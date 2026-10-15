/**
 * 悬浮球 v5 的五态参数表与色相插值（从 OrbGlass.tsx 拆出来：.tsx 进不了 node 单测）。
 * 通道分工见表头；任意两态至少在两个通道上不同（tests/orb.test.mjs 钉住）。
 */
import type { CallState } from "./call-states.ts";

/**
 * 球的外观状态七态：原来的五态 + Kimi UI 评审 F-1 新增的两种「通话异常」态——
 *   unclear（没听清，琥珀慢闪 + 横向晃动，与四态都不同）；offline（断线，灰、静止）。
 * 口径来自 docs/ui-review-kimi.md §③ F-1 / docs/ui-review-deepseek.md ②。
 */
export type OrbVisualMode = "idle" | "listening" | "speaking" | "thinking" | "working" | "unclear" | "offline";

/**
 * 通话五态 → 球的外观态（F-1 接线，唯一映射点）。
 *
 * 为什么单独一个函数：通话状态机在 App.tsx（红线文件），球在 ButlerOrb.tsx——两边各自
 * 「猜」映射就会出现 F-2 那种同屏两个词的老病。写在这里 = 纯函数、可单测、改一处。
 *   listening→listening / thinking→thinking / speaking→speaking
 *   unclear→unclear（琥珀晃，五态里唯一横向晃）
 *   offline→offline（灰、全静止、光晕熄灭——不是 idle：idle 仍有 0.02 漂移与呼吸）
 */
export function callOrbMode(state: CallState): OrbVisualMode {
  switch (state) {
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "unclear":
      return "unclear";
    case "offline":
      return "offline";
  }
}

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
  /**
   * 没听清：琥珀慢闪 + 明显横向晃动（wobble 全场最高、drift 慢），一眼区别于 listening 的呼吸。
   * 它是「请你再说一次」的邀请，不是错误——所以不熄灭、不红。
   */
  unclear: { hueA: 32, hueB: 52, drift: 0.12, rimAlpha: 0.8, rimWidth: 0.14, glow: 0.62, breathe: 0.05, wobble: 0.12, ripple: 0, swirl: 0 },
  /**
   * 断线：灰、静止——drift/breathe/wobble/swirl/ripple 全 0、glow 与 rimAlpha 压到最低。
   * 运动规则是「什么都不动」，与其余六态在任何一帧都看得出区别。
   */
  offline: { hueA: 210, hueB: 210, drift: 0, rimAlpha: 0.22, rimWidth: 0.06, glow: 0.12, breathe: 0, wobble: 0, ripple: 0, swirl: 0 },
};

/** 色相沿最短路径插值（350°→10° 走 +20° 而不是 -340°）。 */
export function lerpHue(a: number, b: number, t: number): number {
  const delta = (((b - a) % 360) + 540) % 360 - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}
