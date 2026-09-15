/**
 * The MIDI reader: a `.mid` dropped on the studio has to come out as notes in milliseconds.
 *
 * The files here are built byte by byte in the test, because that is the only way to pin the parts
 * that actually bite — running status, velocity-0 note-off, a tempo change halfway, and SMPTE time
 * division — without shipping binaries we cannot explain.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeDrums, midiLengthMs, parseMidiSong } from "../src/lib/midi.ts";
import { barsFromMilliseconds } from "../src/lib/studio.ts";

/** Build a Standard MIDI File from tracks of raw bytes. */
function midiFile({ format = 1, division = 480, tracks }) {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, (format >> 8) & 0xff, format & 0xff, 0, tracks.length, (division >> 8) & 0xff, division & 0xff];
  const body = tracks.flatMap((track) => {
    const length = track.length;
    return [0x4d, 0x54, 0x72, 0x6b, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...track];
  });
  return new Uint8Array([...header, ...body]);
}

const vlq = (value) => [value & 0x7f];

test("a type-1 file becomes one part per track, in milliseconds", () => {
  // Track 0: tempo 120 BPM + a name. Track 1: C4 for one beat. Track 2: two kicks on channel 10.
  const conductor = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xff, 0x2f, 0x00];
  const melody = [
    0x00, 0xff, 0x03, 0x04, 0x6c, 0x65, 0x61, 0x64, // name "lead"
    0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00,
  ];
  const drums = [
    0x00, 0x99, 0x24, 0x6e, 0x81, 0x70, 0x89, 0x24, 0x00, 0x81, 0x70, 0x99, 0x24, 0x6e, 0x81, 0x70, 0x89, 0x24, 0x00, 0x00, 0xff, 0x2f, 0x00,
  ];
  const song = parseMidiSong(midiFile({ tracks: [conductor, melody, drums] }));
  assert.equal(song.bpm, 120);
  assert.equal(song.ppq, 480);
  assert.equal(song.parts.length, 2, "the conductor track has no notes and is not a part");
  assert.equal(song.parts[0].name, "lead");
  assert.equal(song.parts[0].drums, false);
  assert.deepEqual(song.parts[0].notes, [{ midi: 60, start_ms: 0, end_ms: 500, velocity: 100 }]);
  assert.equal(song.parts[1].drums, true, "channel 10 is the drum channel");
  assert.deepEqual(song.parts[1].notes.map((n) => [n.midi, n.start_ms, n.end_ms]), [
    [36, 0, 250],
    [36, 500, 750],
  ]);
  assert.equal(midiLengthMs(song.parts), 750);
});

test("running status and velocity-0 note-off are read like every DAW reads them", () => {
  // One note-on, then a bare pitch+velocity pair (running status), then note-off as velocity 0.
  const track = [0x00, 0x90, 0x40, 0x50, 0x83, 0x60, 0x40, 0x00, 0x00, 0xff, 0x2f, 0x00];
  const song = parseMidiSong(midiFile({ format: 0, tracks: [track] }));
  assert.equal(song.parts.length, 1);
  assert.deepEqual(song.parts[0].notes, [{ midi: 64, start_ms: 0, end_ms: 500, velocity: 80 }]);
});

test("a tempo change halfway through is honoured, not averaged", () => {
  const conductor = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 120 BPM at tick 0
    0x87, 0x40, 0xff, 0x51, 0x03, 0x03, 0xd0, 0x90, // 960 ticks later: 240 BPM
    0x00, 0xff, 0x2f, 0x00,
  ];
  const melody = [
    0x87, 0x40, 0x90, 0x3c, 0x64, // note at tick 960 (1000 ms at 120 BPM)
    0x83, 0x60, 0x80, 0x3c, 0x40, // holds one beat at 240 BPM = 250 ms
    0x00, 0xff, 0x2f, 0x00,
  ];
  const song = parseMidiSong(midiFile({ tracks: [conductor, melody] }));
  assert.equal(song.parts[0].notes[0].start_ms, 1000);
  assert.equal(song.parts[0].notes[0].end_ms, 1250);
});

test("SMPTE time division falls back to clock time instead of pretending to be ticks", () => {
  // 0xE728: -25 frames/second, 40 ticks per frame → 1000 ticks per second.
  const track = [0x00, 0x90, 0x3c, 0x64, 0x87, 0x68, 0x80, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00];
  const song = parseMidiSong(midiFile({ format: 0, division: 0xe728, tracks: [track] }));
  assert.equal(song.smpte, true);
  assert.equal(song.bpm, undefined);
  assert.equal(song.parts[0].notes[0].end_ms, 1000);
});

test("a part that is a kit without the drum channel is still recognised as drums", () => {
  const kit = [36, 36, 38, 42, 42].map((midi) => ({ midi, start_ms: 0, end_ms: 10, velocity: 100 }));
  const melody = [60, 62, 64, 65, 67].map((midi) => ({ midi, start_ms: 0, end_ms: 10, velocity: 100 }));
  assert.equal(looksLikeDrums(kit, 0), true);
  assert.equal(looksLikeDrums(melody, 0), false);
});

test("a file that is not MIDI says so, in one sentence", () => {
  assert.throws(() => parseMidiSong(new Uint8Array([1, 2, 3, 4])), /MIDI/);
});

test("a stretch of milliseconds becomes bars, in seconds' worth", () => {
  // 1250 ms at 120 BPM is 1.25 s × 0.5 bars/s — one bar, not 625.
  assert.equal(barsFromMilliseconds(1250, 120), 1);
  assert.equal(barsFromMilliseconds(2500, 120), 2);
  assert.equal(barsFromMilliseconds(0, 120), 1, "a clip is never zero bars wide");
  assert.equal(barsFromMilliseconds(4000, 120), 2);
});
