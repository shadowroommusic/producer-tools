/**
 * Studio project model: a small multi-track arrangement, the way GarageBand / FL Studio lay one out.
 *
 * One project per browser for now (persisted), with tracks holding clips on a bar grid. Nothing in
 * here is audio yet — it is the arrangement the generated or imported files land in.
 */
import type { ToolCall } from "../components/ToolCallRow";

export type StudioClip = {
  id: string;
  name: string;
  /** Start position in bars (0 = the very beginning). */
  start: number;
  /** Length in bars. */
  length: number;
  /** Set when the clip stands for a file the user attached or the agent produced. */
  source?: string;
  /** Notes detected from a hummed take, drawn as a mini piano roll inside the clip. */
  notes?: StudioNote[];
  /** Tempo/key the importer detected, shown as a badge on the clip. */
  analysis?: StudioAnalysis;
  /** Where a separation job put this clip's stems — marks the clip as already split. */
  stemsDir?: string;
  /** Fade-in length in seconds, from the clip's first sample. Unset or 0 = no fade. */
  fadeIn?: number;
  /** Fade-out length in seconds, ending at the clip's last sample. Unset or 0 = no fade. */
  fadeOut?: number;
  /**
   * Set when the arrangement changed under this clip and its audio has not caught up yet.
   *
   * The structure tools never re-render anything by themselves: "加一个 breakdown" means the timeline
   * grows, not that every track starts rendering. A clip whose audio no longer matches its place says
   * so, and the user (or the agent) decides when to re-render it.
   */
  renderStale?: string;
  /**
   * How this clip's audio was made: the part spec the synth rendered it from.
   *
   * Kept on the clip (not in the agent's memory) because "make the drums heavier" has to change *one*
   * knob of the thing that already exists — without the plan, a re-render would be a new song.
   */
  render?: {
    bpm: number;
    bars: number;
    part: Record<string, unknown>;
    sections?: unknown[];
    seed?: number;
  };
};

/**
 * One note inside a clip.
 *
 * Milliseconds (not beats or ticks) because that is what the melody tool reports and what the
 * Web Audio synth and the MIDI writer already consume — the piano roll converts to the bar grid for
 * display, and stays compatible with everything that came before it.
 *
 * `id` is what makes the piano roll *editable*: an agent edit can name the notes it touched instead
 * of resending the whole array, and undo can move exactly those.
 */
export type StudioNote = {
  id?: string;
  start_ms: number;
  end_ms: number;
  midi: number;
  /** 1–127; the editor shows it as opacity, the MIDI writer passes it through. */
  velocity?: number;
  name?: string;
};

/** Default note length in the editor: one 16th. */
export const NOTE_STEP_MS = (bpm: number): number => 60_000 / Math.max(1, bpm) / 4;

let noteCounter = 0;
/** A stable id for a new note (`n1`, `n2`, …); derived here so tests can rely on the shape. */
export function newNoteId(): string {
  noteCounter += 1;
  return `n${Date.now().toString(36)}-${noteCounter}`;
}

/** Fill in the ids an older project (or a tool result) did not carry. */
export function withNoteIds(notes: StudioNote[]): StudioNote[] {
  return notes.map((note) => (note.id === undefined ? { ...note, id: newNoteId() } : note));
}

/** Transpose notes by semitones, clamped to the MIDI range. */
export function transposeNotes(notes: StudioNote[], semitones: number): StudioNote[] {
  return notes.map((note) => ({ ...note, midi: Math.max(0, Math.min(127, note.midi + semitones)) }));
}

/** Snap note starts (and the ends they imply) onto a grid of `stepMs`. */
export function quantiseNotes(notes: StudioNote[], stepMs: number): StudioNote[] {
  return notes.map((note) => {
    const start = Math.round(note.start_ms / stepMs) * stepMs;
    const length = Math.max(stepMs, Math.round((note.end_ms - note.start_ms) / stepMs) * stepMs);
    return { ...note, start_ms: Math.round(start), end_ms: Math.round(start + length) };
  });
}

