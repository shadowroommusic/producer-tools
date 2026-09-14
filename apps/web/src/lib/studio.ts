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
};

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
  name: string;
  bpm: number;
  key: string;
  bars: number;
  tracks: StudioTrack[];
};

const STORAGE_KEY = "shadowroom.studio.v1";

const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function newClip(name: string, start = 0, length = 4, source?: string): StudioClip {
  return { id: newId("clip"), name, start, length, ...(source === undefined ? {} : { source }) };
}

export function newTrack(name: string): StudioTrack {
  return { id: newId("track"), name, muted: false, soloed: false, volume: 80, clips: [] };
}

/** A project that already looks like a DAW: three labelled tracks, empty clips, 16 bars. */
export function defaultProject(): StudioProject {
  return {
    name: "新工程",
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

export function loadProject(): StudioProject {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return defaultProject();
    const parsed = JSON.parse(raw) as StudioProject;
    if (!Array.isArray(parsed.tracks)) return defaultProject();
    return parsed;
  } catch {
    return defaultProject();
  }
}

export function saveProject(project: StudioProject): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch {
    /* storage blocked: the in-memory project still works */
  }
}

/** Clip rows for the generator's outputs, so finished jobs can land on the timeline. */
export function clipsFromCalls(calls: ToolCall[]): StudioClip[] {
  return calls
    .filter((call) => call.name === "submit_generation" || call.name === "run_job")
    .map((call, index) => newClip(call.summary ?? call.name, index * 4, 4));
}
