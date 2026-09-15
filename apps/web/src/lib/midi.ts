/**
 * Reading a Standard MIDI File.
 *
 * This is the one place a `.mid` becomes notes. It reads the bytes the user dropped and hands back
 * parts — one per MIDI track (format 1) or per channel (format 0) — in milliseconds, which is the
 * only unit the rest of the studio speaks (see `StudioNote`).
 *
 * Written here rather than taken from a library because it is a pure byte-in / notes-out function
 * that we can pin with tests, and because the alternative — a second parser, or a round trip to the
 * Python plugin and its interpreter — would be more moving parts for the same answer. It is
 * deliberately small: note on/off, running status, tempo changes, track names, and a fallback for
 * the SMPTE time division that almost nobody uses.
 */

/** One note, in the studio's own units. Ids are attached by the caller (`withNoteIds`). */
export type MidiNote = { midi: number; start_ms: number; end_ms: number; velocity: number };

/** One musical part: what became a track, and whether it looks like drums. */
export type MidiPart = { name: string; notes: MidiNote[]; drums: boolean; channel: number };

export type MidiSong = {
  /** The tempo the file starts at, if it says (0x51 meta event). */
  bpm: number | undefined;
  /** Ticks per beat, or the ticks-per-second equivalent for SMPTE files. */
  ppq: number;
  /** True when the file used SMPTE time division (then `bpm` is meaningless). */
  smpte: boolean;
  parts: MidiPart[];
};

/** Pitches a drum kit actually uses — used to guess whether a part is a鼓 part. */
const DRUM_PITCHES = new Set([35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 54, 56, 57, 59]);

type TempoPoint = { tick: number; usPerQuarter: number };

class Reader {
  index = 0;
  /** Node's TypeScript stripping does not transform parameter properties, so the field is declared. */
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get done(): boolean {
    return this.index >= this.data.length;
  }

  byte(): number {
    return this.data[this.index++];
  }

  peek(): number {
    return this.data[this.index];
  }

  take(count: number): Uint8Array {
    const slice = this.data.subarray(this.index, this.index + count);
    this.index += count;
    return slice;
  }

  ascii(count: number): string {
    return String.fromCharCode(...this.take(count));
  }

  uint16(): number {
    return (this.byte() << 8) | this.byte();
  }

