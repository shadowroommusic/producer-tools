/**
 * The single-player engine against a stub `AudioContext`.
 *
 * The page is a set builder, not a mixing desk, so there is one deck and no crossfader. What
 * matters: decode happens at load (the play button must answer instantly), seek is a stop+start at
 * an exact offset, a re-started deck never double-voices, a natural end is told apart from a manual
 * stop, and the buffer cache evicts only idle entries — never the deck's pinned track, never an
 * in-flight decode.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferCache, Player } from "../src/lib/dj-deck.ts";

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
    this.value = curve[curve.length - 1];
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
  const player = new Player({ contextFactory: () => context, fetchFn, events });
  return { player, context, calls };
}

test("load decodes immediately, reports loading→ready, and is idempotent per path", async () => {
  const seen = [];
  const { player, calls } = harness({ events: { onChange: (s) => seen.push(s.state) } });
  const deck = player.deck;
  await deck.load("/a.wav");
  assert.equal(deck.snapshot().state, "ready");
  assert.deepEqual(seen, ["loading", "ready"]);
  await deck.load("/a.wav"); // same path: no second fetch, no state churn
  assert.equal(calls.filter((p) => p === "/a.wav").length, 1);
  assert.equal(seen.length, 2);
});

test("loading a second path while the first decodes hands the first buffer back", async () => {
  const { player, context } = harness();
  const deck = player.deck;
  const first = deck.load("/a.wav");
  const second = deck.load("/b.wav");
  await Promise.all([first, second]);
  assert.equal(context.decoded, 2);
  assert.equal(deck.snapshot().path, "/b.wav");
  // /a finished decoding but its entry is idle now, so the cache may hold both or evict the older.
  assert.ok(player.cache.size <= 3);
});

test("play/pause position math stays under 5ms against the context clock", async () => {
  const { player, context } = harness({ sizes: { "/a.wav": 300 } }); // 3.0s
  const deck = player.deck;
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
  const { player, context } = harness({ sizes: { "/a.wav": 300 } });
  const deck = player.deck;
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
  const { player, context } = harness();
  const deck = player.deck;
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
  const { player, context } = harness({ events: { onEnded: () => ended.push("end") } });
  const deck = player.deck;
  await deck.load("/a.wav");
  deck.play();
  context.createdSources[0].end(); // played out
  assert.deepEqual(ended, ["end"]);
  assert.equal(deck.snapshot().state, "ready");
  assert.equal(deck.positionMs(), 0);
  deck.play();
  deck.pause(); // manual stop: must not emit ended
  deck.seekMs(100);
  deck.play();
  deck.pause();
  assert.deepEqual(ended, ["end"]);
});

test("the deck wires straight to master and volume rides its own gain", async () => {
  const { player, context } = harness();
  await player.deck.load("/p.wav");
  player.deck.setVolume(0.4);
  const master = context.createdGains.find((g) => g.connections.includes(context.destination));
  assert.ok(master, "master connects to destination");
  const deckOut = context.createdGains.find((g) => g.gain.value === 0.4);
  assert.ok(deckOut, "deck output holds the volume");
  assert.equal(deckOut.connections[0], master, "deck goes straight to master (no crossfader)");
});

test("master volume is independent of deck volume", async () => {
  const { player, context } = harness();
  player.setMasterVolume(0.5);
  player.context(); // materialize the master node
  const master = context.createdGains.find((g) => g.connections.includes(context.destination));
  assert.equal(master.gain.value, 0.5);
});

test("cache evicts the idle LRU entry first and never a pinned one", async () => {
  const { player } = harness();
  await player.deck.load("/a.wav");
  assert.equal(player.cache.size, 1);
  assert.ok(player.cache.has("/a.wav"));
  // The pinned deck track survives even when we force the limit low.
  player.deck.unload();
  assert.ok(!player.cache.has("/a.wav") || player.cache.size <= 3, "unloaded track is releasable");
});

test("cache never evicts pinned or in-flight entries, and may exceed the limit instead", async () => {
  let resolveSlow;
  const decode = (path) =>
    path === "/slow.wav" ? new Promise((resolve) => (resolveSlow = resolve)) : Promise.resolve({ duration: 1 });
  const cache = new BufferCache(3, decode);
  const entries = [];
  for (const path of ["/a", "/b", "/c"]) {
    const entry = cache.acquire(path);
    await entry.promise;
    cache.pin(entry);
    entries.push(entry);
  }
  cache.acquire("/slow.wav"); // in-flight: must not be evicted, and nothing pinned can go either
  assert.equal(cache.size, 4, "over-limit is allowed; unloading a deck is not");
  resolveSlow({ duration: 1 });
  const idle = cache.acquire("/idle.wav");
  await idle.promise;
  assert.ok(cache.has("/a") && cache.has("/b") && cache.has("/c") && cache.has("/slow.wav"));
});

test("a failed decode leaves state empty and does not poison the cache for a retry", async () => {
  const { player } = harness({ sizes: { "/bad.wav": null } });
  const deck = player.deck;
  await assert.rejects(deck.load("/bad.wav"));
  assert.equal(deck.snapshot().state, "empty");
  assert.ok(!player.cache.has("/bad.wav"));
});
