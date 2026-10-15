/**
 * 音色/采样浏览器纯逻辑（#bitwig-adoption D 项）的单测：GM128 名表完整性、拖拽 payload
 * 编解码（坏件一律 null）、过滤、试听音符造型、共享 <audio> 换 src 不新建。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GM_SOUNDS,
  SOUND_MIME,
  auditionNotes,
  auditionSample,
  decodeSoundDrag,
  encodeSoundDrag,
  filterSounds,
} from "../src/lib/studio-sounds.ts";

test("GM_SOUNDS: 128 项、program 连号、端点名字对、精选带中文一句话", () => {
  assert.equal(GM_SOUNDS.length, 128);
  assert.equal(GM_SOUNDS[0].name, "Acoustic Grand Piano");
  assert.equal(GM_SOUNDS[127].name, "Gunshot");
  assert.equal(GM_SOUNDS[73].name, "Flute");
  for (const [index, sound] of GM_SOUNDS.entries()) assert.equal(sound.program, index);
  assert.equal(GM_SOUNDS[0].hint, "原声钢琴，最通用");
  assert.equal(GM_SOUNDS[48].hint, "弦乐合奏，铺底");
  assert.equal(GM_SOUNDS[1].hint, undefined); // 非精选不硬编提示
  assert.ok(GM_SOUNDS.filter((sound) => sound.hint !== undefined).length >= 16);
});

test("encode/decodeSoundDrag: 音色与采样 roundtrip", () => {
  assert.deepEqual(
    decodeSoundDrag(encodeSoundDrag({ kind: "instrument", program: 40, name: "Violin" })),
    { kind: "instrument", program: 40, name: "Violin" },
  );
  assert.deepEqual(
    decodeSoundDrag(encodeSoundDrag({ kind: "sample", path: "/tmp/a.wav", name: "a.wav" })),
    { kind: "sample", path: "/tmp/a.wav", name: "a.wav" },
  );
});

test("decodeSoundDrag: 坏件一律 null（落点 handler 直接 return）", () => {
  assert.equal(decodeSoundDrag(""), null);
  assert.equal(decodeSoundDrag("not json"), null);
  assert.equal(decodeSoundDrag('{"kind":"instrument","program":-1,"name":"x"}'), null);
  assert.equal(decodeSoundDrag('{"kind":"instrument","program":128,"name":"x"}'), null);
  assert.equal(decodeSoundDrag('{"kind":"instrument","program":1.5,"name":"x"}'), null);
  assert.equal(decodeSoundDrag('{"kind":"instrument","program":40}'), null); // 缺 name
  assert.equal(decodeSoundDrag('{"kind":"sample","path":"","name":"x"}'), null); // 空 path
  assert.equal(decodeSoundDrag('{"kind":"sample","path":"/a.wav"}'), null); // 缺 name
  assert.equal(decodeSoundDrag('{"kind":"other","name":"x"}'), null);
});

test("filterSounds: 大小写不敏感子串；空 query 返回原数组引用", () => {
  const items = [{ name: "Violin" }, { name: "Viola" }, { name: "kick 808.wav" }];
  assert.deepEqual(filterSounds(items, "vio"), [{ name: "Violin" }, { name: "Viola" }]);
  assert.deepEqual(filterSounds(items, "KICK"), [{ name: "kick 808.wav" }]);
  assert.equal(filterSounds(items, ""), items);
  assert.equal(filterSounds(items, "   "), items);
  assert.deepEqual(filterSounds(items, "zzz"), []);
});

test("auditionNotes: 常规音色短琶音，Percussion 档密集短音，全长 <950ms", () => {
  const piano = auditionNotes(0);
  assert.deepEqual(piano.map((note) => note.midi), [60, 64, 67]);
  assert.ok(piano.every((note) => note.end_ms <= 850));
  for (const program of [111, 120]) {
    assert.deepEqual(auditionNotes(program).map((note) => note.midi), [60, 64, 67]);
  }
  for (const program of [112, 119]) {
    const perc = auditionNotes(program);
    assert.equal(perc.length, 3);
    assert.ok(perc.every((note) => note.end_ms - note.start_ms <= 90));
    assert.equal(perc.at(-1).midi, 67);
  }
});

test("auditionSample: 共享元素只换 src、归零、播一次；播放被拒不外抛", () => {
  const element = {
    src: "about:blank",
    currentTime: 5,
    played: 0,
    play() { this.played += 1; return Promise.resolve(); },
  };
  auditionSample(element, "/api/agent/file?path=%2Ftmp%2Fa.wav");
  assert.equal(element.src, "/api/agent/file?path=%2Ftmp%2Fa.wav");
  assert.equal(element.currentTime, 0);
  assert.equal(element.played, 1);
  const rejecting = { src: "", currentTime: 0, play: () => Promise.reject(new Error("autoplay")) };
  assert.doesNotThrow(() => auditionSample(rejecting, "/x.wav"));
});

test("SOUND_MIME: 与试凑区 MIME 不撞", async () => {
  const { SCRATCH_MIME } = await import("../src/lib/studio-scratch.ts");
  assert.notEqual(SOUND_MIME, SCRATCH_MIME);
});
