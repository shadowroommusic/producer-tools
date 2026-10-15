/**
 * The voice call's two detectors, driven with synthetic loudness traces.
 *
 * These are the parts of the call that decide *when* something happens — when the user's turn is
 * over, and when talking over the answer counts as an interruption. They are pure functions on
 * purpose: the microphone and the speech engine cannot be scripted, the maths can.
 *
 * Run with `pnpm test` (Node's own test runner; the `.ts` import is type-stripped by Node 24).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnDetector } from "../src/lib/voice.ts";
import { createBargeInDetector, turnSilenceMs } from "../src/lib/bargein.ts";
import { rankVoices, splitSentences } from "../src/lib/tts.ts";

/** One animation frame is ~16 ms; build a trace out of (duration, level) segments. */
function frames(ms, level) {
  return Array.from({ length: Math.round(ms / 16) }, () => level);
}

/**
 * Feed a trace to a detector and collect the callbacks.
 * @param segments - `[ms, level]` pairs, in order.
 * @returns the events with the timestamp they fired at.
 */
function drive(segments, make) {
  const events = [];
  const clock = { now: 0 };
  const detector = make((name) => () => events.push([name, Math.round(clock.now)]));
  for (const [ms, level] of segments) {
    for (const value of frames(ms, level)) {
      detector.feed(value, clock.now);
      clock.now += 16;
    }
  }
  return { events, elapsed: clock.now };
}

test("a phrase ends the turn about 900 ms after the user stops", () => {
  const { events } = drive(
    [
      [2000, 0.02],
      [1600, 0.3],
      [1400, 0.02],
    ],
    (emit) => createTurnDetector({ onSpeechStart: emit("speech"), onTurnEnd: emit("end") }),
  );
  assert.deepEqual(
    events.map(([name]) => name),
    ["speech", "end"],
  );
  const [, speechAt] = events[0];
  const [, endAt] = events[1];
  const speechStartsAt = 2000;
  const speechEndsAt = speechStartsAt + 1600;
  assert.ok(Math.abs(speechAt - (speechStartsAt + 70)) < 60, `speech at ${speechAt}`);
  assert.ok(Math.abs(endAt - (speechEndsAt + 900)) < 120, `end at ${endAt}`);
});

test("a noisy room does not change when the turn ends", () => {
  const noisy = drive(
    [
      [2000, 0.07],
      [1600, 0.3],
      [1400, 0.07],
    ],
    (emit) => createTurnDetector({ onSpeechStart: emit("speech"), onTurnEnd: emit("end") }),
  );
  assert.deepEqual(
    noisy.events.map(([name]) => name),
    ["speech", "end"],
  );
});

test("a room with nobody talking never opens a turn", () => {
  const { events } = drive(
    [
      [3000, 0.05],
      [3000, 0.09],
    ],
    (emit) => createTurnDetector({ onTurnEnd: emit("end") }),
  );
  assert.deepEqual(events, []);
});

test("an answer does not interrupt itself, but a sentence over it cancels it", () => {
  const run = (segments) => {
    const events = [];
    const detector = createBargeInDetector({
      onPause: () => events.push("pause"),
      onCancel: () => events.push("cancel"),
    });
    detector.start(0);
    let now = 0;
    for (const [ms, level] of segments) {
      for (const value of frames(ms, level)) {
        detector.feed(value, now);
        now += 16;
      }
    }
    return events;
  };

  // The answer's own shape: loud, quiet between words, loud again. Nothing fires.
  assert.deepEqual(
    run([
      [3000, 0.22],
      [250, 0.03],
      [250, 0.22],
      [250, 0.03],
      [1000, 0.22],
      [400, 0.03],
    ]),
    [],
  );

  // A short bump above the baseline holds the answer (a cough), without cancelling it.
  const paused = run([[2000, 0.22], [150, 0.32], [400, 0.03]]);
  assert.deepEqual(paused, ["pause"]);

  // Talking over it cancels: the level is well above the answer's own leakage for 200 ms.
  const cancelled = run([[2000, 0.22], [250, 0.03], [250, 0.22], [500, 0.5]]);
  assert.equal(cancelled.includes("cancel"), true);
});

test("the endpointer waits less after a finished sentence and more after a dangling word", () => {
  assert.ok(turnSilenceMs("好，就这样。") < turnSilenceMs("我觉得这个"));
  assert.ok(turnSilenceMs("但是") > turnSilenceMs("我觉得这个"));
  assert.ok(turnSilenceMs("好，就这样。") >= 300, "but never instant: a pause is still a pause");
});