  uint32(): number {
    return (this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte();
  }

  /** Variable-length quantity: seven bits per byte, high bit means "more". */
  vlq(): number {
    let value = 0;
    for (let count = 0; count < 4; count += 1) {
      const byte = this.byte();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }
}

/**
 * Is this part drums?
 *
 * Two signals, in order of trust: General MIDI puts drums on channel 10 (index 9), and a part whose
 * notes sit inside the kit's own range is almost certainly a beat even when it was exported on
 * another channel.
 */
export function looksLikeDrums(notes: MidiNote[], channel: number): boolean {
  if (channel === 9) return true;
  if (notes.length === 0) return false;
  const hits = notes.filter((note) => DRUM_PITCHES.has(note.midi)).length;
  return hits / notes.length >= 0.6;
}

/**
 * Parse a Standard MIDI File.
 * @param bytes - the whole file.
 * @returns its parts in milliseconds, plus the starting tempo when the file states one.
 * @throws when the file is not a MIDI file at all — the caller shows that sentence to the user.
 */
export function parseMidiSong(bytes: Uint8Array): MidiSong {
  const reader = new Reader(bytes);
  if (bytes.length < 14 || reader.ascii(4) !== "MThd") throw new Error("这不是一个 MIDI 文件（缺少 MThd）");
  const headerLength = reader.uint32();
  const format = reader.uint16();
  const declaredTracks = reader.uint16();
  const division = reader.uint16();
  // Skip anything the header declares beyond the six bytes we read.
  reader.index += Math.max(0, headerLength - 6);

  /**
   * Time division: the top bit says SMPTE (frames per second × ticks per frame), otherwise the
   * value is ticks per quarter note. SMPTE files have no tempo map to speak of, so we convert
   * straight to milliseconds with the frame rate and ignore any tempo events.
   */
  const smpte = (division & 0x8000) !== 0;
  let ticksPerSecond = 0;
  let ppq = 0;
  if (smpte) {
    const framesPerSecond = 256 - ((division >> 8) & 0xff);
    const ticksPerFrame = division & 0xff;
    ticksPerSecond = framesPerSecond * ticksPerFrame;
    ppq = 0;
  } else {
    ppq = division === 0 ? 480 : division;
  }

  const tempoPoints: TempoPoint[] = [];
  const rawTracks: Array<{ name?: string; notes: MidiNote[]; channel: number }> = [];

  for (let trackIndex = 0; trackIndex < declaredTracks && !reader.done; trackIndex += 1) {
    if (reader.index + 8 > bytes.length) break;
    const id = reader.ascii(4);
    const size = reader.uint32();
    const end = reader.index + size;
    if (id !== "MTrk") {
      reader.index = Math.min(end, bytes.length);
      continue;
    }

    let tick = 0;
    let runningStatus = 0;
    let name: string | undefined;
    const notes: MidiNote[] = [];
    /** Note-ons waiting for their note-off, keyed by channel + pitch; a queue, so repeats behave. */
    const sounding = new Map<string, Array<{ startTick: number; velocity: number }>>();
    let channel = 0;

    while (reader.index < end) {
      tick += reader.vlq();
      let status = reader.peek();
      if (status < 0x80) {
        // Running status: the previous status byte still applies.
        status = runningStatus;
      } else {
        reader.byte();
        if (status < 0xf0) runningStatus = status;
      }

      if (status === 0xff) {
        const type = reader.byte();
        const length = reader.vlq();
        const payload = reader.take(length);
        if (type === 0x51 && length >= 3) {
          const usPerQuarter = (payload[0] << 16) | (payload[1] << 8) | payload[2];
          if (usPerQuarter > 0) tempoPoints.push({ tick, usPerQuarter });
        } else if (type === 0x03 && payload.length > 0) {
          name = new TextDecoder().decode(payload).trim() || undefined;
        }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        // SysEx: a length, then that many bytes (we do not interpret them).
        reader.take(reader.vlq());
        continue;
      }

      const kind = status & 0xf0;
      channel = status & 0x0f;
      if (kind === 0x90 || kind === 0x80) {
        const pitch = reader.byte();
        const velocity = reader.byte();
        const key = `${channel}:${pitch}`;
        if (kind === 0x90 && velocity > 0) {
          const queue = sounding.get(key) ?? [];
          queue.push({ startTick: tick, velocity });
          sounding.set(key, queue);
        } else {
          const queue = sounding.get(key) ?? [];
          const started = queue.shift();
          if (started !== undefined) notes.push({ midi: pitch, start_ms: started.startTick, end_ms: tick, velocity: started.velocity });
        }
        continue;
      }
      if (kind === 0xc0 || kind === 0xd0) {
        reader.byte();
        continue;
      }
      // Everything else carries two data bytes (aftertouch, controllers, pitch bend).
      reader.byte();
      reader.byte();
    }
    reader.index = Math.min(end, bytes.length);

    /**
     * A note that never ends (a truncated file, or a player that only sent note-on) still deserves a
     * length — half a beat is the convention every DAW uses for that.
     */
    for (const [key, queue] of sounding) {
      const pitch = Number(key.split(":")[1]);
      for (const started of queue) {
        notes.push({ midi: pitch, start_ms: started.startTick, end_ms: tick + 1, velocity: started.velocity });
      }
    }
    if (notes.length > 0 || name !== undefined) rawTracks.push({ name, notes, channel });
  }

  // Ticks → milliseconds. Tempo events are global, and a file may change tempo mid-song.
  tempoPoints.sort((a, b) => a.tick - b.tick);
  const firstTempo = tempoPoints[0]?.usPerQuarter;
  const msAtTick = (tick: number): number => {
    if (smpte) return (tick / Math.max(1, ticksPerSecond)) * 1000;
    let ms = 0;
    let cursorTick = 0;
    let usPerQuarter = 500_000; // 120 BPM until the file says otherwise
    for (const point of tempoPoints) {
      if (point.tick >= tick) break;
      ms += ((point.tick - cursorTick) / ppq) * (usPerQuarter / 1000);
      cursorTick = point.tick;
      usPerQuarter = point.usPerQuarter;
    }
    ms += ((tick - cursorTick) / ppq) * (usPerQuarter / 1000);
    return ms;
  };

  const parts: MidiPart[] = [];
  if (format === 0) {
    /**
     * Format 0 packs every channel into one track. Splitting by channel is what a DAW does with it,
     * and it is the difference between "one track holding the whole song" and a usable arrangement.
     */
    const byChannel = new Map<number, MidiNote[]>();
    for (const track of rawTracks) {
      for (const note of track.notes) {
        const list = byChannel.get(track.channel) ?? [];
        list.push(note);
        byChannel.set(track.channel, list);
      }
    }
    for (const [channel, notes] of [...byChannel.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push({
        name: channel === 9 ? "鼓" : `通道 ${channel + 1}`,
        channel,
        drums: looksLikeDrums(notes, channel),
        notes: notes.map((note) => ({ ...note, start_ms: msAtTick(note.start_ms), end_ms: msAtTick(note.end_ms) })),
      });
    }
  } else {
    rawTracks
      .filter((track) => track.notes.length > 0)
      .forEach((track, index) => {
        const drums = looksLikeDrums(track.notes, track.channel);
        parts.push({
          /* A nameless drum track is 鼓 — that is what the user would call it, and the studio's own
             drum track is called that too. */
          name: track.name ?? (drums ? "鼓" : `轨道 ${index + 1}`),
          channel: track.channel,
          drums,
          notes: track.notes.map((note) => ({ ...note, start_ms: msAtTick(note.start_ms), end_ms: msAtTick(note.end_ms) })),
        });
      });
  }

  return {
    bpm: smpte || firstTempo === undefined ? undefined : Math.round((60_000_000 / firstTempo) * 100) / 100,
    ppq: smpte ? 0 : ppq,
    smpte,
    parts: parts.filter((part) => part.notes.length > 0),
  };
}

/** The last millisecond anything in the song sounds — the clip length a part should get. */
export function midiLengthMs(parts: MidiPart[]): number {
  return parts.reduce((end, part) => part.notes.reduce((inner, note) => Math.max(inner, note.end_ms), end), 0);
}
