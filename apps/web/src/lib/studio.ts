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

/** How many tracks a project may hold when the user adds them by hand. */
export const MAX_TRACKS = 10;

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
export type StudioSection = { name: string; bars: number; start: number };

/** Bars per second at 4/4 — the bridge between wall-clock audio and the bar grid. */
export function barsPerSecond(bpm: number): number {
  return bpm / 4 / 60;
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

export type StudioTrack = {
  id: string;
  name: string;
  muted: boolean;
  soloed: boolean;
  /** 0–100, the fader position. */
  volume: number;
  clips: StudioClip[];
};

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
  return { ...newTrack(name), clips: [newClip(trackNameFromImport(path), 0, 4, path)] };
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
  vocals: "人声",
  drums: "鼓",
  bass: "贝斯",
  other: "其它",
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
      clips: [newClip(`${label} · ${clip.name}`, clip.start, clip.length, path)],
    });
  }
  return created;
}

/** A project that already looks like a DAW: three labelled tracks, empty clips, 16 bars. */
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
    tracks: [newTrack("鼓"), newTrack("贝斯"), newTrack("合成器")],
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

export function saveProjects(projects: StudioProject[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ projects } satisfies StudioStore));
  } catch {
    /* storage blocked: the in-memory projects still work */
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