test("an answer is spoken sentence by sentence, not in one breath", () => {
  assert.deepEqual(splitSentences("第一句。第二句！第三句？"), ["第一句。", "第二句！", "第三句？"]);
  assert.deepEqual(splitSentences("一句话\n下一行"), ["一句话", "下一行"]);
  assert.deepEqual(splitSentences("   "), []);
});

test("the nicest voices a machine has come first, and nothing invented", () => {
  const available = [
    { voiceURI: "v1", name: "Some Robot", lang: "zh-CN" },
    { voiceURI: "v2", name: "Tingting", lang: "zh-CN" },
    { voiceURI: "v3", name: "Meijia", lang: "zh-CN" },
    { voiceURI: "v4", name: "Samantha", lang: "en-US" },
  ];
  assert.deepEqual(rankVoices(available, "zh").map((voice) => voice.label), ["Tingting", "Meijia", "Some Robot"]);
  assert.deepEqual(rankVoices(available, "en").map((voice) => voice.label), ["Samantha"]);
  assert.deepEqual(rankVoices([], "zh"), [], "a machine with no voices says so instead of guessing");
});

/**
 * 打断救话（MiniMax #356 的洞）：回合制通话里打断时说出的话，按起音时刻从音频缓冲切出来
 * 重新识别。这里测纯核心的两半——切片边界与起音时刻的传递。
 */
import { rescueRange } from "../src/lib/voice.ts";

test("rescueRange：空缓冲/全旧/跨块/未来起音/超长截断 五个边界", () => {
  // 空：marker 后一个块都没有 → 无可救，marker 不动（本来就到底了）
  assert.deepEqual(rescueRange([], 0, 0, 1000), { start: 0, marker: 0 });

  const stamps = [100, 200, 300, 400, 500];
  // 全旧：起音早于一切 → 从 marker 起全救（切片语义下界 = marker，已消费的不回头）
  assert.deepEqual(rescueRange(stamps, 0, 0, 600), { start: 0, marker: 5 });
  // 跨块：since=250 落在第 2 块(200) 与第 3 块(300) 之间 → 从 300 那块起（跨在起音上的块保进来）
  assert.deepEqual(rescueRange(stamps, 0, 250, 600), { start: 2, marker: 5 });
  assert.deepEqual(rescueRange(stamps, 0, 300, 600), { start: 2, marker: 5 }, "since 恰在块尾上 → 该块算起音后");
  // 未来：起音晚于一切已入队音频（钟差/极端情况）→ 无可救，但缓冲照旧消费光（尾巴不留给下一回合）
  assert.deepEqual(rescueRange(stamps, 0, 999, 600), { start: 5, marker: 5 });
  // marker 生效：已消费的块不回头救
  assert.deepEqual(rescueRange(stamps, 3, 150, 600), { start: 3, marker: 5 });

  // 超长：起音太老被 15s 上限截回 now-15000=3000 → 只救 3000 之后的块（8000 起，共 3 块）
  assert.deepEqual(rescueRange([1000, 8000, 16000, 17000], 0, 0, 18000), { start: 1, marker: 4 });
  // 上限内不干预：since=500, now=3000 → 不触发截断
  assert.deepEqual(rescueRange([400, 500, 600], 0, 500, 3000), { start: 1, marker: 3 });
});

test("barge-in cancel 带回起音时刻（救话切片的起点）", () => {
  const seen = [];
  const detector = createBargeInDetector({
    onCancel: (info) => seen.push(info.sinceMs),
  });
  detector.start(0);
  let now = 0;
  const feed = (ms, level) => {
    for (const _ of frames(ms, level)) {
      detector.feed(level, now);
      now += 16;
    }
  };
  // 答案自己的泄漏（默认阈值，前 300ms 校准基线）
  feed(1000, 0.2);
  // 咳嗽：高于 pause 但没撑到 cancel，然后落回
  feed(150, 0.45);
  feed(350, 0.2);
  // 真正的句子：持续高于 cancel 阈值 200ms
  const onset = now;
  feed(500, 0.6);
  assert.equal(seen.length, 1, "canceled exactly once");
  // 起音 = 这一轮连续高于 pause 的第一帧，不是咳嗽那次，也不是 cancel 判定时刻（onset+200 之后）
  assert.equal(seen[0], onset);
  assert.ok(seen[0] < now - 200, "and it is the onset, not the moment cancel was confirmed");
});