/** Shift notes in time, keeping them inside the clip. */
export function nudgeNotes(notes: StudioNote[], deltaMs: number, lengthMs: number): StudioNote[] {
  const earliest = notes.reduce((value, note) => Math.min(value, note.start_ms), Infinity);
  const latest = notes.reduce((value, note) => Math.max(value, note.end_ms), 0);
  const shift = Math.max(-earliest, Math.min(deltaMs, Math.max(0, lengthMs - latest)));
  if (!Number.isFinite(shift) || shift === 0) return notes;
  return notes.map((note) => ({ ...note, start_ms: note.start_ms + shift, end_ms: note.end_ms + shift }));
}

/**
 * A cheap, stable revision for a note list.
 *
 * It travels with an agent's edit request and comes back with the result: if the user moved a note in
 * the meantime the revision differs and the app refuses the change instead of overwriting their work.
 * Derived from the notes themselves — no counter to keep in sync.
 * @param notes - the clip's notes, in any order.
 * @returns a short string that changes whenever a note changes.
 */
export function notesRevision(notes: StudioNote[]): string {
  let hash = 0x811c9dc5;
  const ordered = [...notes].sort(
    (a, b) => a.start_ms - b.start_ms || a.midi - b.midi || (a.id ?? "").localeCompare(b.id ?? ""),
  );
  for (const note of ordered) {
    const text = `${note.id ?? ""}:${note.midi}:${Math.round(note.start_ms)}:${Math.round(note.end_ms)}:${note.velocity ?? 100};`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `r${hash.toString(36)}`;
}

/**
 * Which keys the piano roll should draw: the notes' own span, padded, and never a sliver.
 *
 * An empty clip still shows a keyboard (middle C up an octave and a half), because a piano roll you
 * cannot click into is not an editor.
 * @param notes - the clip's notes.
 * @returns the lowest and highest MIDI note to draw, inclusive.
 */
export function clipNoteRange(notes: StudioNote[]): { from: number; to: number } {
  if (notes.length === 0) return { from: 58, to: 72 };
  const lowest = notes.reduce((value, note) => Math.min(value, note.midi), 127);
  const highest = notes.reduce((value, note) => Math.max(value, note.midi), 0);
  const from = Math.max(0, lowest - 2);
  return { from, to: Math.min(127, Math.max(highest + 2, from + 14)) };
}

/**
 * What the analysis plugin heard in one file: tempo and key, each with the confidence it had.
 *
 * The studio shows it on the clip (`128 BPM · 8A`) and, when the project was still empty, adopts the
 * tempo as the project's own — the difference between "a file sitting in a timeline" and "a project
 * that knows what it is".
 */
export type StudioAnalysis = { bpm?: number; key?: string; camelot?: string; confidence?: number };

/**
 * One named stretch of the song (`intro` / `drop` / …), as the arrangement tool reported it.
 *
 * It is what turns the ruler from "N bars" into "a song": the studio draws the boundaries and the
 * names, so a render the agent arranged from a sentence looks arranged.
 */
export type StudioSection = { id?: string; name: string; bars: number; start: number };

/**
 * Structure editing: inserting bars, repeating a section, cutting one out.
 *
 * The rules come from the arrangement itself, so they are pure functions over a project — the menus,
 * the agent's tool and the tests all describe the same three moves:
 *
 * - **insert** pushes everything at or after the insertion point to the right, extends the section it
 *   lands inside, and leaves a gap the user can fill;
 * - **duplicate** copies a section's clips (same audio files — a repeat is a reference, not a second
 *   render) and inserts the copy right after it;
 * - **remove** deletes the clips inside a section and pulls everything after it to the left.
 *
 * Sections are labels, not containers: dragging a clip never moves them (that is what makes the
 * strip trustworthy), while these three operations move them deliberately.
 */

/** Give every section a stable id, so menus, agent calls and undo all name the same thing. */
export function withSectionIds(project: StudioProject): StudioProject {
  if (project.sections === undefined || project.sections.length === 0) return project;
  if (project.sections.every((section) => section.id !== undefined)) return project;
  return {
    ...project,
    sections: project.sections.map((section, index) => ({
      ...section,
      id: section.id ?? `sec-${index}-${Math.round(section.start * 100)}`,
    })),
  };
}

/** A revision for the arrangement (sections + clip placement), used to refuse stale agent edits. */
export function structureRevision(project: { bars: number; sections?: StudioSection[]; tracks: StudioTrack[] }): string {
  let hash = 0x811c9dc5;
  const text = [
    `bars:${project.bars}`,
    ...(project.sections ?? []).map((section) => `s:${section.name}:${section.start}:${section.bars}`),
    ...project.tracks.flatMap((track) =>
      track.clips.map((clip) => `c:${track.name}:${clip.name}:${clip.start}:${clip.length}`),
    ),
  ].join("|");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `r${hash.toString(36)}`;
}

/** Shift every clip and section at or after `atBar` to the right. */
function shiftFrom(project: StudioProject, atBar: number, count: number): StudioProject {
  return {
    ...project,
    bars: project.bars + count,
    sections: project.sections?.map((section) =>
      section.start >= atBar
        ? { ...section, start: section.start + count }
        : section.start + section.bars > atBar
          ? { ...section, bars: section.bars + count }
          : section,
    ),
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => (clip.start >= atBar ? { ...clip, start: clip.start + count } : clip)),
    })),
  };
}

