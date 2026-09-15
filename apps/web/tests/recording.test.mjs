/**
 * The two pure parts of recording: the shared microphone's reference count, and the click track's
 * scheduling maths.
 *
 * Neither test touches an audio device — that is the point. The microphone is faked, so the test can
 * prove that the stream is opened once and closed once, and the metronome is asked for the times it
 * *would* schedule, which is the part that decides whether the clicks line up.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { beatInBar, metronomeTimes } from "../src/lib/metronome.ts";

/** A MediaStream stand-in: tracks with a readyState, and a record of stop() calls. */
function fakeStream() {
  const stopped = [];
  const track = { readyState: "live", addEventListener: () => {}, stop: () => { stopped.push(true); track.readyState = "ended"; } };
  return { stream: { getAudioTracks: () => [track], getTracks: () => [track] }, stopped };
}

async function freshMic(stream) {
  // The module holds state, so each test imports a fresh copy with the fake device installed.
  globalThis.navigator ??= {};
  globalThis.navigator.mediaDevices = {
    getUserMedia: async () => {
      opens += 1;
      return stream;
    },
  };
  let opens = 0;
  const module = await import(`../src/lib/mic.ts?test=${Math.random()}`);
  return { module, opens: () => opens };
}

test("the microphone is opened once and closed when the last holder lets go", async () => {
  const device = fakeStream();
  const { module, opens } = await freshMic(device.stream);
  const first = await module.acquireMicrophone();
  const second = await module.acquireMicrophone();
  assert.equal(opens(), 1, "a second asker reuses the open stream");
  assert.equal(first, second);
  assert.equal(module.microphoneHolders(), 2);
  module.releaseMicrophone();
  assert.equal(device.stopped.length, 0, "the voice mode is still holding it");
  module.releaseMicrophone();
  assert.equal(device.stopped.length, 1, "the device closes with the last holder");
  assert.equal(module.currentMicrophone(), null);
});

test("releasing more times than acquiring never underflows", async () => {
  const device = fakeStream();
  const { module } = await freshMic(device.stream);
  module.releaseMicrophone();
  module.releaseMicrophone();
  assert.equal(module.microphoneHolders(), 0);
});

test("clicks land on the beat, and only inside the window being scheduled", () => {
  // 120 BPM = a click every 0.5 s. Window [0, 1.0) from a start of 0 → clicks at 0 and 0.5.
  assert.deepEqual(metronomeTimes(0, 1, 0, 120), [0, 0.5]);
  // A later window picks up exactly the clicks it owns, without repeating the earlier ones.
  assert.deepEqual(metronomeTimes(1, 2.25, 0, 120), [1, 1.5, 2]);
  // The count-in the studio schedules: four clicks before the take starts.
  assert.deepEqual(metronomeTimes(0.1, 2.2, 0.1, 120), [0.1, 0.6, 1.1, 1.6, 2.1]);
  assert.deepEqual(metronomeTimes(0, 1, 0, 0), [], "no tempo, no clicks");
  assert.deepEqual(metronomeTimes(2, 1, 0, 120), [], "an empty window schedules nothing");
});

test("every fourth click is the downbeat", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(beatInBar), [0, 1, 2, 3, 0, 1, 2, 3]);
});
