/**
 * 悬浮球语音反馈的纯逻辑（lib/orb-voice.ts）：感知映射 + 快攻慢放包络 + 视觉增益。
 * 离屏可验——只喂数字，不碰 DOM/Canvas。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VOICE_ATTACK_MS,
  VOICE_DECAY_MS,
  VOICE_SENSITIVITY,
  clamp01,
  perceiveVoiceLevel,
  stepVoiceEnvelope,
  voiceCoreGain,
  voiceShellGain,
  voiceWaveGain,
} from "../src/lib/orb-voice.ts";

test("感知映射：线性刻度抬起来，轻声可见、强音节压满", () => {
  assert.equal(perceiveVoiceLevel(0), 0);
  assert.equal(perceiveVoiceLevel(-1), 0);
  assert.equal(perceiveVoiceLevel(Number.NaN), 0);
  // smoothstep(clamp(x*2))
  assert.ok(Math.abs(perceiveVoiceLevel(0.125) - 0.15625) < 1e-9);
  assert.ok(Math.abs(perceiveVoiceLevel(0.25) - 0.5) < 1e-9);
  assert.equal(perceiveVoiceLevel(0.5), 1);
  assert.equal(perceiveVoiceLevel(1), 1);
  assert.ok(perceiveVoiceLevel(2) === 1, "超量程要钳住");
});

test("感知映射单调递增（不会忽大忽小）", () => {
  let last = -1;
  for (let raw = 0; raw <= 1.0001; raw += 0.01) {
    const v = perceiveVoiceLevel(raw);
    assert.ok(v >= last, `raw=${raw.toFixed(2)} 处非单调`);
    last = v;
  }
});

test("attack 比 decay 快：冲上去立刻到，收回来平滑落", () => {
  assert.ok(VOICE_ATTACK_MS < VOICE_DECAY_MS, "attack 必须比 decay 快");
  assert.ok(VOICE_ATTACK_MS <= 60, "attack 要快到能跟住音节");
  assert.ok(VOICE_DECAY_MS <= 120, "decay 不能长到让词间停顿一直亮着");
});

test("行为锁：220ms 的静音必须把包络落回 0.08 以内（验收 floor 口径）", () => {
  let env = 1;
  // 词间停顿约 220ms：这段静音结束时球必须基本回到静默，而不是卡在 0.2 上一直亮。
  for (let i = 0; i < 14; i += 1) env = stepVoiceEnvelope(env, 0, 16);
  assert.ok(env <= 0.08, `220ms 静音后应落回 <=0.08，实测 ${env.toFixed(3)}`);
});

test("行为锁：一个强音节 120ms 内要顶到 0.5 以上（一眼可见）", () => {
  let env = 0;
  for (let i = 0; i < 8; i += 1) env = stepVoiceEnvelope(env, 0.4, 16);
  assert.ok(env >= 0.5, `120ms 后应明显起来，实测 ${env.toFixed(3)}`);
});

test("包络：静音从 0 起，有声快速冲到高，静音后自然落回 0", () => {
  let env = 0;
  // 静音 200ms：保持 0
  for (let i = 0; i < 10; i += 1) env = stepVoiceEnvelope(env, 0, 16);
  assert.ok(env < 1e-6, `静音时应保持 0，实测 ${env}`);

  // 一个 300ms 的强音（RMS 0.4 → 感知 0.8）
  for (let i = 0; i < 19; i += 1) env = stepVoiceEnvelope(env, 0.4, 16);
  assert.ok(env > 0.5, `300ms 后应明显起来，实测 ${env.toFixed(3)}`);

  // 突然静音：回落但不骤降
  const before = env;
  const after = stepVoiceEnvelope(env, 0, 16);
  assert.ok(after < before, "静音后要回落");
  assert.ok(after > before * 0.5, `回落要平滑，不许骤降（${before.toFixed(3)}→${after.toFixed(3)}）`);
});

test("包络：帧率无关（同样时长，不同步长得到同一结果）", () => {
  const run = (dt, frames) => {
    let env = 0;
    for (let i = 0; i < frames; i += 1) env = stepVoiceEnvelope(env, 0.5, dt);
    return env;
  };
  const a = run(16, 30); // 480ms @60fps
  const b = run(8, 60); // 480ms @120fps
  const c = run(32, 15); // 480ms @30fps
  assert.ok(Math.abs(a - b) < 0.02, `60/120fps 差异过大：${a.toFixed(3)} vs ${b.toFixed(3)}`);
  assert.ok(Math.abs(a - c) < 0.02, `60/30fps 差异过大：${a.toFixed(3)} vs ${c.toFixed(3)}`);
});

test("包络：dt 巨大（切后台回来）不许瞬移到顶", () => {
  const huge = stepVoiceEnvelope(0, 1, 5000);
  const capped = stepVoiceEnvelope(0, 1, 64);
  assert.ok(huge < 0.85, `单帧不该瞬移，实测 ${huge.toFixed(3)}`);
  assert.ok(Math.abs(huge - capped) < 1e-9, "超长 dt 应当按上限当量处理");
});

test("包络输出恒在 0–1", () => {
  for (const raw of [0, 0.1, 0.5, 1, 5]) {
    for (const dt of [0, 1, 16, 100, 1000]) {
      const v = stepVoiceEnvelope(0.5, raw, dt);
      assert.ok(v >= 0 && v <= 1, `raw=${raw} dt=${dt} → ${v}`);
    }
  }
});

test("视觉增益：单调、钳位、幅度足够一眼看见", () => {
  assert.equal(voiceShellGain(0), 1);
  assert.ok(Math.abs(voiceShellGain(1) - 1.22) < 1e-9, "壳层要能撑开 22%");
  assert.ok(Math.abs(voiceWaveGain(1) - 0.16) < 1e-9, "声波要能伸到球径的 16%");
  assert.ok(Math.abs(voiceCoreGain(1) - 0.2) < 1e-9);
  assert.equal(voiceShellGain(-1), 1);
  assert.equal(voiceWaveGain(2), 0.16);
  assert.equal(voiceCoreGain(Number.NaN), 0);
});

test("clamp01：越界与非数都安全", () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(3), 1);
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(0.5), 0.5);
});

test("灵敏度常量与映射口径一致（改常量会改曲线，测试要能发现）", () => {
  assert.equal(VOICE_SENSITIVITY, 2);
  // 映射到 0.5 的原始电平 = 0.5 / 灵敏度（灵敏度改了就该跟着变，测试要能发现）
  assert.ok(Math.abs(perceiveVoiceLevel(0.5 / VOICE_SENSITIVITY) - 0.5) < 1e-9);
});