/**
 * Insert empty bars: a breakdown to fill, or room for a new section.
 * @param project - the project to change.
 * @param atBar - where the gap starts.
 * @param count - how many bars to insert.
 * @param name - what to call the new section (defaults to `段落 N`).
 */
export function insertBars(project: StudioProject, atBar: number, count: number, name?: string): StudioProject {
  const at = Math.max(0, Math.round(atBar));
  const bars = Math.max(1, Math.round(count));
  const shifted = shiftFrom(withSectionIds(project), at, bars);
  const sections = [...(shifted.sections ?? [])];
  const inside = sections.find((section) => section.start < at && section.start + section.bars > at);
  if (inside !== undefined) return shifted; // grew the section it landed in
  sections.push({
    id: `sec-${at}-${bars}-${sections.length}`,
    name: name?.trim() || `段落 ${sections.length + 1}`,
    start: at,
    bars,
  });
  sections.sort((a, b) => a.start - b.start);
  return { ...shifted, sections };
}

/**
 * Repeat a section right after itself — the same clips, the same audio files.
 *
 * Reusing the files is deliberate: "再来一遍副歌" is an arrangement decision, and a second render
 * would cost time and could come out slightly different.
 * @param project - the project to change.
 * @param sectionId - which section to repeat.
 * @returns the project with the copy inserted, or the project unchanged when the id is unknown.
 */
export function duplicateSection(project: StudioProject, sectionId: string): StudioProject {
  const withIds = withSectionIds(project);
  const source = (withIds.sections ?? []).find((section) => section.id === sectionId);
  if (source === undefined) return project;
  const from = source.start;
  const to = source.start + source.bars;
  const shifted = shiftFrom(withIds, to, source.bars);
  const stamp = Date.now().toString(36);
  const copies = shifted.tracks.map((track) => {
    const originals = track.clips.filter((clip) => clip.start >= from && clip.start < to);
    return {
      ...track,
      clips: [
        ...track.clips,
        ...originals.map((clip, index) => ({
          ...clip,
          id: `${clip.id}-x${stamp}${index}`,
          name: clip.name,
          start: clip.start + source.bars,
        })),
        // keep the lane readable (and every "first clip" assumption honest) after a repeat
      ].sort((a, b) => a.start - b.start),
    };
  });
  const sections = [...(shifted.sections ?? []), { ...source, id: `${source.id}-x${stamp}`, start: to, bars: source.bars }];
  sections.sort((a, b) => a.start - b.start);
  return { ...shifted, tracks: copies, sections };
}

/** Delete a section: its clips go away and everything after it moves left. */
export function removeSection(project: StudioProject, sectionId: string): StudioProject {
  const withIds = withSectionIds(project);
  const target = (withIds.sections ?? []).find((section) => section.id === sectionId);
  if (target === undefined) return project;
  const from = target.start;
  const to = target.start + target.bars;
  return {
    ...withIds,
    bars: Math.max(1, withIds.bars - target.bars),
    sections: (withIds.sections ?? [])
      .filter((section) => section.id !== sectionId)
      .map((section) => (section.start >= to ? { ...section, start: section.start - target.bars } : section)),
    tracks: withIds.tracks.map((track) => ({
      ...track,
      clips: track.clips
        .filter((clip) => clip.start < from || clip.start >= to)
        .map((clip) => (clip.start >= to ? { ...clip, start: clip.start - target.bars } : clip)),
    })),
  };
}

