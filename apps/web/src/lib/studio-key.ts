/**
 * 工程调性助手（#bitwig-adoption B 项）：「调性」输入框是自由文本，这里给一套宽容解析
 * （Am / A minor / 8A / C / F#m / Db / C大调 / A小调），以及量化到调与调外音标记要用的
 * 两张音阶表。只用自然小调（demo 常态；和声/旋律小调的临时升降号刻意不算调内——见裁决书 §② B）。
 */
import type { StudioNote } from "./studio";

export type ProjectKey = { pc: number; mode: "major" | "minor" };

const NOTE_TO_PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

/** Camelot 数字 → 根音 pitch class（A 面 = 小调，B 面 = 大调；与 library 仓的轮子同一张）。 */
const CAMELOT_A_PC: Record<number, number> = { 1: 8, 2: 3, 3: 10, 4: 5, 5: 0, 6: 7, 7: 2, 8: 9, 9: 4, 10: 11, 11: 6, 12: 1 };
const CAMELOT_B_PC: Record<number, number> = { 1: 11, 2: 6, 3: 1, 4: 8, 5: 3, 6: 10, 7: 5, 8: 0, 9: 7, 10: 2, 11: 9, 12: 4 };

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function parseProjectKey(text: string | null | undefined): ProjectKey | null {
  if (text === null || text === undefined) return null;
  const cleaned = text.trim().replace(/♭/g, "b").replace(/♯/g, "#");
  if (cleaned === "") return null;
  const camelot = /^(\d{1,2})([ABab])$/.exec(cleaned);
  if (camelot !== null) {
    const pc = (camelot[2].toUpperCase() === "A" ? CAMELOT_A_PC : CAMELOT_B_PC)[Number(camelot[1])];
    return pc === undefined ? null : { pc, mode: camelot[2].toUpperCase() === "A" ? "minor" : "major" };
  }
  const long = /^([A-Ga-g][#b]?)\s*(major|minor|maj|min|大调|小调)$/u.exec(cleaned);
  if (long !== null) {
    const pc = NOTE_TO_PC[long[1][0].toUpperCase() + long[1].slice(1)];
    if (pc === undefined) return null;
    return { pc, mode: /^(minor|min|小调)$/u.test(long[2]) ? "minor" : "major" };
  }
  const short = /^([A-Ga-g][#b]?)(m)?$/.exec(cleaned);
  if (short !== null) {
    const pc = NOTE_TO_PC[short[1][0].toUpperCase() + short[1].slice(1)];
    if (pc === undefined) return null;
    return { pc, mode: short[2] !== undefined ? "minor" : "major" };
  }
  return null;
}

export function scalePcs(key: ProjectKey): Set<number> {
  const scale = key.mode === "minor" ? MINOR_SCALE : MAJOR_SCALE;
  return new Set(scale.map((degree) => (key.pc + degree) % 12));
}

export function isInKey(key: ProjectKey | null, midi: number): boolean {
  if (key === null) return true;
  return scalePcs(key).has(((midi % 12) + 12) % 12);
}

/** 调外音清单（给 PianoRoll 标记与 clip 徽标用）；key 解析不出时一律不算调外。 */
export function outOfKeyNotes(key: ProjectKey | null, notes: StudioNote[]): StudioNote[] {
  if (key === null) return [];
  const scale = scalePcs(key);
  return notes.filter((note) => !scale.has(((note.midi % 12) + 12) % 12));
}

/** 最近的调内音高，并列时向上（小调的升六级/升七级倾向）；距离最多 ±1 半音，±2 是保险丝。 */
export function snapToKey(key: ProjectKey | null, midi: number): number {
  if (key === null) return midi;
  const scale = scalePcs(key);
  const pc = ((midi % 12) + 12) % 12;
  if (scale.has(pc)) return midi;
  for (const delta of [1, -1, 2, -2]) {
    if (scale.has(((pc + delta) % 12 + 12) % 12)) return midi + delta;
  }
  return midi;
}

export function snapNotesToKey(key: ProjectKey | null, notes: StudioNote[]): StudioNote[] {
  if (key === null) return notes;
  return notes.map((note) => ({ ...note, midi: snapToKey(key, note.midi) }));
}
