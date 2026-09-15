/**
 * The studio's pure helpers: what an import becomes, and what a separation becomes.
 *
 * These decide the shape a user sees — one track per imported file, one track per stem — so they are
 * worth pinning down without a browser in the loop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisBadge,
  clipNoteRange,
  newNoteId,
  nudgeNotes,
  TRACK_COLORS,
  TRACK_OVERFLOW_LIMIT,
  canAddTracks,
  defaultTrackName,
  duplicateSection,
  drumVoice,
  nextTrackColor,
  overflowNotice,
  trackColor,
  trackOfType,
  trackTypeOf,
  insertBars,
  notesRevision,
  quantiseNotes,
  removeSection,
  repeatLastSection,
  structureRevision,
  trackFromImport,
  trackNameFromImport,
  tracksFromStems,
  transposeNotes,
  withNoteIds,
} from "../src/lib/studio.ts";

test("an import names its track after the file", () => {
  assert.equal(trackNameFromImport("/Users/dj/Music/Artist - Track (Extended Mix).mp3"), "Artist - Track (Extended Mix)");
  assert.equal(trackNameFromImport("song.flac"), "song");
  assert.equal(trackNameFromImport("/tmp/no-extension"), "no-extension");
});

test("an import gets its own track, and a taken name gets a number", () => {
  const first = trackFromImport("/tmp/Deep House.wav");
  assert.equal(first.name, "Deep House");
  assert.equal(first.clips.length, 1);
  assert.equal(first.clips[0].source, "/tmp/Deep House.wav");
  assert.equal(first.clips[0].start, 0);

  const second = trackFromImport("/tmp/Deep House.wav", ["Deep House"]);
  assert.equal(second.name, "Deep House 2");
  const third = trackFromImport("/tmp/Deep House.wav", ["Deep House", "Deep House 2"]);
  assert.equal(third.name, "Deep House 3");
});

test("the analysis badge only says what was actually detected", () => {
  assert.equal(analysisBadge(undefined), "");
  assert.equal(analysisBadge({}), "");
  assert.equal(analysisBadge({ bpm: 127.6 }), "128 BPM");
  assert.equal(analysisBadge({ camelot: "8A" }), "8A");
  assert.equal(analysisBadge({ bpm: 124, key: "Am", camelot: "8A" }), "124 BPM · 8A");
  assert.equal(analysisBadge({ bpm: Number.NaN, key: "Am" }), "Am");
});

test("a separation becomes four new tracks that keep the clip's place", () => {
  const stems = {
    vocals: "/stems/vocals.wav",
    drums: "/stems/drums.wav",
    bass: "/stems/bass.wav",
    other: "/stems/other.wav",
  };
  const existing = [
    { id: "t1", name: "鼓", muted: false, soloed: false, volume: 80, clips: [] },
    { id: "t2", name: "贝斯", muted: false, soloed: false, volume: 80, clips: [] },
  ];
  const created = tracksFromStems(stems, existing, { name: "Night Drive", start: 2, length: 8 });
  assert.deepEqual(
    created.map((track) => track.name),
    ["人声", "鼓 2", "贝斯 2", "其它"],
  );
  for (const track of created) {
    assert.equal(track.clips.length, 1);
    assert.equal(track.clips[0].start, 2);
    assert.equal(track.clips[0].length, 8);
    assert.match(track.clips[0].name, /Night Drive/);
  }
  assert.deepEqual(
    created.map((track) => track.clips[0].source),
    [stems.vocals, stems.drums, stems.bass, stems.other],
  );
  // four stems, four tracks — nothing merged into the tracks that already existed
  assert.equal(existing.every((track) => track.clips.length === 0), true);
});

test("notes transpose inside the MIDI range", () => {
  const notes = [{ midi: 60, start_ms: 0, end_ms: 100 }, { midi: 127, start_ms: 0, end_ms: 100 }];
  assert.deepEqual(
    transposeNotes(notes, 2).map((note) => note.midi),
    [62, 127],
  );
  assert.deepEqual(
    transposeNotes(notes, -12).map((note) => note.midi),
    [48, 115],
  );
});

test("quantise snaps both ends to the grid and never loses a note", () => {
  const notes = [{ midi: 60, start_ms: 130, end_ms: 260 }, { midi: 62, start_ms: 490, end_ms: 505 }];
  const snapped = quantiseNotes(notes, 125);
  assert.deepEqual(
    snapped.map((note) => [note.start_ms, note.end_ms]),
    [
      [125, 250],
      [500, 625],
    ],
  );
  // a note shorter than the grid still gets one grid unit
  const tiny = quantiseNotes([{ midi: 60, start_ms: 10, end_ms: 12 }], 125);
  assert.equal(tiny[0].end_ms - tiny[0].start_ms, 125);
});

test("nudging keeps every note inside the clip", () => {
  const notes = [{ midi: 60, start_ms: 0, end_ms: 500 }, { midi: 64, start_ms: 1000, end_ms: 1500 }];
  assert.deepEqual(
    nudgeNotes(notes, 400, 2000).map((note) => note.start_ms),
    [400, 1400],
  );
  // the clip is 2000ms long: the last note may move 500ms, not more
  assert.deepEqual(
    nudgeNotes(notes, 5000, 2000).map((note) => note.end_ms),
    [1000, 2000],
  );
  assert.deepEqual(
    nudgeNotes(notes, -5000, 2000).map((note) => note.start_ms),
    [0, 1000],
  );
});

test("the piano roll window fits the notes with room above and below", () => {
  assert.deepEqual(clipNoteRange([{ midi: 60, start_ms: 0, end_ms: 1 }]), { from: 58, to: 72 });
  assert.deepEqual(
    clipNoteRange([
      { midi: 40, start_ms: 0, end_ms: 1 },
      { midi: 79, start_ms: 0, end_ms: 1 },
    ]),
    { from: 38, to: 81 },
  );
  // an empty clip still shows an octave of keys
  assert.deepEqual(clipNoteRange([]), { from: 58, to: 72 });
});

test("notes get stable ids, and old ones are filled in without changing the rest", () => {
  const first = newNoteId();
  assert.notEqual(first, newNoteId());
  const filled = withNoteIds([{ midi: 60, start_ms: 0, end_ms: 10, id: "keep" }, { midi: 62, start_ms: 0, end_ms: 10 }]);
  assert.equal(filled[0].id, "keep");
  assert.equal(typeof filled[1].id, "string");
  assert.equal(filled[1].midi, 62);
});

test("a note revision changes exactly when a note changes", () => {
  const notes = [
    { id: "a", midi: 60, start_ms: 0, end_ms: 400, velocity: 100 },
    { id: "b", midi: 64, start_ms: 500, end_ms: 900, velocity: 90 },
  ];
  const revision = notesRevision(notes);
  assert.equal(notesRevision(notes.map((note) => ({ ...note }))), revision, "a copy is the same revision");
  assert.notEqual(notesRevision(notes.map((note) => ({ ...note, midi: 61 }))), revision);
  assert.notEqual(notesRevision(notes.map((note) => ({ ...note, velocity: 80 }))), revision);
  assert.notEqual(notesRevision(notes.map((note) => ({ ...note, start_ms: note.start_ms + 1 }))), revision);
  assert.notEqual(notesRevision([...notes, { id: "c", midi: 67, start_ms: 1000, end_ms: 1200 }]), revision);
  // order is not a change: the piano roll sorts, the revision must not care
  assert.equal(notesRevision([...notes].reverse()), revision);
});

/** A small arrangement: intro 4 bars (drums), drop 8 bars (drums + bass), outro 4 bars. */
function arrangement() {
  return {
    id: "p1",
    name: "结构",
    updatedAt: 0,
    bpm: 124,
    key: "8A",
    bars: 16,
    sections: [
      { id: "a", name: "intro", start: 0, bars: 4 },
      { id: "b", name: "drop", start: 4, bars: 8 },
      { id: "c", name: "outro", start: 12, bars: 4 },
    ],
    tracks: [
      { id: "t1", name: "鼓", muted: false, soloed: false, volume: 80, clips: [
        { id: "c1", name: "intro-drums", start: 0, length: 4, source: "/a.wav" },
        { id: "c2", name: "drop-drums", start: 4, length: 8, source: "/b.wav" },
        { id: "c3", name: "outro-drums", start: 12, length: 4, source: "/c.wav" },
      ] },
      { id: "t2", name: "贝斯", muted: false, soloed: false, volume: 80, clips: [
        { id: "c4", name: "drop-bass", start: 4, length: 8, source: "/d.wav" },
      ] },
    ],
  };
}