/** Repeat the last section — the one-click version of "再来一遍". */
export function repeatLastSection(project: StudioProject): StudioProject {
  const withIds = withSectionIds(project);
  const last = [...(withIds.sections ?? [])].sort((a, b) => a.start - b.start).at(-1);
  return last === undefined ? project : duplicateSection(withIds, last.id as string);
}

/** Bars per second at 4/4 — the bridge between wall-clock audio and the bar grid. */
export function barsPerSecond(bpm: number): number {
  return bpm / 4 / 60;
}

/**
 * How many bars a stretch of time covers at this tempo — at least one.
 *
 * Milliseconds, not seconds: the notes a MIDI file becomes are in milliseconds, and passing those
 * numbers to `barsPerSecond` directly is how an imported clip once came out 625 bars long (measured:
 * 1250 ms × 0.5, right number, wrong unit).
 */
export function barsFromMilliseconds(ms: number, bpm: number): number {
  return Math.max(1, Math.ceil((ms / 1000) * barsPerSecond(bpm)));
}

/** URL the browser can stream a local file from (the agent bridge serves it). */
export function fileUrl(path: string): string {
  return `/api/agent/file?path=${encodeURIComponent(path)}`;
}

/** Audio clips are the ones the transport can actually play. */
export function isPlayable(path: string | undefined): boolean {
  if (path === undefined || path === "") return false;
  return /\.(wav|mp3|m4a|aac|aif|aiff|flac|ogg|opus)$/i.test(path);
}

/**
 * What a track is for — and the only three differences that make it real:
 * what the piano roll shows, whether notes can be edited, and the default sound.
 */
export type StudioTrackType = "instrument" | "audio" | "drums";

export type StudioTrack = {
  id: string;
  name: string;
  muted: boolean;
  soloed: boolean;
  /** 0–100, the fader position. */
  volume: number;
  clips: StudioClip[];
  /** Set on creation (and by the renderer); older projects fall back to the name. */
  type?: StudioTrackType;
  /** Index into `TRACK_COLORS`, assigned in creation order so neighbours differ. */
  color?: number;
};

/**
 * Eight colours for a dark UI, hue-spaced so two neighbouring tracks never look alike.
 *
 * They are the only染色 in the app: a 4px bar beside the track name, a 3px left edge on the clip,
 * and the notes themselves. Nothing paints a whole surface — that is what makes a busy arrangement
 * still readable.
 */
export const TRACK_COLORS = [
  "#6EE7B7", // mint
  "#60A5FA", // blue
  "#F472B6", // pink
  "#FBBF24", // amber
  "#A78BFA", // violet
  "#34D399", // emerald
  "#FB923C", // orange
  "#94A3B8", // slate
] as const;

/** Tracks the user adds by hand; automatic additions (stems, imports) may go beyond, up to here. */
export const MAX_TRACKS = 10;
export const TRACK_OVERFLOW_LIMIT = 15;

/** The next colour in the cycle: creation order, so adjacent tracks differ. */
export function nextTrackColor(tracks: StudioTrack[]): number {
  return tracks.length % TRACK_COLORS.length;
}

/** The colour a track is drawn with, falling back to its position for older projects. */
export function trackColor(track: StudioTrack, index = 0): string {
  return TRACK_COLORS[(track.color ?? index) % TRACK_COLORS.length];
}

/**
 * What kind of track this is. Explicit when we set it, inferred from the name for older projects
 * (the synth's drum parts land on a track called 鼓).
 *
 * The inference also asks whether there are notes at all: an old project's 鼓 can be the synth's
 * drum part (notes: a drum track) or a 鼓 stem from a separation (audio, no notes). Getting that
 * wrong is not cosmetic — it decides whether the piano roll opens and whether the agent may edit.
 */
