/**
 * waveform.peaksFor: library peaks first, decode only as the fallback.
 *
 * The counters are the point of the first test: a file the library knows must be drawn without a
 * single decodeAudioData call and without fetching the audio bytes at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { peaksFor, resetPeaksCacheForTest } from "../src/lib/waveform.ts";

const LIB_PATH = "/music/in-library.wav";
const OUTSIDE_PATH = "/music/not-in-library.wav";

/** Deterministic 64-bucket library fixture: a ramp up, a dip, a ramp down. */
const LIB_PEAKS = Array.from({ length: 64 }, (_, i) => {
  const t = i / 63;
  return Math.round((t < 0.5 ? t * 2 : (1 - t) * 2) * 1000) / 1000;
});

const state = { apiCalls: [], audioFetches: 0, decodes: 0, audioLength: 96000 };

function installStubs() {
  state.apiCalls = [];
  state.audioFetches = 0;
  state.decodes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/call") {
      const body = JSON.parse(init.body);
      state.apiCalls.push(`${body.server}.${body.tool}`);
      if (body.tool === "list_tracks") {
        return jsonResponse({ result: JSON.stringify({ tracks: [{ id: 7, path: LIB_PATH, title: "in-library" }] }) });
      }
      if (body.tool === "track_detail") {
        return jsonResponse({ result: JSON.stringify({ id: 7, path: LIB_PATH, peaks: LIB_PEAKS }) });
      }
      throw new Error(`unexpected tool ${body.tool}`);
    }
    state.audioFetches += 1;
    return new Response(new ArrayBuffer(16), { status: 200 });
  };
  globalThis.AudioContext = class {
    async decodeAudioData() {
      state.decodes += 1;
      const samples = new Float32Array(state.audioLength).fill(0.25);
      return { numberOfChannels: 1, length: state.audioLength, getChannelData: () => samples };
    }
    async close() {}
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("在库文件：用库的 64 桶，decodeAudioData 与音频 fetch 都是 0 次", async () => {
  installStubs();
  resetPeaksCacheForTest();
  const peaks = await peaksFor(LIB_PATH);
  assert.equal(peaks.length, 64);
  assert.equal(state.decodes, 0);
  assert.equal(state.audioFetches, 0);
  assert.deepEqual(state.apiCalls, ["library.list_tracks", "library.track_detail"]);
  // 形状与库 peaks 一致，只差 ÷loudest 的归一化
  const loudest = Math.max(...LIB_PEAKS);
  assert.deepEqual(peaks, LIB_PEAKS.map((p) => Math.min(1, p / loudest)));
  // 第二次命中缓存：API 调用不再增加
  const again = await peaksFor(LIB_PATH);
  assert.equal(again, peaks);
  assert.deepEqual(state.apiCalls, ["library.list_tracks", "library.track_detail"]);
});

test("不在库的文件：回落现算，出 96 桶", async () => {
  installStubs();
  resetPeaksCacheForTest();
  const peaks = await peaksFor(OUTSIDE_PATH);
  assert.equal(state.decodes, 1);
  assert.equal(state.audioFetches, 1);
  assert.equal(peaks.length, 96);
  // 恒 0.25 的素材：归一化后每桶都是 1
  assert.ok(peaks.every((p) => p === 1));
});

test("在库但 peaks 为空（扫库时不是 WAV）：回落现算", async () => {
  installStubs();
  resetPeaksCacheForTest();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/call") {
      const body = JSON.parse(init.body);
      if (body.tool === "list_tracks") return jsonResponse({ result: JSON.stringify({ tracks: [{ id: 7, path: LIB_PATH }] }) });
      if (body.tool === "track_detail") return jsonResponse({ result: JSON.stringify({ id: 7, path: LIB_PATH, peaks: [] }) });
    }
    return original(url, init);
  };
  const peaks = await peaksFor(LIB_PATH);
  assert.equal(state.decodes, 1);
  assert.equal(peaks.length, 96);
});

test("桥不可达：索引落空，全部回落现算，不抛异常", async () => {
  installStubs();
  resetPeaksCacheForTest();
  globalThis.fetch = async (url) => {
    if (String(url) === "/api/call") throw new Error("bridge down");
    state.audioFetches += 1;
    return new Response(new ArrayBuffer(16), { status: 200 });
  };
  const peaks = await peaksFor(OUTSIDE_PATH);
  assert.equal(state.decodes, 1);
  assert.equal(peaks.length, 96);
});
