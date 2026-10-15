/**
 * 泵感调制（#bitwig-adoption 刀2 §②C）单测：三档节拍率换算、agent 写入路径纯函数、
 * 播放图零引用（gain_lfo 不出现在任何播放路径的源代码里——验收 c 的静态断言）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  GAIN_LFO_RATES,
  applyClipModulation,
  gainLfoRateHz,
  removeClipModulation,
} from "../src/lib/studio.ts";

const project = (clips) => ({
  id: "p1", name: "t", updatedAt: 0, bpm: 120, key: "", bars: 8,
  tracks: [{ id: "tr1", name: "a", clips }],
});
const clip = (id) => ({ id, name: id, start: 0, length: 2 });

test("gainLfoRateHz：三档节拍率按工程 BPM 折算（1 小节 @240bpm = 1Hz）", () => {
  assert.equal(gainLfoRateHz("1bar", 240), 1);
  assert.equal(gainLfoRateHz("1bar", 120), 0.5);
  assert.equal(gainLfoRateHz("1/2", 240), 2);
  assert.equal(gainLfoRateHz("1/4", 120), 2);
  // 档位表与换算一致：cycles-per-bar ÷ bar-seconds
  for (const [tier, cycles] of Object.entries(GAIN_LFO_RATES)) {
    assert.equal(gainLfoRateHz(tier, 128), cycles / (240 / 128));
  }
});

test("applyClipModulation：写入 rateHz+depth（钳到 0–1），别的 clip 不动", () => {
  const withMod = applyClipModulation(project([clip("a"), clip("b")]), "a", "1bar", 0.7);
  const a = withMod.tracks[0].clips.find((c) => c.id === "a");
  const b = withMod.tracks[0].clips.find((c) => c.id === "b");
  assert.deepEqual(a.gainLfo, { rateHz: 0.5, depth: 0.7 });
  assert.equal(b.gainLfo, undefined);
  // depth 越界钳制，不抛错
  const clamped = applyClipModulation(project([clip("a")]), "a", "1/2", 5);
  assert.equal(clamped.tracks[0].clips[0].gainLfo.depth, 1);
});

test("removeClipModulation：删字段且幂等，未动其它字段", () => {
  const withMod = applyClipModulation(project([{ ...clip("a"), fadeIn: 0.5 }]), "a", "1bar", 0.7);
  const removed = removeClipModulation(withMod, "a");
  assert.equal(removed.tracks[0].clips[0].gainLfo, undefined);
  assert.equal(removed.tracks[0].clips[0].fadeIn, 0.5);
  const again = removeClipModulation(removed, "a");
  assert.deepEqual(again.tracks[0].clips[0], removed.tracks[0].clips[0]);
});

test("验收 c（静态）：播放路径源码不出现 gainLfo/gain_lfo", () => {
  // 播放图 = clipGain/fadeGain/rampGain 的定义处与 rAF 走带；gain_lfo 只允许出现在
  // 类型/写入/导出/菜单四处。直接全文搜关键播放实现，命中即违规。
  const studio = readFileSync(new URL("../src/lib/studio.ts", import.meta.url), "utf8");
  const playbackHelpers = studio.slice(
    studio.indexOf("export function fadeGain"),
    studio.indexOf("// ---------- 泵感调制"),
  );
  assert.equal(playbackHelpers.includes("gainLfo"), false, "fadeGain/rampGain/clipGain 不得读 gainLfo");
  // 上面的切片覆盖 fadeGain/rampGain/clipGain 及其后所有播放辅助函数（到泵感注释为止）
  const page = readFileSync(new URL("../src/components/StudioPage.tsx", import.meta.url), "utf8");
  const players = page.slice(page.indexOf("// ---------- players"), page.indexOf("const clipVolume"));
  assert.equal(players.includes("gainLfo"), false, "players effect（每 clip 一个 <audio>）不得读 gainLfo");
});