export function trackTypeOf(track: StudioTrack): StudioTrackType {
  if (track.type !== undefined) return track.type;
  const notated = track.clips.some((clip) => (clip.notes?.length ?? 0) > 0);
  if (!notated) return "audio";
  return /drum|kick|snare|clap|beat|鼓/i.test(track.name) ? "drums" : "instrument";
}

/** Default name for a new track of each kind; numbering keeps them apart. */
export function defaultTrackName(tracks: StudioTrack[], type: StudioTrackType): string {
  /* Track kinds are DAW vocabulary: Audio / Instrument / Drums. */
  const base = type === "drums" ? "Drums" : type === "audio" ? "Audio" : "Instrument";
  const taken = new Set(tracks.map((track) => track.name));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    if (!taken.has(`${base} ${index}`)) return `${base} ${index}`;
  }
  return `${base} ${tracks.length + 1}`;
}

/** A new track of the given kind, with the palette colour it should carry. */
export function trackOfType(tracks: StudioTrack[], type: StudioTrackType): StudioTrack {
  return { ...newTrack(defaultTrackName(tracks, type)), type, color: nextTrackColor(tracks) };
}

/** Whether an automatic addition (stems, imports) may add `count` more tracks. */
export function canAddTracks(tracks: StudioTrack[], count: number): boolean {
  return tracks.length + count <= TRACK_OVERFLOW_LIMIT;
}

/**
 * The drum voices the synth can play, at the General-MIDI pitches it writes them at.
 *
 * The list is not a catalogue — it is exactly `DRUM_MIDI` in shadow-music-generator, so a drum
 * track's notes always land on a row that has a name. The names stay English on purpose: Kick,
 * Snare, Clap and Hi-hat are what every drum machine, tutorial and sample pack says, and translating
 * them would make the studio harder to read for the people who use it (see AGENTS.md: 行业词不翻译).
 */
export const DRUM_VOICES: ReadonlyArray<{ midi: number; name: string }> = [
  { midi: 36, name: "Kick" },
  { midi: 38, name: "Snare" },
  { midi: 39, name: "Clap" },
  { midi: 42, name: "Hi-hat" },
  { midi: 46, name: "Open hat" },
];

/**
 * What a pitch is called on a drum track, or `undefined` when it is not one of our voices.
 *
 * Returning `undefined` (rather than guessing "Tom") is the honest answer: a note at 45 was not
 * written by our drum kit, and mislabelling it would teach the user something false.
 */
export function drumVoice(midi: number): { name: string } | undefined {
  const voice = DRUM_VOICES.find((entry) => entry.midi === midi);
  return voice === undefined ? undefined : { name: voice.name };
}

/**
 * What to say when a separation (or a run of imports) pushed the project past the manual limit.
 *
 * The rule the user asked for: stems may overflow to {@link TRACK_OVERFLOW_LIMIT}, the banner says
 * how many to delete, and nothing disappears on its own — the count going back down only re-enables
 * the "＋ 音轨" button.
 * @returns the sentence to show, or `undefined` when the project is inside its limit.
 */
export function overflowNotice(tracks: StudioTrack[]): string | undefined {
  const count = tracks.length;
  if (count <= MAX_TRACKS) return undefined;
  return `已临时扩展到 ${count} 轨（分轨结果）。删除 ${count - MAX_TRACKS} 条轨道后将自动恢复 ${MAX_TRACKS} 轨上限。`;
}

export type StudioProject = {
  id: string;
  name: string;
  updatedAt: number;
  bpm: number;
  key: string;
  bars: number;
  tracks: StudioTrack[];
  /** Set when the last arrangement render said what the song's shape is. */
  sections?: StudioSection[];
};

const STORAGE_KEY = "shadowroom.studio.projects.v1";
const OPEN_KEY = "shadowroom.studio.open";

const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function newClip(name: string, start = 0, length = 4, source?: string): StudioClip {
  return { id: newId("clip"), name, start, length, ...(source === undefined ? {} : { source }) };
}