test("inserting bars pushes the arrangement right and leaves a named gap", () => {
  const next = insertBars(arrangement(), 12, 8, "breakdown");
  assert.equal(next.bars, 24);
  // the outro moved; the drop did not
  assert.deepEqual(
    next.sections.map((section) => [section.name, section.start, section.bars]),
    [
      ["intro", 0, 4],
      ["drop", 4, 8],
      ["breakdown", 12, 8],
      ["outro", 20, 4],
    ],
  );
  assert.deepEqual(
    next.tracks[0].clips.map((clip) => clip.start),
    [0, 4, 20],
  );
  // the bass only played the drop, so it stays put
  assert.deepEqual(next.tracks[1].clips.map((clip) => clip.start), [4]);
});

test("inserting inside a section grows it instead of splitting it", () => {
  const next = insertBars(arrangement(), 8, 4);
  assert.deepEqual(
    next.sections.map((section) => [section.name, section.start, section.bars]),
    [
      ["intro", 0, 4],
      ["drop", 4, 12],
      ["outro", 16, 4],
    ],
  );
  // clips after the insertion point still move
  assert.deepEqual(next.tracks[0].clips.map((clip) => clip.start), [0, 4, 16]);
});

test("repeating a section copies its clips and reuses the same audio files", () => {
  const next = duplicateSection(arrangement(), "b");
  assert.equal(next.bars, 24);
  const drums = next.tracks[0].clips;
  assert.deepEqual(drums.map((clip) => clip.start), [0, 4, 12, 20]);
  const copy = drums.find((clip) => clip.start === 12);
  assert.equal(copy.source, "/b.wav", "a repeat is a reference, not a second render");
  assert.notEqual(copy.id, "c2");
  assert.deepEqual(
    next.sections.map((section) => [section.name, section.start, section.bars]),
    [
      ["intro", 0, 4],
      ["drop", 4, 8],
      ["drop", 12, 8],
      ["outro", 20, 4],
    ],
  );
  // the bass repeat came along too
  assert.deepEqual(next.tracks[1].clips.map((clip) => clip.start), [4, 12]);
});

