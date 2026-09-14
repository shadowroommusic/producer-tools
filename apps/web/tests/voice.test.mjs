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
import { createBargeIn, createTurnDetector } from "../src/lib/voice.ts";

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

test("an answer does not interrupt itself, and the user talking over it does", () => {
  const over = (segments) => {
    const events = [];
    const detector = createBargeIn({ onSpeak: () => events.push("interrupt") });
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

  // An answer that pauses between words: the pauses are its own, not an interruption.
  assert.deepEqual(
    over([
      [3000, 0.22],
      [250, 0.03],
      [250, 0.22],
      [250, 0.03],
      [1000, 0.22],
      [400, 0.03],
    ]),
    [],
  );

  // The same answer, but the user comes in over it.
  assert.deepEqual(
    over([
      [2000, 0.22],
      [250, 0.03],
      [250, 0.22],
      [250, 0.03],
      [500, 0.5],
    ]),
    ["interrupt"],
  );

  // Headphones: nothing leaks in, and a normal voice still gets through.
  assert.deepEqual(
    over([
      [2000, 0.01],
      [500, 0.2],
    ]),
    ["interrupt"],
  );
});
