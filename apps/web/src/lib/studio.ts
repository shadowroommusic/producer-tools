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
};

export type StudioNote = { start_ms: number; end_ms: number; midi: number; name?: string };

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
    notes,
  };
}

export function newTrack(name: string): StudioTrack {
  return { id: newId("track"), name, muted: false, soloed: false, volume: 80, clips: [] };
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
    tracks: [
      { ...newTrack("鼓"), clips: [newClip("鼓组", 0, 8)] },
      { ...newTrack("贝斯"), clips: [newClip("Bassline", 4, 8)] },
      newTrack("合成器"),
    ],
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
