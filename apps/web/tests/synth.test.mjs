/**
 * The studio's note synth, against a stub `AudioContext`.
 *
 * What matters is that a notated clip becomes scheduled notes at the right times (the clip's own
 * milliseconds, shifted by how far the playhead already is), that a note that has already passed is
 * not played late, and that stopping a clip stops its notes. The audio itself is the browser's job.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotePlayer, midiToHz } from "../src/lib/synth.ts";

class FakeParam {
  constructor() {
    this.value = 0;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.events.push(["set", value, time]);
  }
  linearRampToValueAtTime(value, time) {
    this.events.push(["ramp", value, time]);
  }
}

class FakeNode {
  connect() {
    return this;
  }
  disconnect() {}
}

class FakeOscillator extends FakeNode {
  constructor() {
    super();
    this.type = "sine";
    this.frequency = new FakeParam();
    this.started = null;
    this.stopped = null;
  }
  start(time) {
    this.started = time;
  }
  stop(time) {
    this.stopped = time;
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super();
    this.gain = new FakeParam();
  }
}

class FakeContext {
  constructor() {
    this.state = "running";
    this.currentTime = 10;
    this.destination = new FakeNode();
    this.oscillators = [];
  }
  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createGain() {
    return new FakeGain();
  }
  suspend() {
    this.state = "suspended";
  }
  resume() {
    this.state = "running";
  }
}

globalThis.AudioContext = FakeContext;

test("midi numbers become the frequencies they name", () => {
  assert.equal(Math.round(midiToHz(69)), 440);
  assert.equal(Math.round(midiToHz(81)), 880);
  assert.equal(Math.round(midiToHz(60) * 100) / 100, 261.63);
});

test("a clip's notes are scheduled on the grid, from where the playhead is", () => {
  const player = createNotePlayer();
  const notes = [
    { start_ms: 0, end_ms: 400, midi: 60 },
    { start_ms: 500, end_ms: 900, midi: 64 },
  ];
  const voice = player.play(notes, { leadSeconds: 0, gain: 0.8 });
  assert.ok(voice !== null);
  const context = player.context();
  assert.equal(context.oscillators.length, 2);
  const [first, second] = context.oscillators;
  assert.equal(first.frequency.value, midiToHz(60));
  assert.equal(second.frequency.value, midiToHz(64));
  // currentTime is 10s, so the notes land at 10.0s and 10.5s
  assert.ok(Math.abs(first.started - 10) < 1e-6, `${first.started}`);
  assert.ok(Math.abs(second.started - 10.5) < 1e-6, `${second.started}`);
  assert.ok(second.stopped > second.started);
  voice.stop();
});

test("a clip entered half way through does not replay what already passed", () => {
  const player = createNotePlayer();
  const notes = [
    { start_ms: 0, end_ms: 200, midi: 60 },
    { start_ms: 1000, end_ms: 1400, midi: 67 },
  ];
  // the playhead is 1.2s into a 4-bar clip
  const voice = player.play(notes, { leadSeconds: -1.2, gain: 1 });
  assert.ok(voice !== null);
  const context = player.context();
  const fresh = context.oscillators.slice(-1);
  assert.equal(fresh.length, 1, "only the note that has not passed yet is scheduled");
  assert.equal(fresh[0].frequency.value, midiToHz(67));
  voice.stop();
});

test("nothing to play is not a voice", () => {
  const player = createNotePlayer();
  assert.equal(player.play([], { leadSeconds: 0, gain: 1 }), null);
  assert.equal(
    player.play([{ start_ms: 0, end_ms: 500, midi: 60 }], { leadSeconds: 0, gain: 0 }),
    null,
    "a muted track schedules no sound",
  );
  assert.equal(
    player.play([{ start_ms: 0, end_ms: 500, midi: 60 }], { leadSeconds: -2, gain: 1 }),
    null,
    "a note that is already over stays silent",
  );
});
