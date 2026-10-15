/**
 * 工程调性助手（#bitwig-adoption B 项）的单测：宽容解析（Am / A minor / 8A / C大调 / 升降号）、
 * 调外音判定、量化到调（并列向上、±1 优先、±2 保险丝）。解析不出 = 不标不动，老行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isInKey,
  outOfKeyNotes,
  parseProjectKey,
  scalePcs,
  snapNotesToKey,
  snapToKey,
} from "../src/lib/studio-key.ts";

test("parseProjectKey: 简写与全拼", () => {
  assert.deepEqual(parseProjectKey("Am"), { pc: 9, mode: "minor" });
  assert.deepEqual(parseProjectKey("am"), { pc: 9, mode: "minor" });
  assert.deepEqual(parseProjectKey("A minor"), { pc: 9, mode: "minor" });
  assert.deepEqual(parseProjectKey("C"), { pc: 0, mode: "major" });
  assert.deepEqual(parseProjectKey("F major"), { pc: 5, mode: "major" });
  assert.deepEqual(parseProjectKey("G maj"), { pc: 7, mode: "major" });
  assert.deepEqual(parseProjectKey("E min"), { pc: 4, mode: "minor" });
});

test("parseProjectKey: 中文与升降号（含 ♭/♯ 全角符号）", () => {
  assert.deepEqual(parseProjectKey("C大调"), { pc: 0, mode: "major" });
  assert.deepEqual(parseProjectKey("A小调"), { pc: 9, mode: "minor" });
  assert.deepEqual(parseProjectKey("F#m"), { pc: 6, mode: "minor" });
  assert.deepEqual(parseProjectKey("Db"), { pc: 1, mode: "major" });
  assert.deepEqual(parseProjectKey("B♭m"), { pc: 10, mode: "minor" });
  assert.deepEqual(parseProjectKey("G♯"), { pc: 8, mode: "major" });
  assert.deepEqual(parseProjectKey("c#m"), { pc: 1, mode: "minor" }); // C# minor → pc 1（原稿笔误 4=E）
});

test("parseProjectKey: Camelot 轮（A 面小调 / B 面大调）", () => {
  assert.deepEqual(parseProjectKey("8A"), { pc: 9, mode: "minor" }); // 8A = A minor
  assert.deepEqual(parseProjectKey("8B"), { pc: 0, mode: "major" }); // 8B = C major
  assert.deepEqual(parseProjectKey("1a"), { pc: 8, mode: "minor" }); // 1A = G# minor
  assert.deepEqual(parseProjectKey("5B"), { pc: 3, mode: "major" }); // 5B = Eb major
});

test("parseProjectKey: 看不懂就 null（空串 / 越界 Camelot / 非音名）", () => {
  assert.equal(parseProjectKey(null), null);
  assert.equal(parseProjectKey(undefined), null);
  assert.equal(parseProjectKey(""), null);
  assert.equal(parseProjectKey("   "), null);
  assert.equal(parseProjectKey("13A"), null);
  assert.equal(parseProjectKey("0B"), null);
  assert.equal(parseProjectKey("H"), null);
  assert.equal(parseProjectKey("C##"), null); // 双升号不在宽容范围
  assert.equal(parseProjectKey("大调"), null); // 只有级数没有音名
  assert.deepEqual(parseProjectKey("C# 大调"), { pc: 1, mode: "major" }); // 音名与级数间的空格算宽容
});

test("scalePcs / isInKey: C 大调与 A 小调同音列不同根", () => {
  assert.deepEqual([...scalePcs({ pc: 0, mode: "major" })].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual([...scalePcs({ pc: 9, mode: "minor" })].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.equal(isInKey({ pc: 0, mode: "major" }, 60), true); // C
  assert.equal(isInKey({ pc: 0, mode: "major" }, 61), false); // C#
  assert.equal(isInKey(null, 61), true); // 没调 = 什么音都行
});

test("outOfKeyNotes: 只数调外音，key 解析不出时一律不算", () => {
  const notes = [
    { id: "n1", start_ms: 0, end_ms: 100, midi: 60 },
    { id: "n2", start_ms: 0, end_ms: 100, midi: 61 },
    { id: "n3", start_ms: 0, end_ms: 100, midi: 67 },
    { id: "n4", start_ms: 0, end_ms: 100, midi: 70 }, // Bb4，C 大调外
  ];
  assert.deepEqual(outOfKeyNotes({ pc: 0, mode: "major" }, notes).map((n) => n.id), ["n2", "n4"]);
  assert.deepEqual(outOfKeyNotes(null, notes), []);
});

test("snapToKey: 调内不动，调外并列向上，±1 优先", () => {
  const cMajor = { pc: 0, mode: "major" };
  assert.equal(snapToKey(cMajor, 60), 60); // 调内不动
  assert.equal(snapToKey(cMajor, 61), 62); // C# 在 C/D 之间 → 向上到 D
  assert.equal(snapToKey(cMajor, 66), 67); // F# → G
  assert.equal(snapToKey(cMajor, 70), 71); // Bb → B（±1 向上优先于向下到 A）
  assert.equal(snapToKey(null, 61), 61); // 没调 = 原样
  const aMinor = { pc: 9, mode: "minor" };
  assert.equal(snapToKey(aMinor, 68), 69); // G# → A（小调导音倾向，向上）
  assert.equal(snapToKey(aMinor, 63), 64); // D# → E
});

test("snapNotesToKey: 整组吸附，其它字段保留；null key 原数组引用", () => {
  const notes = [
    { id: "n1", start_ms: 0, end_ms: 250, midi: 61, velocity: 90 },
    { id: "n2", start_ms: 250, end_ms: 500, midi: 64, velocity: 80 },
  ];
  const snapped = snapNotesToKey({ pc: 0, mode: "major" }, notes);
  assert.equal(snapped[0].midi, 62);
  assert.equal(snapped[0].velocity, 90);
  assert.equal(snapped[0].id, "n1");
  assert.equal(snapped[1].midi, 64); // 调内不动
  assert.equal(snapNotesToKey(null, notes), notes);
});