test("repeating the last section is the one-click version", () => {
  const next = repeatLastSection(arrangement());
  assert.equal(next.bars, 20);
  assert.deepEqual(next.tracks[0].clips.map((clip) => clip.start), [0, 4, 12, 16]);
});

test("removing a section deletes its clips and pulls the rest left", () => {
  const next = removeSection(arrangement(), "b");
  assert.equal(next.bars, 8);
  assert.deepEqual(next.sections.map((section) => [section.name, section.start]), [["intro", 0], ["outro", 4]]);
  assert.deepEqual(next.tracks[0].clips.map((clip) => clip.start), [0, 4]);
  assert.equal(next.tracks[1].clips.length, 0, "the bass lived in the drop");
});

test("the structure revision notices every structural change", () => {
  const base = structureRevision(arrangement());
  assert.equal(structureRevision(arrangement()), base);
  assert.notEqual(structureRevision(insertBars(arrangement(), 8, 4)), base);
  assert.notEqual(structureRevision(duplicateSection(arrangement(), "a")), base);
  assert.notEqual(structureRevision(removeSection(arrangement(), "c")), base);
  const moved = arrangement();
  moved.tracks[0].clips[0].start = 1;
  assert.notEqual(structureRevision(moved), base, "dragging a clip changes the arrangement");
});