/** Turn detected notes into a clip whose length covers the performance. */
export function clipFromNotes(notes: StudioNote[], bars: number, start: number, source: string): StudioClip {
  const last = notes.reduce((end, note) => Math.max(end, note.end_ms), 0);
  const seconds = last / 1000;
  const length = Math.max(1, Math.ceil((seconds * 2) / 4)); // rough: half a bar per second at 120 BPM
  return {
    id: newId("clip"),
    name: `哼唱 · ${notes.length} 音符`,
    start: Math.min(Math.max(0, start), Math.max(0, bars - length)),
    length: Math.min(length, bars),
    source,
    notes: withNoteIds(notes),
  };
}

export function newTrack(name: string): StudioTrack {
  return { id: newId("track"), name, muted: false, soloed: false, volume: 80, clips: [] };
}

/**
 * The track name an imported file deserves: its own name without the extension.
 * @param path - the file that was imported (a POSIX path, copied or referenced).
 * @returns the stem of the file name, e.g. `Artist - Track (Extended Mix)`.
 */
export function trackNameFromImport(path: string): string {
  const file = path.split("/").filter(Boolean).pop() ?? path;
  const stem = file.replace(/\.[^.]+$/, "").trim();
  return stem === "" ? file : stem;
}

/**
 * One imported file's track.
 *
 * Every import gets its own track — asking which existing track to drop a song into was the wrong
 * question: the file *is* a part. A name that is already taken gets a ` 2` so two takes of the same
 * track never merge silently.
 * @param path - where the file ended up.
 * @param existing - track names already in the project.
 * @returns a new track holding one clip, one bar long until the real duration is known.
 */
export function trackFromImport(path: string, existing: string[] = []): StudioTrack {
  const base = trackNameFromImport(path);
  let name = base;
  for (let index = 2; existing.includes(name) && index < 1000; index += 1) {
    name = `${base} ${index}`;
  }
  /**
   * An import is an audio track: it plays the file as it is and has no notes to edit. That is what
   * keeps double-clicking it from opening a piano roll that would have nothing in it.
   */
  return {
    ...newTrack(name),
    type: "audio",
    color: existing.length % TRACK_COLORS.length,
    clips: [newClip(trackNameFromImport(path), 0, 4, path)],
  };
}

/**
 * The badge drawn on an analysed clip: `128 BPM · 8A`, `128 BPM`, `8A`, or nothing.
 * @param analysis - what the analysis tools reported.
 * @returns the label, or an empty string when there is nothing to say.
 */
export function analysisBadge(analysis: StudioAnalysis | undefined): string {
  if (analysis === undefined) return "";
  const parts: string[] = [];
  if (typeof analysis.bpm === "number" && Number.isFinite(analysis.bpm)) {
    parts.push(`${Math.round(analysis.bpm)} BPM`);
  }
  const key = analysis.camelot ?? analysis.key;
  if (typeof key === "string" && key !== "") parts.push(key);
  return parts.join(" · ");
}

/** The names a separator's stems get in the studio, in track order. */
export const STEM_LABELS: Record<string, string> = {
  vocals: "Vocal",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
};

/**
 * The four new tracks a finished separation becomes.
 *
 * They are **new** tracks, not a merge into tracks of the same name: "separate this" means "give me
 * the four parts", and a stem that silently joined a track the user already had would be hard to
 * undo. A name that is taken gets a ` 2`, like every other import.
 * @param stems - `{vocals: path, drums: path, …}` as the splitter reported them.
 * @param existing - the project's tracks, used only to avoid duplicate names.
 * @param clip - where the stems came from: they keep its position and length.
 * @returns one new track per stem, in the order the separator listed them.
 */
export function tracksFromStems(
  stems: Record<string, string>,
  existing: StudioTrack[],
  clip: { name: string; start: number; length: number },
): StudioTrack[] {
  const created: StudioTrack[] = [];
  const taken = existing.map((track) => track.name);
  for (const [stem, path] of Object.entries(stems)) {
    const base = STEM_LABELS[stem] ?? stem;
    let label = base;
    for (let index = 2; taken.includes(label) && index < 100; index += 1) {
      label = `${base} ${index}`;
    }
    taken.push(label);
    created.push({
      ...newTrack(label),
      // A stem is a finished audio file, not notes: even 鼓 is an audio track here, which is why
      // the type is set explicitly instead of being inferred from the name.
      type: "audio",
      color: (existing.length + created.length) % TRACK_COLORS.length,
      clips: [newClip(`${label} · ${clip.name}`, clip.start, clip.length, path)],
    });
  }
  return created;
}

