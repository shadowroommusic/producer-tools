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
  notesRevision,
  quantiseNotes,
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