test("track colours cycle in creation order so neighbours differ", () => {
  const tracks = [];
  for (let index = 0; index < 9; index += 1) {
    const track = trackOfType(tracks, "instrument");
    tracks.push(track);
  }
  assert.deepEqual(tracks.map((track) => track.color), [0, 1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(trackColor(tracks[0]), TRACK_COLORS[0]);
  assert.equal(trackColor(tracks[8]), TRACK_COLORS[0], "the palette cycles");
  assert.notEqual(trackColor(tracks[0]), trackColor(tracks[1]));
});

test("a track knows what it is, and older projects fall back to their name", () => {
  assert.equal(trackTypeOf({ ...trackOfType([], "drums") }), "drums");
  const notes = [{ id: "n", midi: 36, start_ms: 0, end_ms: 100 }];
  const clip = (withNotes) => ({ id: "c", name: "c", start: 0, length: 4, source: "/tmp/a.wav", ...(withNotes ? { notes } : {}) });
  assert.equal(
    trackTypeOf({ id: "x", name: "鼓", muted: false, soloed: false, volume: 80, clips: [clip(true)] }),
    "drums",
    "the synth's drum part is a drum track",
  );
  /**
   * The same name, no notes: that is a 鼓 *stem* from a separation — audio, and its double-click
   * must not open an editor with nothing in it.
   */
  assert.equal(
    trackTypeOf({ id: "x2", name: "鼓", muted: false, soloed: false, volume: 80, clips: [clip(false)] }),
    "audio",
  );
  assert.equal(
    trackTypeOf({ id: "y", name: "贝斯", muted: false, soloed: false, volume: 80, clips: [clip(true)] }),
    "instrument",
  );
  assert.equal(trackTypeOf({ id: "z", name: "Audio 2", muted: false, soloed: false, volume: 80, clips: [], type: "audio" }), "audio");
});

test("drums are named at the five pitches the kit actually has", () => {
  assert.equal(drumVoice(36)?.name, "Kick");
  assert.equal(drumVoice(36)?.zh, "底鼓");
  assert.equal(drumVoice(46)?.name, "Open hat");
  // 45 is a low tom in General MIDI — we never write it, so calling it a tom would be a lie.
  assert.equal(drumVoice(45), undefined);
  assert.equal(drumVoice(60), undefined);
});

test("the overflow notice counts what to delete, and says nothing inside the limit", () => {
  const many = (count) => Array.from({ length: count }, (_, index) => ({ id: `t${index}`, name: `T${index}`, muted: false, soloed: false, volume: 80, clips: [] }));
  assert.equal(overflowNotice(many(10)), undefined);
  assert.equal(
    overflowNotice(many(13)),
    "已临时扩展到 13 轨（分轨结果）。删除 3 条轨道后将自动恢复 10 轨上限。",
  );
  assert.equal(
    overflowNotice(many(11)),
    "已临时扩展到 11 轨（分轨结果）。删除 1 条轨道后将自动恢复 10 轨上限。",
  );
});

test("new track names are numbered per kind", () => {
  const tracks = [];
  const first = trackOfType(tracks, "drums");
  assert.equal(first.name, "鼓");
  tracks.push(first);
  const second = trackOfType(tracks, "drums");
  assert.equal(second.name, "鼓 2");
  tracks.push(second);
  assert.equal(trackOfType(tracks, "audio").name, "音频");
  assert.equal(trackOfType(tracks, "instrument").name, "乐器");
});

test("automatic additions may overflow to the hard limit, not past it", () => {
  const many = (count) => Array.from({ length: count }, (_, index) => ({ id: `t${index}`, name: `T${index}`, muted: false, soloed: false, volume: 80, clips: [] }));
  assert.equal(canAddTracks(many(6), 4), true, "10 tracks is fine");
  assert.equal(canAddTracks(many(10), 4), true, "stems may push a full project to 14");
  assert.equal(canAddTracks(many(11), 4), true, "11 + 4 lands exactly on the hard limit of 15");
  assert.equal(canAddTracks(many(12), 4), false, "12 + 4 would pass 15");
  assert.equal(canAddTracks(many(TRACK_OVERFLOW_LIMIT), 1), false);
});
