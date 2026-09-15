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
