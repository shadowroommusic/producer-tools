/**
 * 悬浮球状态参数表：**七态**（五态 + F-1 的 unclear/offline）至少在两个通道上不同
 * （v4 的病就是 thinking/working 与 idle 撞脸）；lerpHue 走最短路径（350°→10° 走 +20°）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ORB_STATES, callOrbMode, lerpHue } from "../src/lib/orb-states.ts";

const MODES = ["idle", "listening", "speaking", "thinking", "working", "unclear", "offline"];
const CHANNELS = ["hueA", "hueB", "drift", "rimAlpha", "rimWidth", "glow", "breathe", "ripple", "swirl"];

test("七态齐全，且任意两态至少在两个通道上不同", () => {
  for (const mode of MODES) assert.ok(ORB_STATES[mode], `缺 ${mode}`);
  for (let i = 0; i < MODES.length; i += 1) {
    for (let j = i + 1; j < MODES.length; j += 1) {
      const a = ORB_STATES[MODES[i]];
      const b = ORB_STATES[MODES[j]];
      const differ = CHANNELS.filter((c) => Math.abs(a[c] - b[c]) > 1e-9).length;
      assert.ok(differ >= 2, `${MODES[i]} 与 ${MODES[j]} 只有 ${differ} 个通道不同`);
    }
  }
});

test("色相族分工：说话在青绿区，其余蓝紫区；思考追边最快；干活有独立通道", () => {
  assert.ok(ORB_STATES.speaking.hueA >= 140 && ORB_STATES.speaking.hueB <= 210, "speaking 应在青绿族");
  for (const mode of ["idle", "listening", "thinking", "working"]) {
    assert.ok(ORB_STATES[mode].hueA >= 200 && ORB_STATES[mode].hueB <= 335, `${mode} 应在蓝紫族`);
  }
  assert.ok(ORB_STATES.thinking.drift > ORB_STATES.idle.drift * 10, "思考追边必须一眼看出比空闲快");
  assert.ok(ORB_STATES.thinking.swirl > 0 && ORB_STATES.idle.swirl === 0, "旋流只属于思考");
  assert.ok(ORB_STATES.speaking.ripple > 0 && ORB_STATES.idle.ripple === 0, "波纹只属于说话");
});

test("F-1 新两态：没听清=琥珀晃、断线=灰且全静止", () => {
  assert.ok(ORB_STATES.unclear.hueA >= 25 && ORB_STATES.unclear.hueB <= 60, "unclear 应在琥珀族");
  assert.ok(ORB_STATES.unclear.wobble > ORB_STATES.listening.wobble * 2, "没听清的横向晃动要明显大于在听");
  assert.ok(ORB_STATES.offline.drift === 0 && ORB_STATES.offline.breathe === 0 && ORB_STATES.offline.wobble === 0, "断线全静止");
  assert.ok(ORB_STATES.offline.glow < ORB_STATES.idle.glow * 0.5, "断线要暗到一眼看出");
  assert.ok(ORB_STATES.offline.swirl === 0 && ORB_STATES.offline.ripple === 0, "断线不追边不起波");
});

test("F-1 接线：通话五态各自映射到不同的球态，没有落回 listening 的兜底", () => {
  const call = ["listening", "thinking", "speaking", "unclear", "offline"];
  const mapped = call.map((state) => callOrbMode(state));
  assert.deepEqual(mapped, ["listening", "thinking", "speaking", "unclear", "offline"]);
  assert.equal(new Set(mapped).size, 5, "五态必须映射到五个不同的球态（否则又是两态撞脸）");
});

test("运动通道专属守卫（MiniMax #387 ④）：通话五态不许只靠颜色分开", () => {
  /**
   * 上面那条统计的是全部 10 个通道，纯颜色差就能满足——色盲用户（约 8%）就分不出来了。
   * 这条只看运动五通道（drift/wobble/ripple/swirl/breathe）：
   *   任意两态之间，必须有**可感知**的运动差——MiniMax #393 ④ 打回第一版：只数「几个通道不同」
   *   会放过 drift 差 0.0001 这种肉眼为零的差异。所以口径改成幅度线：
   *   ① 存在某个连续运动通道 |差| ≥ 0.02（drift 单位 turns/s，0.02 ≈ 肉眼可辨的最小档），
   *      或 ② 开关类通道（ripple/swirl，0↔1）翻转。
   *   覆盖范围也扩到七态（#393 ④ 缺口 b）：原版只查通话五态，把 listening↔working 这对
   *   既有债放过去了——那条债已在 ORB_STATES.working.drift（0.08→0.16）里治掉。
   */
  const MOTION = ["drift", "wobble", "ripple", "swirl", "breathe"];
  const TOGGLES = ["ripple", "swirl"];
  const RAMP = ["drift", "wobble", "breathe"];
  const perceivable = (a, b) =>
    TOGGLES.some((c) => ORB_STATES[a][c] !== ORB_STATES[b][c]) ||
    RAMP.some((c) => Math.abs(ORB_STATES[a][c] - ORB_STATES[b][c]) >= 0.02);
  for (let i = 0; i < MODES.length; i += 1) {
    for (let j = i + 1; j < MODES.length; j += 1) {
      assert.ok(
        perceivable(MODES[i], MODES[j]),
        `${MODES[i]} 与 ${MODES[j]} 的运动差不可感知（幅度 <0.02 且无开关通道翻转）——只靠颜色分`,
      );
    }
  }
});

test("亮度梯度：听 > 思考 > 闲（暗处一眼分）", () => {
  assert.ok(ORB_STATES.listening.rimAlpha > ORB_STATES.thinking.rimAlpha - 0.15);
  assert.ok(ORB_STATES.thinking.rimAlpha > ORB_STATES.idle.rimAlpha);
  assert.ok(ORB_STATES.idle.breathe > 0 && ORB_STATES.listening.breathe === 0, "呼吸只属于空闲");
});

test("lerpHue：跨 0° 走最短路径", () => {
  assert.equal(lerpHue(350, 10, 0.5), 0);
  assert.equal(lerpHue(10, 350, 0.5), 0);
  assert.equal(lerpHue(100, 200, 0.5), 150);
  assert.equal(lerpHue(216, 216, 0.5), 216);
  const wrapped = lerpHue(350, 10, 1);
  assert.ok(wrapped === 10, `终点应到位，得 ${wrapped}`);
});