/**
 * The linear gain envelope of one clip at a playhead position, from its fades (0–1).
 *
 * One function, not two: 试听和导出必须是同一条规则（第一原则），so both the transport's
 * `element.volume` and the plugin's mixdown multiply by *this* shape — a linear ramp over
 * `fadeIn` seconds from the clip's first sample, and over `fadeOut` seconds into its last.
 * Fades that reach past the clip's far edge simply clamp, never go negative.
 * @param clip - the clip whose fades to apply.
 * @param bar - the playhead, in bars.
 * @param bpm - project tempo, bridging bars and seconds.
 * @returns the gain multiplier at that position (1 when the clip has no fades).
 */
export function fadeGain(clip: Pick<StudioClip, "start" | "length" | "fadeIn" | "fadeOut">, bar: number, bpm: number): number {
  const barsPerSec = barsPerSecond(bpm);
  let gain = 1;
  const fadeInBars = Math.max(0, (clip.fadeIn ?? 0) * barsPerSec);
  if (fadeInBars > 0 && bar < clip.start + fadeInBars) {
    gain = Math.min(gain, Math.max(0, (bar - clip.start) / fadeInBars));
  }
  const fadeOutBars = Math.max(0, (clip.fadeOut ?? 0) * barsPerSec);
  if (fadeOutBars > 0) {
    const end = clip.start + clip.length;
    if (bar > end - fadeOutBars) {
      gain = Math.min(gain, Math.max(0, (end - bar) / fadeOutBars));
    }
  }
  return gain;
}


export function defaultProject(): StudioProject {
  return {
    id: newId("project"),
    name: "新工程",
    updatedAt: Date.now(),
    bpm: 128,
    key: "8A",
    bars: 16,
    /**
     * Named tracks, no clips. The project used to open with two demo clips that had no audio behind
     * them — a timeline that looked like a song and played nothing. A project now starts empty: the
     * song arrives from a render (one sentence) or from an import.
     */
    tracks: [
      { ...newTrack("Drums"), type: "drums", color: 0 },
      { ...newTrack("Bass"), type: "instrument", color: 1 },
      { ...newTrack("Synth"), type: "instrument", color: 2 },
    ],
  };
}

export function snapshotProject(project: StudioProject, now: number = Date.now()): StudioProject {
  const stamp = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return {
    ...project,
    id: newId("project"),
    name: `${project.name}（快照 ${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}）`,
    updatedAt: now,
  };
}

export type StudioStore = { projects: StudioProject[] };

export function loadProjects(): StudioProject[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as StudioStore;
    if (!Array.isArray(parsed.projects)) return [];
    return parsed.projects.filter((project) => Array.isArray(project.tracks));
  } catch {
    return [];
  }
}

/**
 * 存工程。**返回值是给 UI 用的**：localStorage 大约 5MB，写满时 `setItem` 会抛异常，而以前这里
 * 静默吞掉——用户看到的是「改了半天，刷新回到上一个状态」。现在把失败说出来（见 App 的
 * `saveFailed` 提示），至少不会假装存上了。
 */
export function saveProjects(projects: StudioProject[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ projects } satisfies StudioStore));
    return true;
  } catch {
    /* Storage blocked or full: the in-memory projects still work, but the caller must say so. */
    return false;
  }
}

/** Which project was open last (the studio opens it when you come back). */
export function rememberOpenProject(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(OPEN_KEY);
    else window.localStorage.setItem(OPEN_KEY, id);
  } catch {
    /* ignore */
  }
}

export function lastOpenProject(projects: StudioProject[]): string | undefined {
  try {
    const id = window.localStorage.getItem(OPEN_KEY);
    return id !== null && projects.some((project) => project.id === id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Clip rows for the generator's outputs, so finished jobs can land on the timeline. */
export function clipsFromCalls(calls: ToolCall[]): StudioClip[] {
  return calls
    .filter((call) => call.name === "submit_generation" || call.name === "run_job")
    .map((call, index) => newClip(call.summary ?? call.name, index * 4, 4));
}
