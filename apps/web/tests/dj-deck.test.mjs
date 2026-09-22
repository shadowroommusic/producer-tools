/**
 * The DJ deck engine against a stub `AudioContext`.
 *
 * What matters: decode happens at load (the play button must answer instantly), seek is a
 * stop+start at an exact offset, the crossfade is an equal-power AudioParam curve (x=0 → A=1/B=0,
 * x=0.5 → both ≈0.7071), a re-started deck never double-voices, natural end is told apart from a
 * manual stop, preview never passes the crossfader, and the buffer cache evicts only idle entries —
 * never a deck's pinned track, never an in-flight decode.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferCache, DjMixer } from "../src/lib/dj-deck.ts";

class FakeParam {
  constructor() {
    this.value = 1;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.events.push(["set", value, time]);
    this.value = value;
  }
  cancelScheduledValues(time) {
    this.events.push(["cancel", time]);
  }
  setValueCurveAtTime(curve, time, duration) {
    this.events.push(["curve", Array.from(curve), time, duration]);
    this.value = curve[curve.length - 1]; // after the window the param rests at the curve's end
  }
}

class FakeGainNode {
  constructor() {
    this.gain = new FakeParam();
    this.connections = [];
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() {}
}

class FakeBufferSource {
  constructor() {
    this.buffer = null;
    this.started = [];
    this.stopped = 0;
    this.onended = null;
  }
  connect(node) {
    this.connectedTo = node;
    return node;
  }
  start(when, offset) {
    this.started.push([when, offset]);
  }
  stop() {
    this.stopped += 1;
    this.onended?.(); // browsers fire onended on stop(); the engine must tell this apart
  }
  end() {
    this.onended?.(); // test helper: the track played out naturally
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = "suspended";
    this.destination = new FakeGainNode();
    this.createdGains = [];
    this.createdSources = [];
    this.decoded = 0;
  }
  createGain() {
    const node = new FakeGainNode();
    this.createdGains.push(node);
    return node;
  }
  createBufferSource() {
    const source = new FakeBufferSource();
    this.createdSources.push(source);
    return source;
  }
  decodeAudioData(bytes) {
    this.decoded += 1;
    return Promise.resolve({ duration: bytes.byteLength / 100 }); // 100 bytes ↔ 1 second
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
}

function harness({ sizes = {}, events } = {}) {
  const context = new FakeAudioContext();
  const calls = [];
  const fetchFn = async (url) => {
    const path = new URL(url, "http://test").searchParams.get("path");
    calls.push(path);
    if (sizes[path] === null) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(sizes[path] ?? 100) };
  };
  const mixer = new DjMixer({ contextFactory: () => context, fetchFn, events });
  return { mixer, context, calls };
}

test("load decodes immediately, reports loading→ready, and is idempotent per path", async () => {
  const seen = [];
  const { mixer, calls } = harness({ events: { onDeckChange: (s) => seen.push([s.state, s.path]) } });
  const deck = mixer.deck("A");
  await deck.load("/a.wav");
  assert.equal(deck.snapshot().state, "ready");
  assert.deepEqual(seen.map(([state]) => state), ["loading", "ready"]);
  await deck.load("/a.wav"); // same path: no second fetch, no state churn
  assert.equal(calls.filter((p) => p === "/a.wav").length, 1);
  assert.equal(seen.length, 2);
});

test("two decks loading the same path share one fetch and one decode", async () => {
  const { mixer, context, calls } = harness();
  await Promise.all([mixer.deck("A").load("/same.wav"), mixer.deck("B").load("/same.wav")]);
  assert.equal(calls.length, 1);
  assert.equal(context.decoded, 1);
  assert.equal(mixer.deck("A").snapshot().state, "ready");
  assert.equal(mixer.deck("B").snapshot().state, "ready");
});

test("play/pause position math stays under 5ms against the context clock", async () => {
  const { mixer, context } = harness({ sizes: { "/a.wav": 300 } }); // 3.0s
  const deck = mixer.deck("A");
  await deck.load("/a.wav");
  context.currentTime = 10;
  deck.play();
  assert.equal(deck.snapshot().state, "playing");
  context.currentTime = 10.5;
  assert.ok(Math.abs(deck.positionMs() - 500) < 5, `positionMs=${deck.positionMs()}`);
  deck.pause();
  assert.equal(deck.snapshot().state, "ready");
  context.currentTime = 12; // paused: position must not move
  assert.ok(Math.abs(deck.positionMs() - 500) < 5);
});

test("seek while playing restarts the source at the exact offset and clamps to duration", async () => {
  const { mixer, context } = harness({ sizes: { "/a.wav": 300 } });
  const deck = mixer.deck("A");
  await deck.load("/a.wav");
  context.currentTime = 5;
  deck.play();
  deck.seekMs(2000);
  assert.equal(context.createdSources.length, 2);
  assert.equal(context.createdSources[0].stopped, 1, "the old source must be stopped");
  assert.equal(context.createdSources[1].started[0][1], 2.0, "start(0, offset) in seconds");
  assert.ok(Math.abs(deck.positionMs() - 2000) < 5);
  deck.seekMs(99999);
  assert.equal(deck.positionMs(), 3000, "seek clamps to duration");
});

test("no double-voicing: every play pair stops the previous source exactly once", async () => {
  const { mixer, context } = harness();
  const deck = mixer.deck("A");
  await deck.load("/a.wav");
  deck.play();
  deck.play(); // no-op while playing
  assert.equal(context.createdSources.length, 1);
  deck.pause();
  deck.play();
  assert.equal(context.createdSources.length, 2);
  assert.equal(context.createdSources[0].stopped, 1);
  assert.equal(context.createdSources[1].stopped, 0);
});

test("natural end vs manual stop (driven through the stub source)", async () => {
  const ended = [];
  const { mixer, context } = harness({ events: { onEnded: (id) => ended.push(id) } });
  const deck = mixer.deck("A");
  await deck.load("/a.wav");
  deck.play();
  context.createdSources[0].end(); // played out
  assert.deepEqual(ended, ["A"]);
  assert.equal(deck.snapshot().state, "ready");
  assert.equal(deck.positionMs(), 0);
  deck.play();
  deck.pause(); // manual stop: must not emit ended
  deck.seekMs(100);
  deck.play();
  deck.pause();
  assert.deepEqual(ended, ["A"]);
});

test("crossfade is an equal-power curve: x=0.5 → both ≈0.7071, x=0 → A=1/B=0", async () => {
  const { mixer } = harness();
  const { a, b } = mixer.crossfadeParams();
  assert.ok(Math.abs(a.value - Math.SQRT1_2) < 0.001 && Math.abs(b.value - Math.SQRT1_2) < 0.001, "initial center");
  mixer.setCrossfade(0);
  assert.ok(Math.abs(a.value - 1) < 0.001 && Math.abs(b.value - 0) < 0.001);
  mixer.setCrossfade(1);
  assert.ok(Math.abs(a.value - 0) < 0.001 && Math.abs(b.value - 1) < 0.001);
  mixer.setCrossfade(0.5);
  assert.ok(Math.abs(a.value - 0.7071) < 0.001 && Math.abs(b.value - 0.7071) < 0.001);
  const last = a.events.at(-2);
  assert.equal(last[0], "cancel", "each move cancels the old automation first");
  const curve = a.events.at(-1);
  assert.equal(curve[0], "curve");
  assert.equal(curve[2], 0, "curve starts now (stub clock)");
  assert.equal(curve[3], 0.03, "30ms ramp");
});

test("preview deck bypasses the crossfader entirely", async () => {
  const { mixer, context } = harness();
  await mixer.deck("preview").load("/p.wav");
  mixer.deck("preview").setVolume(0.4);
  const master = context.createdGains.find((g) => g.connections.includes(context.destination));
  const previewOut = context.createdGains.find((g) => g.gain.value === 0.4);
  assert.ok(master, "master exists");
  assert.equal(previewOut.connections[0], master, "preview goes straight to master");
  const { a, b } = mixer.crossfadeParams();
  mixer.setCrossfade(0);
  assert.equal(a.value, 1);
  assert.equal(b.value, 0);
  assert.equal(previewOut.connections[0], master, "crossfade moves do not rewire preview");
});

test("deck volume is independent of the crossfader", async () => {
  const { mixer } = harness();
  await mixer.deck("A").load("/a.wav");
  const { a } = mixer.crossfadeParams();
  const before = a.value;
  mixer.deck("A").setVolume(0.3);
  assert.equal(a.value, before, "crossfade param untouched by deck volume");
});

test("cache evicts the idle LRU entry first and never a pinned one", async () => {
  const { mixer } = harness();
  await mixer.deck("A").load("/a.wav");
  await mixer.deck("B").load("/b.wav");
  await mixer.deck("preview").load("/p.wav");
  assert.equal(mixer.cache.size, 3);
  await mixer.deck("preview").load("/p2.wav"); // releases /p (idle) → evicted, not A/B's pins
  assert.equal(mixer.cache.size, 3);
  assert.ok(!mixer.cache.has("/p.wav"));
  assert.ok(mixer.cache.has("/a.wav") && mixer.cache.has("/b.wav") && mixer.cache.has("/p2.wav"));
});

test("cache never evicts pinned or in-flight entries, and may exceed the limit instead", async () => {
  let resolveSlow;
  const decode = (path) =>
    path === "/slow.wav" ? new Promise((resolve) => (resolveSlow = resolve)) : Promise.resolve({ duration: 1 });
  const cache = new BufferCache(3, decode);
  for (const path of ["/a", "/b", "/c"]) {
    const entry = cache.acquire(path);
    await entry.promise;
    cache.pin(entry);
  }
  cache.acquire("/slow.wav"); // in-flight: must not be evicted, and nothing pinned can go either
  assert.equal(cache.size, 4, "over-limit is allowed; interrupting a deck is not");
  resolveSlow({ duration: 1 });
  const idle = cache.acquire("/idle.wav");
  await idle.promise; // unpinned + done: now eviction may take it or nothing at all
  assert.ok(cache.has("/a") && cache.has("/b") && cache.has("/c") && cache.has("/slow.wav"));
});

test("a failed decode leaves state empty and does not poison the cache for a retry", async () => {
  const { mixer } = harness({ sizes: { "/bad.wav": null } });
  const deck = mixer.deck("A");
  await assert.rejects(deck.load("/bad.wav"));
  assert.equal(deck.snapshot().state, "empty");
  assert.ok(!mixer.cache.has("/bad.wav"));
});
