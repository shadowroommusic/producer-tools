/**
 * Studio — the multi-track page.
 *
 * Layout follows the DAWs this is modelled on (GarageBand / FL Studio): a transport strip on top, a
 * fixed column of track headers on the left (name, mute/solo, fader, meter), a bar-ruled timeline of
 * clips on the right, and the composer docked underneath so the agent sits where those apps put their
 * browser.
 *
 * Clips with an audio file behind them are *played*: one `<audio>` per clip, started and stopped as
 * the playhead crosses its edges, volume following the track's fader and mute/solo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconPause, IconPlay, IconPlus, IconRedo, IconStop, IconUndo } from "./icons";
import type { NotePlayer, NoteVoice } from "../lib/synth";
import {
  MAX_TRACKS,
  TRACK_COLORS,
  barsFromMilliseconds,
  barsPerSecond,
  clipBarsFromDuration,
  tempoMismatchNotice,
  canAddTracks,
  clipGain,
  defaultTrackName,
  duplicateSection,
  insertBars,
  notesRevision,
  overflowNotice,
  removeSection,
  repeatLastSection,
  structureRevision,
  trackColor,
  trackOfType,
  trackTypeOf,
  withNoteIds,
  fileUrl,
  isPlayable,
  newClip,
  newTrack,
  nextTrackColor,
  trackFromImport,
  analysisBadge,
  type StudioAnalysis,
  type StudioClip,
  type StudioNote,
  type StudioProject,
  type StudioTrack,
} from "../lib/studio";
import { midiLengthMs, parseMidiSong } from "../lib/midi";
import { callTool } from "../lib/mcp";
import { createNotePlayer } from "../lib/synth";
import { peaksFor } from "../lib/waveform";
import { createMetronome } from "../lib/metronome";
import { acquireMicrophone, releaseMicrophone } from "../lib/mic";
import { PianoRoll } from "./PianoRoll";

/** Pixels per bar at zoom 1. */
const BAR_PX = 56;

/**
 * 一首歌最长 10 分钟 —— 用户的原话是「最多只支持做十分钟的歌曲，不是非得生成十分钟，
 * 而是整个横向长度」。所以上限按**时间**算，不写死成小节数：同样 10 分钟，85 BPM 是 213 小节，
 * 120 BPM 是 300 小节，写死一个数月数就会在慢歌上不够、在快歌上白给。
 */
const MAX_SONG_SECONDS = 600;
const maxBarsFor = (bpm: number): number => Math.max(4, Math.ceil(MAX_SONG_SECONDS / (240 / Math.max(40, bpm))));

/** 秒 → mm:ss（走带读数用；超过一小时才会用到 h，做成小时也行但没必要）。 */
function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** One container the generator can write, as `list_export_formats` reports it. */
export type ExportFormat = { id: string; extension: string; lossy: boolean; available: boolean; via: string };

/** Where an export lands before the user edits the field. */
function defaultExportPath(projectName: string, kind: "mix" | "stems" | "midi", container: string): string {
  const base = projectName.trim().replace(/\s+/g, "-") || "song";
  if (kind === "stems") return `~/Documents/ShadowRoom/exports/${base}-stems`;
  if (kind === "midi") return `~/Documents/ShadowRoom/exports/${base}.mid`;
  return `~/Documents/ShadowRoom/exports/${base}.${container === "aiff" ? "aiff" : container === "m4a" ? "m4a" : "wav"}`;
}

export function StudioPage({
  project,
  onChange,
  onBeginEdit,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  composer,
  onClose,
  onExport,
  onConvertToMidi,
  onUploadImport,
  onSaveRecording,
  onPickImport,
  onAnalyze,
  onExportFormats,
  onSplitStems,
  onNoteContextChange,
  storageBlocked = false,
  rendering = [],
}: {
  project: StudioProject;
  /** Functional update: handlers must never write from a captured snapshot. */
  onChange: (patch: (project: StudioProject) => StudioProject, options?: { transient?: boolean }) => void;
  /** Called once when a gesture starts, so undo returns to the state before it. */
  onBeginEdit?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  composer: ReactNode;
  onClose: () => void;
  /** Bounce the arrangement through the generator plugin; resolves with the written path. */
  onExport?: (spec: Record<string, unknown>) => Promise<string | null>;
  /** Notate one audio clip (the melody tool); resolves with its notes. */
  onConvertToMidi?: (path: string) => Promise<{ midi_path?: string; notes?: StudioNote[] } | null>;
  /** Copy dropped/picked files into the workspace; resolves with where they landed. */
  onUploadImport?: (files: File[]) => Promise<string[]>;
  /** A finished take: hand the bytes to the bridge, get back a WAV path and its real length. */
  onSaveRecording?: (blob: Blob, name: string) => Promise<{ path: string; durationMs: number } | null>;
  /** A native "choose file…" dialog on the machine; resolves with paths to reference in place. */
  onPickImport?: () => Promise<string[]>;
  /** Tempo/key detection for one file (the analysis plugin); `null` when it could not listen. */
  onAnalyze?: (path: string, context: { wasEmpty: boolean }) => Promise<StudioAnalysis | null>;
  /** Which export containers this machine can actually write, from the generator plugin. */
  onExportFormats?: () => Promise<ExportFormat[]>;
  /**
   * 本地存储写不进去（配额满）时为 true —— 时间线上要常驻一行提示，因为这时候「改了什么都不会
   * 留下」，用户必须知道。
   */
  storageBlocked?: boolean;
  /**
   * The clip the piano roll has open, or null when it is closed. The App attaches it to the next
   * message so the agent can edit those notes without guessing at state it cannot see.
   */
  /** Clips an agent is re-rendering right now. */
  rendering?: string[];
  onNoteContextChange?: (
    context: {
      clipId: string;
      clipName: string;
      notes: StudioNote[];
      revision: string;
      /** The plan this clip's audio was rendered from, when it has one. */
      render?: Record<string, unknown>;
    } | null,
  ) => void;
  /**
   * Separate one clip into vocals / drums / bass / other (the stem-splitter plugin). Resolves when
   * the job has finished; the stems land on their own tracks through the App's absorber.
   */
  onSplitStems?: (clip: { source: string; clipId: string; name: string; start: number; length: number }) => Promise<boolean>;
}) {
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importing, setImporting] = useState(false);
  /**
   * Say one sentence and let it fade. Used where a control exists but cannot do anything here —
   * silencing it (the way a disabled button does) would leave the user guessing why.
   */
  const say = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 4500);
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );
  /** Clips whose separation is running right now. */
  const [splitting, setSplitting] = useState<string[]>([]);
  /** The clip whose「生成钢琴/贝斯/弦乐轨」is rendering right now. */
  const [generating, setGenerating] = useState<string | null>(null);
  /**
   * The structure menu: right-click the bar ruler to insert bars, right-click a section to repeat or
   * delete it. Sections are labels (dragging clips never moves them), so the menu is the one place
   * that changes the song's shape deliberately.
   */
  const [structureMenu, setStructureMenu] = useState<
    | { kind: "ruler"; bar: number; x: number; y: number }
    | { kind: "section"; sectionId: string; x: number; y: number }
    | null
  >(null);
  /** The "+ 音轨" menu: three kinds, no sub-menus (an instrument's sound is the agent's job). */
  const [trackMenu, setTrackMenu] = useState<{ x: number; y: number } | null>(null);
  /** A track header being dragged to a new position. */
  const [draggingTrack, setDraggingTrack] = useState<{ id: string; index: number } | null>(null);
  /** The track whose delete button has been armed by a first click. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** The clip whose notes the piano roll is editing (at most one: the editor shows one clip). */
  const [editing, setEditing] = useState<{ trackId: string; clipId: string } | null>(null);
  /** One sentence about something that just happened, cleared after a few seconds. */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  /** The overflow banner can be put away; the extra tracks stay until they are deleted. */
  const [overflowHidden, setOverflowHidden] = useState(false);
  /** A recording in progress: when it started, and how long it has been running. */
  const [recording, setRecording] = useState<{ startedAt: number; metronome: boolean } | null>(null);
  const [recordingMs, setRecordingMs] = useState(0);
  /** 走带的终点：内容末尾（默认，音乐停音乐该停的地方）或工程网格末尾（老行为，循环空尾）。 */
  const [playMode, setPlayMode] = useState<"content" | "project">(() =>
    window.localStorage.getItem("shadowroom.playmode") === "project" ? "project" : "content",
  );
    /** Click track and one-bar count-in, remembered between sessions (a studio habit, not project data). */
  const [metronomeOn, setMetronomeOn] = useState(() => window.localStorage.getItem("shadowroom.metronome") === "on");
  const [countIn, setCountIn] = useState(() => window.localStorage.getItem("shadowroom.countin") !== "off");
  const [dragging, setDragging] = useState(false);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportKind, setExportKind] = useState<"mix" | "stems" | "midi">("mix");
  const [sampleRate, setSampleRate] = useState(44100);
  const [bitDepth, setBitDepth] = useState(16);
  const [container, setContainer] = useState<string>("wav");
  /** What this machine can write. WAV/AIFF until the plugin answers. */
  const [formats, setFormats] = useState<ExportFormat[]>([
    { id: "wav", extension: "wav", lossy: false, available: true, via: "built-in" },
    { id: "aiff", extension: "aiff", lossy: false, available: true, via: "built-in" },
  ]);
  const [outPath, setOutPath] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  /** Peaks per clip, filled in as each file decodes. */
  const [waves, setWaves] = useState<Record<string, number[]>>({});
  const [menu, setMenu] = useState<{ trackId: string; clipId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [converting, setConverting] = useState(false);
  /** One audio element per playable clip. */
  const players = useRef<Map<string, HTMLAudioElement>>(new Map());
  /** Notes of a notated clip, played through the little Web Audio synth. */
  const notated = useRef<Map<string, NoteVoice>>(new Map());
  const notePlayer = useRef<NotePlayer>(createNotePlayer());
  /** Detached audio elements still need a home so devtools (and tests) can see them. */
  const audioHost = useRef<HTMLDivElement>(null);
  /** Authoritative playhead in bars; the state copy is only for rendering. */
  const position = useRef(0);
  const frame = useRef<number | null>(null);

  const barPx = BAR_PX * zoom;
  const secondsPerBar = 1 / barsPerSecond(project.bpm);
  const anySolo = project.tracks.some((track) => track.soloed);
  const audible = (track: StudioTrack) => !track.muted && (anySolo ? track.soloed : true);
  /**
   * Final gain of one clip at a playhead position: fader × mute/solo × fade/ramp envelope. The same
   * shape the plugin applies on export (clipGain), so 试听和导出走同一条规则.
   */
  const clipVolume = (track: StudioTrack, clip: StudioClip, bar: number) =>
    (audible(track) ? Math.min(1, track.volume / 100) : 0) * clipGain(clip, bar, project.bpm);

  /**
   * A stable handle on `onChange` for effects that must not re-run when the callback identity moves:
   * they patch one clip (transiently) and nothing else.
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const changeClipByRef = useCallback(
    (clipId: string, patch: (clip: StudioClip) => StudioClip, options?: { transient?: boolean }) => {
      onChangeRef.current((current) => ({
        ...current,
        tracks: current.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => (clip.id === clipId ? patch(clip) : clip)),
        })),
      }), options);
    },
    [],
  );

  const moveTo = (bar: number) => {
    position.current = bar;
    setPlayhead(bar);
  };

  // ---------- players ----------

  /** Keep one <audio> per playable clip; forget the ones whose clip is gone. */
  useEffect(() => {
    const wanted = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (!isPlayable(clip.source)) continue;
        wanted.add(clip.id);
        if (!players.current.has(clip.id)) {
          const element = new Audio(fileUrl(clip.source as string));
          element.preload = "auto";
          players.current.set(clip.id, element);
          audioHost.current?.appendChild(element);
        }
      }
    }
    for (const [id, element] of players.current) {
      if (!wanted.has(id)) {
        element.pause();
        element.remove();
        players.current.delete(id);
      }
    }
  }, [project.tracks]);

  /** Volumes follow the faders, mute and solo. */
  useEffect(() => {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const element = players.current.get(clip.id);
        if (element !== undefined) element.volume = clipVolume(track, clip, position.current);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.tracks, anySolo]);

  /** Park every player on the playhead: pause, seek, and restart whatever is under it. */
  const syncPlayers = (bar: number, play: boolean) => {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.notes !== undefined && clip.notes.length > 0) {
          const level = audible(track) ? Math.min(1, track.volume / 100) : 0;
          const inside = bar >= clip.start && bar < clip.start + clip.length;
          const voice = notated.current.get(clip.id);
          if (!inside || !play || level <= 0) {
            voice?.stop();
            notated.current.delete(clip.id);
          } else if (voice === undefined) {
            const handle = notePlayer.current.play(clip.notes, {
              leadSeconds: -(bar - clip.start) * secondsPerBar,
              gain: level,
            });
            if (handle !== null) notated.current.set(clip.id, handle);
          }
        }
        // Audio behind the clip is played by its own element; a clip with only notes has none.
        if (!isPlayable(clip.source)) continue;
        const element = players.current.get(clip.id);
        if (element === undefined) continue;
        const inside = bar >= clip.start && bar < clip.start + clip.length;
        // Fader × fade envelope at the current playhead — the envelope only moves because this runs
        // every rAF tick while playing.
        element.volume = clipVolume(track, clip, bar);
        if (inside) {
          const offset = Math.max(0, (bar - clip.start) * secondsPerBar);
          if (Math.abs(element.currentTime - offset) > 0.15) element.currentTime = offset;
          if (play && element.paused && element.volume > 0) void element.play().catch(() => undefined);
          if (!play && !element.paused) element.pause();
        } else if (!element.paused) {
          element.pause();
        }
      }
    }
  };

  /**
   * 内容的真实末尾（小节）：全部片段里最远的 `start + length`。
   *
   * 走带以它为终点（任务 9：「音乐播完了黄线才到中间」——在空白区里继续跑的走带是在报错误的时间）。
   * 没有任何片段时回落到工程长度，保持空工程可以照常预滚动。
   */
  const contentEndBars = useMemo(() => {
    const end = project.tracks
      .flatMap((track) => track.clips)
      .reduce((far, clip) => Math.max(far, clip.start + clip.length), 0);
    return end > 0 ? end : project.bars;
  }, [project.tracks, project.bars]);

  // The transport: one rAF loop that advances the playhead and drags the players with it.
  useEffect(() => {
    if (!playing) {
      syncPlayers(position.current, false);
      return;
    }
    let previous = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - previous) / 1000;
      previous = now;
      let next = position.current + elapsed * barsPerSecond(project.bpm);
      // 播放模式（任务 9 修订）：内容末尾（默认）——音乐停音乐该停的地方，黄线不跑进空白区；
      // 工程末尾——老行为，越过内容后回到 0 循环（用户明确要看完整网格时用）。
      if (playMode === "content" ? next >= contentEndBars : next >= project.bars) {
        if (playMode === "content") {
          setPlaying(false);
          next = contentEndBars;
          position.current = next;
          setPlayhead(next);
          syncPlayers(next, false);
          return; // 不再请求下一帧：走带停在内容末尾
        }
        syncPlayers(0, false);
        next = 0;
      }
      position.current = next;
      setPlayhead(next);
      syncPlayers(next, true);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, project.bpm, project.bars, project.tracks, anySolo, contentEndBars, playMode]);

  useEffect(
    () => () => {
      for (const element of players.current.values()) element.pause();
      players.current.clear();
      for (const voice of notated.current.values()) voice.stop();
      notated.current.clear();
      notePlayer.current.quiet();
    },
    [],
  );

  /**
   * Open the piano roll for one clip.
   *
   * Ids are attached here, in an event handler, and not from inside the editor: React's StrictMode
   * runs mount effects twice, so a "fill in the missing ids" effect wrote the note array twice and the
   * roll drew the same notes twice (measured: 4 notes rendered as 7).
   */
  const openNotes = useCallback(
    (trackId: string, clipId: string) => {
      changeClip(trackId, clipId, (clip) => ({ ...clip, notes: withNoteIds(clip.notes ?? []) }));
      setEditing({ trackId, clipId });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Tell the App which clip the work is on — the piano roll's clip if it is open, otherwise the
  // selection — so the next message can carry its notes and the plan its audio came from.
  useEffect(() => {
    if (onNoteContextChange === undefined) return;
    const target = editing ?? selected;
    const clip =
      target === null
        ? undefined
        : project.tracks
            .find((track) => track.id === target.trackId)
            ?.clips.find((entry) => entry.id === target.clipId);
    if (clip === undefined) {
      onNoteContextChange(null);
      return;
    }
    onNoteContextChange({
      clipId: clip.id,
      clipName: clip.name,
      notes: clip.notes ?? [],
      revision: notesRevision(clip.notes ?? []),
      ...(clip.render === undefined ? {} : { render: clip.render as unknown as Record<string, unknown> }),
    });
  }, [editing, onNoteContextChange, project.tracks, selected]);

  /** Play one note through the same synth the transport uses, so editing has a sound. */
  const audition = useCallback((midi: number, durationMs: number) => {
    notePlayer.current.play([{ start_ms: 0, end_ms: Math.max(60, durationMs), midi }], { leadSeconds: 0, gain: 0.8 });
  }, []);

  const togglePlay = () => {
    const next = !playing;
    setPlaying(next);
    syncPlayers(position.current, next);
  };

  const stop = () => {
    setPlaying(false);
    syncPlayers(0, false);
    moveTo(0);
  };

  const seek = (bar: number) => {
    const clamped = Math.max(0, Math.min(project.bars - 0.001, bar));
    moveTo(clamped);
    syncPlayers(clamped, playing);
  };

  // ---------- arrangement editing ----------

  // Decode the audio behind every playable clip once, so the clips can draw themselves.
  useEffect(() => {
    let cancelled = false;
    const wanted = project.tracks.flatMap((track) =>
      track.clips.filter((clip) => isPlayable(clip.source)).map((clip) => ({ id: clip.id, path: clip.source as string })),
    );
    void (async () => {
      for (const clip of wanted) {
        if (waves[clip.id] !== undefined) continue;
        const peaks = await peaksFor(clip.path);
        if (cancelled || peaks === null) continue;
        setWaves((current) => ({ ...current, [clip.id]: peaks }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.tracks]);

  /**
   * Measure every clip's audio once (browser metadata probe) and record its real duration.
   *
   * 任务 9：片段长度要以「声音的实际时长 × 当前 BPM」为准。测量是 **transient**（不进撤销栈）：
   * 它不改用户排的布局，只是把文件本来多长这一事实写到 clip 上。
   */
  const probedDuration = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const clip of project.tracks.flatMap((track) => track.clips)) {
      if (!isPlayable(clip.source) || clip.duration_ms !== undefined) continue;
      if (probedDuration.current.has(clip.id)) continue;
      probedDuration.current.set(clip.id, 0); // 在途标记：一个片段只探测一次
      const probe = new Audio(fileUrl(clip.source as string));
      probe.addEventListener("loadedmetadata", () => {
        if (!Number.isFinite(probe.duration) || probe.duration <= 0) return;
        const ms = Math.round(probe.duration * 1000);
        probedDuration.current.set(clip.id, ms);
        // 落轨调和（任务 9 修订版）：length_bars = max(音频时长按当前 BPM 反算, render 声明的 bars)。
        // 这是唯一改 length 的地方——之后 BPM 再变也**不重算**（音频不随工程 BPM 变速，重算只会把
        // 尾音截掉、让片段和音频脱节；不一致用片段上的 ⚠ 提示说出来）。
        onChangeRef.current((current) => ({
          ...current,
          tracks: current.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((entry) => {
              if (entry.id !== clip.id) return entry;
              const derived = clipBarsFromDuration({ ...entry, duration_ms: ms }, current.bpm);
              const authoritative = Math.max(derived ?? 0, entry.render?.bars ?? entry.length);
              const reconciled = Math.abs(authoritative - entry.length) >= 0.01 ? authoritative : entry.length;
              return { ...entry, duration_ms: ms, length: reconciled };
            }),
          })),
        }), { transient: true });
      });
      probe.addEventListener("error", () => probedDuration.current.delete(clip.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.tracks]);


  const updateTrack = (trackId: string, patch: (track: StudioTrack) => StudioTrack) => {
    onChange((current) => ({
      ...current,
      tracks: current.tracks.map((track) => (track.id === trackId ? patch(track) : track)),
    }));
  };

  const addClip = (trackId: string, start: number) => {
    const clip = newClip("片段", Math.max(0, Math.round(start)), 4);
    onChange((current) => ({
      ...current,
      tracks: current.tracks.map((track) =>
        track.id === trackId
          ? { ...track, clips: [...track.clips, { ...clip, name: `${track.name} ${track.clips.length + 1}` }] }
          : track,
      ),
    }));
    setSelected({ trackId, clipId: clip.id });
  };

  const changeClip = (
    trackId: string,
    clipId: string,
    patch: (clip: StudioClip) => StudioClip,
    options?: { transient?: boolean },
  ) => {
    onChange(
      (current) => ({
        ...current,
        tracks: current.tracks.map((track) =>
          track.id === trackId
            ? { ...track, clips: track.clips.map((clip) => (clip.id === clipId ? patch(clip) : clip)) }
            : track,
        ),
      }),
      options,
    );
  };

  /** Which track lane sits under a point (used while dragging a clip up or down). */
  const trackAt = (x: number, y: number): string | undefined => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    return element?.closest<HTMLElement>("[data-track-id]")?.dataset.trackId;
  };

  const moveClipToTrack = (fromId: string, toId: string, clipId: string, start: number) => {
    onChange((current) => {
      const from = current.tracks.find((track) => track.id === fromId);
      const clip = from?.clips.find((entry) => entry.id === clipId);
      if (clip === undefined) return current;
      return {
        ...current,
        tracks: current.tracks.map((track) => {
          if (track.id === fromId) return { ...track, clips: track.clips.filter((entry) => entry.id !== clipId) };
          if (track.id === toId) {
            return { ...track, clips: [...track.clips, { ...clip, start: Math.max(0, Math.round(start)) }] };
          }
          return track;
        }),
      };
    }, { transient: true });
  };

  const removeClip = (trackId: string, clipId: string) => {
    updateTrack(trackId, (track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }));
    setSelected(null);
  };

  /** The three voices「用这段生成…」offers. Keys are stable: the menu and the wav suffix use them. */
  type PartKind = "piano" | "bass" | "strings";
  const PART_PRESETS: Record<PartKind, { label: string; spec: Record<string, unknown>; octave: number }> = {
    // 现有合成器的三套音色（不引入新依赖；SoundFont 等用户拍板）。钢琴用 triangle 的软起音，
    // 贝斯把哼唱整体降八度（哼出来的音高在人声区，bass 要在低八度才像 bass），弦乐用慢起音的 pad。
    piano: { label: "钢琴", spec: { part: "lead", wave: "triangle", attack: 0.005, release: 0.18, reverb: 0.2, gain: 0.8 }, octave: 0 },
    bass: { label: "贝斯", spec: { part: "bass", wave: "saw", cutoff: 0.32, gain: 0.7 }, octave: -12 },
    strings: { label: "弦乐", spec: { part: "pad", wave: "saw", cutoff: 0.5, attack: 0.25, release: 0.5, reverb: 0.3, gain: 0.6 }, octave: 0 },
  };

  /** Turn one clip's notes into a rendered audio track (MIDI → 单轨音频). */
  const generatePartTrack = async (clip: StudioClip, kind: PartKind) => {
    if (generating !== null) return;
    const notes = clip.notes ?? [];
    if (notes.length === 0) return;
    const preset = PART_PRESETS[kind];
    setGenerating(clip.id);
    try {
      const beatMs = 60_000 / project.bpm;
      const base = clip.name.trim().replace(/\s+/g, "-") || "part";
      const written = await callTool<string>(
        "generator",
        "render_part",
        {
          out_path: `~/Documents/ShadowRoom/recordings/${base}-${kind}-${Date.now().toString(36)}.wav`,
          bpm: project.bpm,
          bars: clip.length,
          ...preset.spec,
          notes: notes.map((note) => ({
            midi: Math.max(0, Math.min(127, note.midi + preset.octave)),
            start: Math.max(0, note.start_ms / beatMs),
            length: Math.max(0.25, (note.end_ms - note.start_ms) / beatMs),
          })),
        },
      );
      const parsed = JSON.parse(String(written)) as { path?: string; duration_ms?: number };
      if (parsed.path === undefined) throw new Error("结果里没有文件");
      onChange((current) => {
        const taken = current.tracks.map((track) => track.name);
        let name = preset.label;
        for (let index = 2; taken.includes(name) && index < 100; index += 1) name = `${preset.label} ${index}`;
        return {
          ...current,
          tracks: [
            ...current.tracks,
            {
              ...newTrack(name),
              type: "instrument",
              color: nextTrackColor(current.tracks),
              clips: [newClip(`${preset.label} · ${clip.name}`, clip.start, clip.length, parsed.path as string)],
            },
          ],
        };
      });
      say(`${preset.label}轨生成好了：${(parsed.path as string).split("/").pop()}（${((parsed.duration_ms ?? 0) / 1000).toFixed(1)}s）`);
    } catch (cause) {
      say(`${preset.label}轨没生成：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setGenerating(null);
    }
  };

  /**
   * Import files: **one new track per file**, named after it, with the clip's real length.
   *
   * The import used to ask which existing track to drop a song into, which is the wrong question —
   * a song is a part, not a clip on the bass track. The file's tempo and key are analysed
   * afterwards; when the project was still empty, the detected tempo becomes the project's own.
   */
  const importFiles = useCallback(
    async (paths: string[]) => {
      const clean = paths.map((path) => path.trim()).filter((path) => path !== "");
      if (clean.length === 0) return;
      const wasEmpty = project.tracks.every((track) => track.clips.length === 0);
      setImportOpen(false);
      setImportPath("");

      /**
       * A `.mid` is not audio: it is already notes, so it gets read here and lands as tracks full of
       * editable notes — one track per MIDI track (or per channel in a format-0 file). It never goes
       * near the audio analyser, and it never gets a "clip with an empty source".
       */
      const midiPaths = clean.filter((path) => /\.(mid|midi)$/i.test(path));
      for (const path of midiPaths) {
        try {
          const response = await fetch(fileUrl(path));
          const song = parseMidiSong(new Uint8Array(await response.arrayBuffer()));
          if (song.parts.length === 0) {
            say(`${path.split("/").pop() ?? path} 里没有音符。`);
            continue;
          }
          const detected = song.bpm ?? project.bpm;
          const adoptTempo = wasEmpty && song.bpm !== undefined;
          onChange((current) => {
            const bpm = adoptTempo ? (song.bpm as number) : current.bpm;
            let tracks = [...current.tracks];
            const names = tracks.map((track) => track.name);
            for (const part of song.parts) {
              let name = part.name;
              for (let index = 2; names.includes(name) && index < 100; index += 1) name = `${part.name} ${index}`;
              names.push(name);
              tracks = [
                ...tracks,
                {
                  ...newTrack(name),
                  type: part.drums ? "drums" : "instrument",
                  color: nextTrackColor(tracks),
                  clips: [
                    {
                      ...newClip(name, 0, barsFromMilliseconds(midiLengthMs([part]), bpm), path),
                      notes: withNoteIds(part.notes),
                    },
                  ],
                },
              ];
            }
            return { ...current, tracks, ...(adoptTempo ? { bpm: Math.round(detected) } : {}) };
          });
          say(
            adoptTempo
              ? `已从 ${path.split("/").pop() ?? "MIDI"} 建了 ${song.parts.length} 条音轨，工程 BPM 设为 ${Math.round(detected)}。`
              : `已从 ${path.split("/").pop() ?? "MIDI"} 建了 ${song.parts.length} 条音轨${song.bpm === undefined ? "" : `（它标的是 ${song.bpm} BPM，当前工程 ${project.bpm}）`}。`,
          );
        } catch (cause) {
          say(`MIDI 没读进来：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      if (midiPaths.length === clean.length) return;
      const audioPaths = clean.filter((path) => !midiPaths.includes(path));
      const created: Array<{ trackId: string; clipId: string }> = [];
      onChange((current) => {
        let tracks = [...current.tracks];
        const names = tracks.map((track) => track.name);
        for (const path of audioPaths) {
          const track = trackFromImport(path, names);
          names.push(track.name);
          tracks = [...tracks, track];
          created.push({ trackId: track.id, clipId: track.clips[0].id });
        }
        return { ...current, tracks };
      });
      setSelected(created.at(-1) ?? null);

      for (const [index, path] of audioPaths.entries()) {
        // 1. the real duration decides the clip's length on the bar grid
        if (isPlayable(path)) {
          const probe = new Audio(fileUrl(path));
          probe.addEventListener("loadedmetadata", () => {
            if (!Number.isFinite(probe.duration) || probe.duration <= 0) return;
            onChange((current) => ({
              ...current,
              tracks: current.tracks.map((track) => ({
                ...track,
                clips: track.clips.map((entry) =>
                  entry.source === path
                    ? { ...entry, length: Math.max(1, Math.ceil(probe.duration * barsPerSecond(current.bpm))) }
                    : entry,
                ),
              })),
            }));
          });
        }
        // 2. what is it? (tempo + key) — the App owns the project tempo, so the answer goes up
        if (onAnalyze === undefined) continue;
        const analysis = await onAnalyze(path, { wasEmpty: wasEmpty && index === 0 });
        if (analysis === null) continue;
        onChange((current) => ({
          ...current,
          tracks: current.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((entry) =>
              entry.source === path ? { ...entry, analysis: { ...entry.analysis, ...analysis } } : entry,
            ),
          })),
        }));
      }
    },
    [onAnalyze, onChange, project.tracks],
  );

  /** Copy the files the browser hands us (drop or picker) into the workspace, then import them. */
  const uploadAndImport = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || onUploadImport === undefined) return;
      setImporting(true);
      const paths = await onUploadImport(files);
      setImporting(false);
      await importFiles(paths);
    },
    [importFiles, onUploadImport],
  );

  /**
   * Record the microphone into a new take.
   *
   * The flow is the one every DAW has: optional one-bar count-in, clicks if you asked for them, then
   * the take lands at the playhead. The clicks are synthesised on their own audio clock and are *not*
   * part of the recording — they reach the microphone only through the room, which is why a take made
   * with speakers instead of headphones is the user's choice to make.
   */
  const audioContextRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pendingStartRef = useRef<number | null>(null);
  /**
   * The click track that is currently running, if any.
   *
   * It used to be a local `const` inside `startRecording`, which meant the only thing that could stop
   * it was the recorder's own `onstop`. Cancel during the count-in (which never reaches `onstop`) left
   * the clicks playing forever — and every further attempt left one more, so they stacked up. One ref,
   * stopped on every exit path, is the whole fix.
   */
  const metronomeRef = useRef<ReturnType<typeof createMetronome> | null>(null);
  const stopClicks = useCallback(() => {
    metronomeRef.current?.stop();
    metronomeRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    if (recording !== null || onSaveRecording === undefined) return;
    try {
      const stream = await acquireMicrophone();
      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      if (context.state === "suspended") await context.resume();

      const beatSeconds = 60 / Math.max(1, project.bpm);
      const clicks = metronomeOn || countIn;
      stopClicks(); // never two click tracks, whatever happened before
      const metronome = createMetronome({ context, destination: context.destination, bpm: project.bpm });
      metronomeRef.current = metronome;
      const t0 = clicks ? metronome.start() : context.currentTime;
      const beginsAt = countIn ? t0 + beatSeconds * 4 : t0;
      const delayMs = Math.max(0, (beginsAt - context.currentTime) * 1000);

      setRecording({ startedAt: Date.now() + delayMs, metronome: clicks });
      setRecordingMs(0);
      say(countIn ? "预备拍：4 拍之后开始录。" : "开始录音。");

      pendingStartRef.current = window.setTimeout(() => {
        pendingStartRef.current = null;
        const supported = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
        const mimeType = supported.find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType });
        chunksRef.current = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
          stopClicks();
          releaseMicrophone();
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType === "" ? "audio/webm" : recorder.mimeType });
          const clock = new Date().toISOString().slice(11, 19).replace(/:/g, "-");
          void onSaveRecording(blob, `录音 ${clock}`).then((saved) => {
            if (saved === null || saved.durationMs <= 0) return;
            const bar = playhead;
            const length = barsFromMilliseconds(saved.durationMs, project.bpm);
            const target =
              selected === null ? undefined : project.tracks.find((track) => track.id === selected.trackId);
            onChange((current) => {
              const clip = newClip(`录音 ${clock}`, bar, length, saved.path);
              const onAudioTrack =
                target === undefined
                  ? undefined
                  : current.tracks.find((track) => track.id === target.id && trackTypeOf(track) === "audio");
              if (onAudioTrack !== undefined) {
                return {
                  ...current,
                  tracks: current.tracks.map((track) =>
                    track.id === onAudioTrack.id ? { ...track, clips: [...track.clips, clip] } : track,
                  ),
                };
              }
              let name = "录音 1";
              for (let index = 2; current.tracks.some((track) => track.name === name) && index < 100; index += 1) {
                name = `录音 ${index}`;
              }
              return {
                ...current,
                tracks: [
                  ...current.tracks,
                  { ...newTrack(name), type: "audio", color: nextTrackColor(current.tracks), clips: [clip] },
                ],
              };
            });
            say(`录了 ${(saved.durationMs / 1000).toFixed(1)} 秒，落在第 ${Math.floor(bar) + 1} 小节。`);
          });
        };
        recorderRef.current = recorder;
        recorder.start();
      }, delayMs);
    } catch (cause) {
      releaseMicrophone();
      say(`麦克风没打开：${cause instanceof Error ? cause.message : String(cause)}`);
      setRecording(null);
    }
  }, [countIn, metronomeOn, onChange, onSaveRecording, playhead, project.bpm, project.tracks, recording, say, selected, stopClicks]);

  const stopRecording = useCallback(() => {
    /**
     * Silence the clicks first, on every path out: cancelling inside the count-in never reaches the
     * recorder's `onstop`, and that is exactly how the click track survived being stopped.
     */
    stopClicks();
    if (pendingStartRef.current !== null) {
      window.clearTimeout(pendingStartRef.current);
      pendingStartRef.current = null;
      releaseMicrophone();
      setRecording(null);
      say("已取消录音（还在预备拍里）。");
      return;
    }
    const recorder = recorderRef.current;
    setRecording(null);
    if (recorder === null || recorder.state === "inactive") return;
    recorder.stop();
  }, [say, stopClicks]);

  /** The seconds counter next to the button, so "am I still recording?" is never a guess. */
  useEffect(() => {
    if (recording === null) return;
    const id = window.setInterval(() => setRecordingMs(Math.max(0, Date.now() - recording.startedAt)), 200);
    return () => window.clearInterval(id);
  }, [recording]);

  useEffect(() => {
    window.localStorage.setItem("shadowroom.metronome", metronomeOn ? "on" : "off");
  }, [metronomeOn]);
  useEffect(() => {
    window.localStorage.setItem("shadowroom.playmode", playMode);
  }, [playMode]);
  useEffect(() => {
    window.localStorage.setItem("shadowroom.countin", countIn ? "on" : "off");
  }, [countIn]);

  /** Leaving the page mid-take must not leave the device open or a click track running. */
  useEffect(
    () => () => {
      if (pendingStartRef.current !== null) window.clearTimeout(pendingStartRef.current);
      stopClicks();
      const recorder = recorderRef.current;
      if (recorder !== null && recorder.state !== "inactive") recorder.stop();
      releaseMicrophone();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    },
    [stopClicks],
  );

  /** Reference files in place through the machine's own file dialog. */
  const pickAndImport = useCallback(async () => {
    if (onPickImport === undefined) return;
    setImporting(true);
    const paths = await onPickImport();
    setImporting(false);
    await importFiles(paths);
  }, [importFiles, onPickImport]);

  /** Replace the notes of the clip the piano roll is editing. */
  const setNotes = useCallback(
    (notes: StudioNote[]) => {
      if (editing === null) return;
      changeClip(editing.trackId, editing.clipId, (clip) => ({ ...clip, notes }), { transient: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing],
  );

  const anySoloTrack = project.tracks.find((track) => track.soloed);
  const overflow = overflowNotice(project.tracks);

  /**
   * The overflow banner stops being true the moment the count is back inside the limit — and the
   * user deserves to be told that the limit is theirs again, not left wondering whether the extra
   * tracks broke something.
   */
  const previousCount = useRef(project.tracks.length);
  useEffect(() => {
    const count = project.tracks.length;
    if (previousCount.current > MAX_TRACKS && count <= MAX_TRACKS) {
      setOverflowHidden(false);
      say(`已恢复 ${MAX_TRACKS} 轨上限。`);
    }
    previousCount.current = count;
  }, [project.tracks.length, say]);
  /**
   * 走带读数：小节.拍 + 时间。
   *
   * 以前只有一个「1.1」——它其实是**小节.拍**，但看起来像计时器，用户会觉得"读秒有问题"
   * （尤其工程变长之后，根本看不出还剩多久）。现在两样都给，总长跟着工程算。
   */
  const elapsedLabel = formatClock(playhead * secondsPerBar);
  const totalLabel = formatClock(project.bars * secondsPerBar);
  const positionLabel = `${Math.floor(playhead) + 1}.${Math.floor((playhead % 1) * 4) + 1}`;
  const grid = useMemo(() => Array.from({ length: project.bars }, (_, bar) => bar), [project.bars]);

  return (
    <div
      className="sr-studio"
      data-dropping={dragging || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // only when the pointer really left the page, not when it crossed a child
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void uploadAndImport(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="sr-studio-drop" aria-hidden="true">
          <span>松手即导入 —— 每个文件会新建一条音轨</span>
        </div>
      )}
      <header className="sr-studio-transport">
        <button type="button" className="sr-btn sr-studio-back" onClick={onClose} title="回到工程列表">
          ‹ 工程
        </button>
        <div className="sr-transport-buttons">
          <button
            type="button"
            className="sr-icon-btn sr-transport-play"
            aria-label={playing ? "暂停" : "播放"}
            title={playing ? "暂停" : "播放"}
            aria-pressed={playing}
            onClick={togglePlay}
          >
            {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>
          <button type="button" className="sr-icon-btn" aria-label="停止" title="停止" onClick={stop}>
            <IconStop size={14} />
          </button>
          <button
            type="button"
            className="sr-icon-btn"
            aria-label="撤销"
            title="撤销 (⌘Z)"
            disabled={!canUndo}
            onClick={onUndo}
          >
            <IconUndo size={16} />
          </button>
          <button
            type="button"
            className="sr-icon-btn"
            aria-label="重做"
            title="重做 (⇧⌘Z)"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <IconRedo size={16} />
          </button>
        </div>
        <div className="sr-transport-position sr-mono" title={`第 ${positionLabel} 小节 · 上限 10:00`}>
          {positionLabel} · {elapsedLabel} / {totalLabel}
        </div>
        <button
          type="button"
          className="sr-btn sr-transport-playmode"
          data-project={playMode === "project" || undefined}
          title={
            playMode === "content"
              ? "播到内容末尾就停（默认）。点一下切换成播完整工程网格"
              : "播完整工程网格（越过内容循环）。点一下切回播到内容末尾"
          }
          onClick={() => setPlayMode((mode) => (mode === "content" ? "project" : "content"))}
        >
          {playMode === "content" ? "播到内容末尾" : "播到工程末尾"}
        </button>
        <div className="sr-transport-fields">
          <label className="sr-transport-field">
            <span className="sr-field-label sr-mono">BPM</span>
            <input
              className="sr-input sr-input--num"
              value={project.bpm}
              inputMode="numeric"
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  bpm: Math.max(40, Math.min(220, Number(event.target.value) || current.bpm)),
                }))
              }
            />
          </label>
          <label className="sr-transport-field">
            <span className="sr-field-label sr-mono">调性</span>
            <input
              className="sr-input sr-input--key"
              value={project.key}
              onChange={(event) => onChange((current) => ({ ...current, key: event.target.value }))}
            />
          </label>
          <label className="sr-transport-field">
            <span className="sr-field-label sr-mono">小节</span>
            <input
              className="sr-input sr-input--num"
              value={project.bars}
              title={`最长 ${maxBarsFor(project.bpm)} 小节（10:00 @ ${project.bpm} BPM）`}
              inputMode="numeric"
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  bars: Math.max(4, Math.min(maxBarsFor(current.bpm), Number(event.target.value) || current.bars)),
                }))
              }
            />
          </label>
        </div>
        {/* The three actions wrap as one group: a narrow centre column must never orphan 导出音频
            onto its own line above the timeline. */}
        <div className="sr-transport-actions">
          <button
            type="button"
            className="sr-btn sr-studio-addtrack"
            disabled={project.tracks.length >= MAX_TRACKS}
            aria-haspopup="menu"
            aria-expanded={trackMenu !== null}
            title={
              project.tracks.length >= MAX_TRACKS
                ? `已达到 ${MAX_TRACKS} 轨上限；删掉一条即可继续添加`
                : `加一条音轨（上限 ${MAX_TRACKS}）`
            }
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setTrackMenu({ x: box.left, y: box.bottom + 6 });
            }}
          >
            <IconPlus size={14} />
            音轨
          </button>
          {overflow !== undefined && (
            <span
              className="sr-transport-hint sr-mono"
              title={`已有 ${project.tracks.length} 条轨道，超过手动的 ${MAX_TRACKS} 轨上限；删掉几条就恢复`}
            >
              {project.tracks.length}/{MAX_TRACKS} 轨
            </span>
          )}
          <button
            type="button"
            className="sr-btn sr-studio-import"
            onClick={() => filePicker.current?.click()}
            title="选择文件（可多选）——也可以直接把文件拖进窗口"
          >
            {importing ? "导入中…" : "导入音频"}
          </button>
          {/*
            Recording lives next to importing because that is where "audio comes from" in this
            transport. The click track and count-in are settings, not project data, so they live in
            the ⋯ menu — put in this row they pushed 导出音频 off the edge at 1240px (measured).
          */}
          <button
            type="button"
            className="sr-btn sr-studio-record"
            data-recording={recording !== null || undefined}
            disabled={onSaveRecording === undefined}
            onClick={() => (recording === null ? void startRecording() : stopRecording())}
            title={
              onSaveRecording === undefined
                ? "录音需要 agent bridge（pnpm serve:agent）"
                : recording === null
                  ? "用麦克风录一段，落在播放头"
                  : "停止录音"
            }
          >
            <span className="sr-rec-dot" aria-hidden="true" />
            {recording === null ? "录音" : `停止 ${(recordingMs / 1000).toFixed(1)}s`}
          </button>
          {/* The other two ways in: reference a path, or the machine's own file dialog. */}
          <button
            type="button"
            className="sr-btn sr-studio-import-more"
            aria-label="更多导入方式"
            aria-expanded={importOpen}
            title="更多导入方式：粘贴路径 / 从磁盘选取"
            onClick={() => setImportOpen((open) => !open)}
          >
            ⋯
          </button>
          <button
            type="button"
            className="sr-btn sr-studio-trim"
            disabled={contentEndBars >= project.bars}
            title={
              contentEndBars >= project.bars
                ? "工程长度已经和内容一致"
                : `把工程从 ${project.bars} 小节裁到内容末尾（${Math.round(contentEndBars)} 小节）——⌘Z 可撤销`
            }
            onClick={() => {
              const target = Math.max(1, Math.ceil(contentEndBars));
              onChange((current) => ({ ...current, bars: target }));
              say(`工程裁到 ${target} 小节（⌘Z 可撤销）`);
            }}
          >
            裁剪到内容末尾
          </button>
          <button
            type="button"
            className="sr-btn sr-studio-export"
            onClick={() => {
              setOutPath((current) => current || defaultExportPath(project.name, exportKind, container));
              setExportOpen((open) => !open);
              // What the machine can write is the plugin's answer, not our guess: ask each time the
              // bar opens (cheap) so a freshly installed encoder shows up without a reload.
              if (onExportFormats !== undefined) {
                void onExportFormats()
                  .then((list) => {
                    if (list.length > 0) setFormats(list);
                  })
                  .catch(() => undefined);
              }
            }}
          >
            导出音频
          </button>
        </div>
      </header>

      {exportOpen && (
        <div className="sr-studio-import-bar sr-studio-export-bar">
          <span className="sr-field-label sr-mono">内容</span>
          <select
            className="sr-input sr-input--num"
            value={exportKind}
            aria-label="导出内容"
            onChange={(event) => {
              const next = event.target.value as "mix" | "stems" | "midi";
              setExportKind(next);
              setOutPath(defaultExportPath(project.name, next, container));
              setExported(null);
            }}
          >
            <option value="mix">整首</option>
            <option value="stems">分轨</option>
            <option value="midi">MIDI</option>
          </select>
          <span className="sr-field-label sr-mono">采样率</span>
          <select
            className="sr-input sr-input--num"
            value={sampleRate}
            aria-label="采样率"
            disabled={exportKind === "midi"}
            onChange={(event) => setSampleRate(Number(event.target.value))}
          >
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48 kHz</option>
            <option value={96000}>96 kHz</option>
          </select>
          <span className="sr-field-label sr-mono">位深</span>
          <select
            className="sr-input sr-input--num"
            value={bitDepth}
            aria-label="位深"
            /* A lossy codec has no bit depth: it is refused by the encoder, so the field goes quiet. */
            disabled={exportKind === "midi" || (formats.find((format) => format.id === container)?.lossy ?? false)}
            onChange={(event) => setBitDepth(Number(event.target.value))}
          >
            <option value={16}>16-bit</option>
            <option value={24}>24-bit</option>
          </select>
          <span className="sr-field-label sr-mono">格式</span>
          <select
            className="sr-input sr-input--num"
            value={container}
            aria-label="文件格式"
            disabled={exportKind === "midi"}
            onChange={(event) => {
              const next = event.target.value;
              setContainer(next);
              const extension = formats.find((format) => format.id === next)?.extension ?? next;
              setOutPath((current) => current.replace(/\.[a-z0-9]+$/i, `.${extension}`));
            }}
          >
            {formats.map((format) => (
              <option key={format.id} value={format.id} disabled={!format.available}>
                {format.id.toUpperCase()}
                {format.lossy ? "（有损）" : ""}
                {format.available ? "" : " · 需要编码器"}
              </option>
            ))}
          </select>
          <input
            className="sr-input sr-export-path"
            value={outPath}
            spellCheck={false}
            aria-label={exportKind === "stems" ? "输出目录" : "输出路径"}
            placeholder="~/Documents/ShadowRoom/exports/song.wav"
            onChange={(event) => setOutPath(event.target.value)}
          />
          <button
            type="button"
            className="sr-btn sr-btn--accent"
            disabled={exporting || outPath.trim() === ""}
            onClick={async () => {
              if (onExport === undefined) return;
              setExporting(true);
              setExported(null);
              const written = await onExport({
                kind: exportKind,
                ...(exportKind === "stems"
                  ? { out_dir: outPath.trim(), name: project.name.replace(/\s+/g, "-") }
                  : { out_path: outPath.trim() }),
                bpm: project.bpm,
                bars: project.bars,
                ...(exportKind === "midi"
                  ? {}
                  : { sample_rate: sampleRate, bit_depth: bitDepth, container }),
                tracks: project.tracks.map((track) => ({
                  name: track.name,
                  gain: audible(track) ? track.volume / 100 : 0,
                  clips: track.clips
                    .filter((clip) => exportKind === "midi" || isPlayable(clip.source))
                    .map((clip) => ({
                      path: clip.source,
                      start: clip.start,
                      bars: clip.length,
                      // Same envelope the transport plays (fadeGain): the export must not be a
                      // different rule than what the user heard.
                      ...(clip.fadeIn === undefined ? {} : { fade_in: clip.fadeIn }),
                      ...(clip.fadeOut === undefined ? {} : { fade_out: clip.fadeOut }),
                      ...(clip.ramp === undefined ? {} : { ramp: clip.ramp }),
                      ...(clip.notes === undefined ? {} : { notes: clip.notes }),
                    })),
                })),
              });
              setExported(written);
              setExporting(false);
            }}
          >
            {exporting ? "导出中…" : "导出"}
          </button>
          {exported !== null && <span className="sr-studio-exported sr-mono">已写入 {exported}</span>}
          <span className="sr-export-note">
            {(() => {
              const chosen = formats.find((format) => format.id === container);
              if (chosen === undefined) return "";
              if (!chosen.available) return `${chosen.id.toUpperCase()} 需要 ffmpeg（装好后这里会自动出现）`;
              return chosen.via === "built-in" ? "内置编码器" : `用 ${chosen.via} 编码`;
            })()}
          </span>
        </div>
      )}

      <input
        ref={filePicker}
        type="file"
        multiple
        accept="audio/*,.wav,.wave,.aif,.aiff,.mp3,.m4a,.aac,.flac,.ogg,.opus,.mid,.midi"
        className="sr-import-input"
        aria-label="选择音频文件"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void uploadAndImport(files);
        }}
      />

      {importOpen && (
        <div className="sr-studio-import-bar">
          <span className="sr-field-label sr-mono">路径</span>
          <input
            autoFocus
            value={importPath}
            spellCheck={false}
            className="sr-input sr-import-path"
            placeholder="/Users/…/loop.wav —— 直接引用磁盘上的文件"
            onChange={(event) => setImportPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setImportOpen(false);
              if (event.key === "Enter" && importPath.trim() !== "") void importFiles([importPath.trim()]);
            }}
          />
          <button
            type="button"
            className="sr-btn"
            disabled={importPath.trim() === ""}
            onClick={() => void importFiles([importPath.trim()])}
          >
            引用这个文件
          </button>
          <button type="button" className="sr-btn" disabled={onPickImport === undefined} onClick={() => void pickAndImport()}>
            从磁盘选取…
          </button>
          <span className="sr-field-label sr-mono">每个文件会新建一条同名音轨</span>
          {/* Recording settings, kept out of the transport row so the row stays one line. */}
          <button
            type="button"
            className="sr-btn sr-studio-click"
            aria-pressed={metronomeOn}
            data-on={metronomeOn || undefined}
            onClick={() =>
              setMetronomeOn((on) => {
                /**
                 * Switching it off has to switch it off *now*: a toggle that only affects the next
                 * take, while the current one keeps clicking, is a switch that lies.
                 */
                if (on) stopClicks();
                return !on;
              })
            }
            title="节拍器：录音时按 BPM 打点（click 走音频时钟，不会被录进麦克风）"
          >
            ♩ 节拍器 {metronomeOn ? "开" : "关"}
          </button>
          <button
            type="button"
            className="sr-btn sr-studio-click"
            aria-pressed={countIn}
            data-on={countIn || undefined}
            onClick={() => setCountIn((on) => !on)}
            title="预备拍：按录音后先打 4 拍再开始，避免第一拍被切掉"
          >
            预备拍 {countIn ? "开" : "关"}
          </button>
        </div>
      )}

      {/*
        Separating one clip adds four tracks at once. Refusing would make the user choose which stem
        to lose; so the project is allowed past the manual limit, and this bar says by how much —
        it is the only thing that changes when tracks are deleted, and it goes away on its own once
        the count is back inside the limit.
      */}
      {overflow !== undefined && !overflowHidden && (
        <div className="sr-studio-overflow">
          <span className="sr-studio-overflow-text">{overflow}</span>
          <button
            type="button"
            className="sr-icon-btn"
            aria-label="关闭提示"
            title="先收起提示（轨道还在）"
            onClick={() => setOverflowHidden(true)}
          >
            ×
          </button>
        </div>
      )}

      <div className="sr-studio-body">
        <div className="sr-studio-headers">
          <div className="sr-studio-headers-top" />
          <div className="sr-studio-headers-scroll sr-scroll">
            {project.tracks.map((track, trackIndex) => {
              const live = !track.muted && (anySolo ? track.soloed : true);
              const type = trackTypeOf(track);
              const colour = trackColor(track, trackIndex);
              return (
                <div
                  key={track.id}
                  className="sr-track-head"
                  data-muted={!live || undefined}
                  data-dragging={draggingTrack?.id === track.id || undefined}
                  style={{ ["--sr-track-color" as string]: colour }}
                >
                  <span className="sr-track-colour" aria-hidden="true" />
                  <input
                    className="sr-track-name"
                    value={track.name}
                    aria-label="音轨名称"
                    data-type={type}
                    title={`${track.name} · ${type === "drums" ? "鼓轨道" : type === "audio" ? "音频轨道" : "乐器轨道"} · 按住名字上下拖动可排序`}
                    onPointerDown={(event) => {
                      // Reordering starts on the name only: a clip drag that crosses the header must
                      // never reorder tracks.
                      if (event.button !== 0 || project.tracks.length < 2) return;
                      const element = event.currentTarget as HTMLInputElement;
                      const startY = event.clientY;
                      const origin = trackIndex;
                      const rows = 84;
                      /**
                       * The pointer is captured so the drag keeps reporting after the cursor leaves
                       * this 20px-tall input — without it the very first move ended the gesture
                       * (measured: reordering silently did nothing).
                       */
                      element.setPointerCapture(event.pointerId);
                      /** Where the row would land. Kept here, not in state: the drop is read once. */
                      let target: number | null = null;
                      const onMove = (moveEvent: PointerEvent) => {
                        const wanted = Math.max(
                          0,
                          Math.min(project.tracks.length - 1, origin + Math.round((moveEvent.clientY - startY) / rows)),
                        );
                        target = wanted === origin ? null : wanted;
                        setDraggingTrack(target === null ? null : { id: track.id, index: target });
                      };
                      const onUp = () => {
                        element.removeEventListener("pointermove", onMove);
                        element.removeEventListener("pointerup", onUp);
                        element.removeEventListener("pointercancel", onUp);
                        if (element.hasPointerCapture(event.pointerId)) {
                          element.releasePointerCapture(event.pointerId);
                        }
                        setDraggingTrack(null);
                        /**
                         * One drop = one edit, and it happens *here* rather than inside a state
                         * updater: StrictMode runs updaters twice, so a reorder written that way
                         * would push two snapshots (measured earlier on undo: two undos, half a step).
                         */
                        const landing = target;
                        if (landing === null) return;
                        /**
                         * A drag is not a rename: leaving the caret in the name would swallow the
                         * next ⌘Z (the app ignores shortcuts typed into a text field), so the undo
                         * of a reorder would appear to do nothing.
                         */
                        element.blur();
                        onChange((project_) => {
                          const from = project_.tracks.findIndex((entry) => entry.id === track.id);
                          if (from === -1) return project_;
                          const next = [...project_.tracks];
                          const [moved] = next.splice(from, 1);
                          next.splice(Math.max(0, Math.min(next.length, landing)), 0, moved);
                          return { ...project_, tracks: next };
                        });
                      };
                      element.addEventListener("pointermove", onMove);
                      element.addEventListener("pointerup", onUp);
                      element.addEventListener("pointercancel", onUp);
                    }}
                    onChange={(event) => updateTrack(track.id, (current) => ({ ...current, name: event.target.value }))}
                  />
                  <div className="sr-track-controls">
                    <button
                      type="button"
                      className="sr-track-toggle"
                      aria-pressed={track.muted}
                      data-on={track.muted || undefined}
                      title="静音"
                      onClick={() => updateTrack(track.id, (current) => ({ ...current, muted: !current.muted }))}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className="sr-track-toggle"
                      aria-pressed={track.soloed}
                      data-on={track.soloed || undefined}
                      title="独奏"
                      onClick={() => updateTrack(track.id, (current) => ({ ...current, soloed: !current.soloed }))}
                    >
                      S
                    </button>
                    <input
                      className="sr-fader"
                      type="range"
                      min={0}
                      max={100}
                      value={track.volume}
                      aria-label={`${track.name} 音量`}
                      onChange={(event) =>
                        updateTrack(track.id, (current) => ({ ...current, volume: Number(event.target.value) }))
                      }
                    />
                    <button
                      type="button"
                      className="sr-track-remove"
                      data-armed={confirmDelete === track.id || undefined}
                      aria-label={`删除 ${track.name}`}
                      title={confirmDelete === track.id ? "再点一次就删除（3 秒后自动取消）" : "删除轨道"}
                      onClick={() => {
                        // No system dialog: the first click arms, the second deletes, and it disarms
                        // itself after three seconds — undo brings the whole track back either way.
                        if (confirmDelete !== track.id) {
                          setConfirmDelete(track.id);
                          window.setTimeout(() => setConfirmDelete((current) => (current === track.id ? null : current)), 3000);
                          return;
                        }
                        setConfirmDelete(null);
                        onChange((current) => ({
                          ...current,
                          tracks: current.tracks.filter((entry) => entry.id !== track.id),
                        }));
                      }}
                    >
                      {confirmDelete === track.id ? "确认删除" : "×"}
                    </button>
                  </div>
                  <div className="sr-meter" aria-hidden="true">
                    <span
                      className="sr-meter-fill"
                      data-live={playing && live ? true : undefined}
                      style={{ width: `${live ? track.volume : 0}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="sr-studio-timeline sr-scroll">
          <div
            className="sr-studio-grid"
            data-sections={project.sections !== undefined && project.sections.length > 0 ? true : undefined}
            style={{ width: project.bars * barPx }}
          >
            {/* The song's shape, when the last render named it: intro / drop / break / drop 2 … */}
            {project.sections !== undefined && project.sections.length > 0 && (
              <div className="sr-studio-sections">
                {project.sections.map((section, index) => (
                  <button
                    key={`${section.name}-${index}`}
                    type="button"
                    className="sr-studio-section"
                    style={{
                      left: section.start * barPx,
                      width: Math.max(barPx, section.bars * barPx) - 1,
                    }}
                    title={`${section.name} · ${section.bars} 小节 · 点一下跳到段落开头，右键可以再来一遍或删掉`}
                    data-section-id={section.id}
                    onClick={() => seek(section.start)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (section.id === undefined) return;
                      setStructureMenu({ kind: "section", sectionId: section.id, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="sr-studio-section-name">{section.name}</span>
                    <span className="sr-studio-section-bars sr-mono">{section.bars}</span>
                  </button>
                ))}
              </div>
            )}
            <div
              className="sr-studio-ruler"
              onPointerDown={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                seek((event.clientX - box.left) / barPx);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                const bar = Math.max(0, Math.round((event.clientX - box.left) / barPx));
                setStructureMenu({ kind: "ruler", bar, x: event.clientX, y: event.clientY });
              }}
            >
              {grid.map((bar) => (
                <span key={bar} className="sr-studio-bar sr-mono" style={{ width: barPx }}>
                  {bar % 4 === 0 ? bar + 1 : ""}
                </span>
              ))}
            </div>
            {project.sections?.slice(1).map((section, index) => (
              <div
                key={`line-${section.name}-${index}`}
                className="sr-studio-section-line"
                style={{ left: section.start * barPx }}
                aria-hidden="true"
              />
            ))}
            {project.tracks.map((track, laneIndex) => (
              <div
                key={track.id}
                className="sr-studio-lane"
                data-track-id={track.id}
                data-muted={!(audible(track)) || undefined}
                style={{ ["--sr-track-color" as string]: trackColor(track, laneIndex) }}
                onDoubleClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  addClip(track.id, (event.clientX - box.left) / barPx);
                }}
              >
                {track.clips.map((clip) => {
                  /**
                   * Whether the editor opens is a property of the *clip*, not the track: an audio
                   * file has nothing to edit, but the same clip can gain notes through 转 MIDI —
                   * and after that it is editable wherever it lives. So: notes → editor, no notes →
                   * one sentence saying what to do instead.
                   */
                  const hasNotes = (clip.notes?.length ?? 0) > 0;
                  const isDrums = trackTypeOf(track) === "drums";
                  /**
                   * A drum track's empty clip opens too: the roll already knows the five voices, so
                   * "make me a beat by hand" works on a track that has no notes yet.
                   */
                  const editable = hasNotes || isDrums;
                  return (
                  <Clip
                    key={clip.id}
                    clip={clip}
                    barPx={barPx}
                    bpm={project.bpm}
                    peaks={waves[clip.id]}
                    selected={selected?.clipId === clip.id}
                    onSelect={() => {
                      setSelected({ trackId: track.id, clipId: clip.id });
                    }}
                    onSeekToStart={() => seek(clip.start)}
                    onMoveTo={(start, clientX, clientY) => {
                      const target = trackAt(clientX, clientY) ?? track.id;
                      if (target === track.id) {
                        changeClip(track.id, clip.id, (current) => ({ ...current, start }), { transient: true });
                      } else {
                        moveClipToTrack(track.id, target, clip.id, start);
                      }
                    }}
                    onResize={(length) =>
                      changeClip(track.id, clip.id, (current) => ({ ...current, length }), { transient: true })
                    }
                    onBeginEdit={() => onBeginEdit?.()}
                    onDelete={() => removeClip(track.id, clip.id)}
                    onMenu={(x, y) => setMenu({ trackId: track.id, clipId: clip.id, x, y })}
                    onOpenNotes={editable ? () => openNotes(track.id, clip.id) : undefined}
                    onAudioHint={
                      editable
                        ? undefined
                        : () =>
                            say(
                              trackTypeOf(track) === "audio"
                                ? "这个音频片段里没有音符：右键 → 转 MIDI（或让 AI 把这段旋律转成 MIDI），之后就能在钢琴卷帘里编辑。"
                                : "这个片段还没有音符：先让 AI 写一段旋律，或右键 → 转 MIDI。",
                            )
                    }
                    rendering={rendering.includes(clip.id)}
                    onDuplicate={() => {
                      const copy = { ...clip, id: `${clip.id}-copy-${Date.now().toString(36)}` };
                      updateTrack(track.id, (current) => ({ ...current, clips: [...current.clips, copy] }));
                    }}
                    splitting={splitting.includes(clip.id)}
                  />
                  );
                })}
              </div>
            ))}
{contentEndBars < project.bars && (
              <div
                className="sr-content-end"
                style={{ left: contentEndBars * barPx }}
                title={`内容末尾（第 ${Math.round(contentEndBars)} 小节）——右边是空白网格`}
                aria-hidden="true"
              />
            )}
            <div className="sr-playhead" style={{ left: playhead * barPx }} aria-hidden="true" />
          </div>
        </div>
        {/* Zoom rides the timeline's bottom-right corner, the way DAWs park it. */}
        <div className="sr-transport-zoom">
          <button type="button" className="sr-icon-btn" aria-label="缩小" title="缩小" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
            −
          </button>
          <span className="sr-mono">{Math.round(zoom * 100)}%</span>
          <button type="button" className="sr-icon-btn" aria-label="放大" title="放大" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
            +
          </button>
        </div>
      </div>

      {editing !== null &&
        (() => {
          const track = project.tracks.find((entry) => entry.id === editing.trackId);
          const clip = track?.clips.find((entry) => entry.id === editing.clipId);
          /* A drum clip opens even with no notes: the five voices are the whole point of the drum
             roll, and "write a beat by hand" starts from an empty clip. */
          const drums = track !== undefined && trackTypeOf(track) === "drums";
          if (clip === undefined || ((clip.notes?.length ?? 0) === 0 && !drums)) return null;
          return (
            <PianoRoll
              clipName={clip.name}
              bpm={project.bpm}
              drumKit={drums}
              lengthMs={(clip.length * 60_000) / project.bpm}
              notes={clip.notes ?? []}
              onChange={setNotes}
              onBeginEdit={() => onBeginEdit?.()}
              onAudition={audition}
              onClose={() => setEditing(null)}
            />
          );
        })()}

      {composer !== null && <div className="sr-studio-composer">{composer}</div>}
      <div className="sr-studio-audio" ref={audioHost} hidden />
      {storageBlocked === true && (
        <p className="sr-studio-hint sr-studio-hint--warn" role="status">
          工程没存上：本地存储满了，现在改什么都留不下 —— 先「导出音频」备份，再删掉几条不用的轨道。
        </p>
      )}
      {anySoloTrack !== undefined && (
        <p className="sr-studio-hint sr-mono">独奏中：{anySoloTrack.name}</p>
      )}
      {flash !== null && (
        <p className="sr-studio-flash" role="status">
          {flash}
        </p>
      )}

      {/* Right-click actions on a clip. */}
      {/*
        "＋ 音轨" asks one question — what kind — and nothing else: an instrument's sound is the
        agent's job, so a sound picker here would be a menu of choices a beginner cannot make yet.
      */}
      {trackMenu !== null && (
        <>
          <div className="sr-menu-backdrop" onPointerDown={() => setTrackMenu(null)} />
          <div
            className="sr-menu sr-track-menu"
            style={{ left: trackMenu.x, top: trackMenu.y }}
            role="menu"
            aria-label="加音轨"
          >
            <p className="sr-menu-title sr-mono">加一条什么音轨？</p>
            {(
              [
                { type: "instrument", label: "乐器", hint: "写旋律、和弦；打开是钢琴键盘" },
                { type: "audio", label: "音频", hint: "放导入或录音的文件；没有音符可编辑" },
                { type: "drums", label: "鼓", hint: "打开钢琴卷帘时显示 Kick / Snare / Hi-hat" },
              ] as const
            ).map((entry) => (
              <button
                key={entry.type}
                type="button"
                role="menuitem"
                className="sr-menu-item"
                onClick={() => {
                  onChange((current) => ({
                    ...current,
                    tracks: [...current.tracks, trackOfType(current.tracks, entry.type)],
                  }));
                  setTrackMenu(null);
                }}
              >
                <span className="sr-menu-label">{entry.label}</span>
                <span className="sr-menu-hint sr-mono">{entry.hint}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {structureMenu !== null && (
        <>
          <div className="sr-menu-backdrop" onPointerDown={() => setStructureMenu(null)} />
          <div
            className="sr-menu sr-clip-menu"
            style={{ left: structureMenu.x, top: structureMenu.y }}
            role="menu"
            aria-label="结构"
          >
            <p className="sr-menu-title sr-mono">
              {structureMenu.kind === "ruler" ? `第 ${structureMenu.bar + 1} 小节` : "这一段"}
            </p>
            {structureMenu.kind === "ruler" ? (
              [4, 8, 16].map((count) => (
                <button
                  key={count}
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  onClick={() => {
                    onChange((current) => insertBars(current, structureMenu.bar, count));
                    setStructureMenu(null);
                  }}
                >
                  <span className="sr-menu-label">在这里插入 {count} 小节</span>
                  <span className="sr-menu-hint sr-mono">后面所有内容整体右移</span>
                </button>
              ))
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  onClick={() => {
                    onChange((current) => duplicateSection(current, structureMenu.sectionId));
                    setStructureMenu(null);
                  }}
                >
                  <span className="sr-menu-label">再来一遍这一段</span>
                  <span className="sr-menu-hint sr-mono">复制片段，用的是同一批音频文件</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item sr-menu-item--danger"
                  onClick={() => {
                    onChange((current) => removeSection(current, structureMenu.sectionId));
                    setStructureMenu(null);
                  }}
                >
                  <span className="sr-menu-label">删掉这一段</span>
                  <span className="sr-menu-hint sr-mono">里面的片段一起删，后面的内容左移</span>
                </button>
              </>
            )}
            <button
              type="button"
              role="menuitem"
              className="sr-menu-item"
              onClick={() => {
                onChange((current) => repeatLastSection(current));
                setStructureMenu(null);
              }}
            >
              <span className="sr-menu-label">再来一遍最后一段</span>
              <span className="sr-menu-hint sr-mono">整首歌整体变成…A A</span>
            </button>
          </div>
        </>
      )}

      {menu !== null &&
        (() => {
          const track = project.tracks.find((entry) => entry.id === menu.trackId);
          const clip = track?.clips.find((entry) => entry.id === menu.clipId);
          if (track === undefined || clip === undefined) return null;
          const inside = playhead > clip.start && playhead < clip.start + clip.length;
          const close = () => {
            setMenu(null);
            setRenaming(false);
          };
          return (
            <>
              <div className="sr-menu-backdrop" onPointerDown={close} />
              <div
                className="sr-menu sr-clip-menu"
                style={{ left: menu.x, top: menu.y }}
                role="menu"
                aria-label={`${clip.name} 操作`}
              >
                <p className="sr-menu-title sr-mono">{clip.name}</p>
                {renaming ? (
                  <input
                    className="sr-input sr-menu-input"
                    autoFocus
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenaming(false);
                      if (event.key === "Enter" && nameDraft.trim() !== "") {
                        changeClip(track.id, clip.id, (current) => ({ ...current, name: nameDraft.trim() }));
                        close();
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="sr-menu-item"
                    onClick={() => {
                      setNameDraft(clip.name);
                      setRenaming(true);
                    }}
                  >
                    <span className="sr-menu-label">改名</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  onClick={() => {
                    const copy = { ...clip, id: `${clip.id}-copy-${Date.now().toString(36)}`, start: clip.start + clip.length };
                    updateTrack(track.id, (current) => ({ ...current, clips: [...current.clips, copy] }));
                    close();
                  }}
                >
                  <span className="sr-menu-label">复制到后面</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={!isPlayable(clip.source)}
                  onClick={() => {
                    changeClip(track.id, clip.id, (current) => {
                      const up = current.ramp !== undefined && current.ramp.from < current.ramp.to;
                      return {
                        ...current,
                        // Clicking again clears it; 渐强 is silence→full across the whole clip.
                        ...(up ? { ramp: undefined } : { ramp: { from: 0, to: 1 } }),
                      };
                    });
                    close();
                  }}
                >
                  <span className="sr-menu-label">{clip.ramp && clip.ramp.from < clip.ramp.to ? "取消渐强" : "渐强（0→1）"}</span>
                  <span className="sr-menu-hint sr-mono">
                    {!isPlayable(clip.source) ? "只有音频片段能渐强" : clip.ramp && clip.ramp.from < clip.ramp.to ? "当前整段 0→1 · 再点一次取消" : "整段线性升起，导出同样生效"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={!isPlayable(clip.source)}
                  onClick={() => {
                    changeClip(track.id, clip.id, (current) => {
                      const down = current.ramp !== undefined && current.ramp.from > current.ramp.to;
                      return {
                        ...current,
                        ...(down ? { ramp: undefined } : { ramp: { from: 1, to: 0 } }),
                      };
                    });
                    close();
                  }}
                >
                  <span className="sr-menu-label">{clip.ramp && clip.ramp.from > clip.ramp.to ? "取消渐弱" : "渐弱（1→0）"}</span>
                  <span className="sr-menu-hint sr-mono">
                    {!isPlayable(clip.source) ? "只有音频片段能渐弱" : clip.ramp && clip.ramp.from > clip.ramp.to ? "当前整段 1→0 · 再点一次取消" : "整段线性落下，导出同样生效"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={!isPlayable(clip.source)}
                  onClick={() => {
                    changeClip(track.id, clip.id, (current) => ({
                      ...current,
                      // Clicking an active fade again clears it — the menu item is the toggle.
                      ...(current.fadeIn ? { fadeIn: undefined } : { fadeIn: 0.5 }),
                    }));
                    close();
                  }}
                >
                  <span className="sr-menu-label">{clip.fadeIn ? "取消淡入" : "淡入 0.5s"}</span>
                  <span className="sr-menu-hint sr-mono">
                    {!isPlayable(clip.source) ? "只有音频片段能淡入" : clip.fadeIn ? "当前 0.5s · 再点一次取消" : "开头 0.5 秒线性升起"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={!isPlayable(clip.source)}
                  onClick={() => {
                    changeClip(track.id, clip.id, (current) => ({
                      ...current,
                      ...(current.fadeOut ? { fadeOut: undefined } : { fadeOut: 0.5 }),
                    }));
                    close();
                  }}
                >
                  <span className="sr-menu-label">{clip.fadeOut ? "取消淡出" : "淡出 0.5s"}</span>
                  <span className="sr-menu-hint sr-mono">
                    {!isPlayable(clip.source) ? "只有音频片段能淡出" : clip.fadeOut ? "当前 0.5s · 再点一次取消" : "结尾 0.5 秒线性落下"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={!inside}
                  onClick={() => {
                    const round = (value: number) => Math.round(value * 100) / 100;
                    const left = { ...clip, length: round(playhead - clip.start) };
                    const right = {
                      ...clip,
                      id: `${clip.id}-b-${Date.now().toString(36)}`,
                      start: playhead,
                      length: round(clip.start + clip.length - playhead),
                    };
                    updateTrack(track.id, (current) => ({
                      ...current,
                      clips: [...current.clips.filter((entry) => entry.id !== clip.id), left, right],
                    }));
                    close();
                  }}
                >
                  <span className="sr-menu-label">在播放头分割</span>
                  <span className="sr-menu-hint sr-mono">{inside ? `第 ${Math.floor(playhead) + 1} 小节` : "播放头不在片段里"}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={!isPlayable(clip.source) || converting || onConvertToMidi === undefined}
                  onClick={async () => {
                    if (clip.source === undefined || onConvertToMidi === undefined) return;
                    setConverting(true);
                    const result = await onConvertToMidi(clip.source);
                    setConverting(false);
                    const notes = result?.notes ?? [];
                    if (notes.length > 0) {
                      const notated = {
                        ...clip,
                        id: `${clip.id}-midi-${Date.now().toString(36)}`,
                        name: `${clip.name} · MIDI`,
                        start: clip.start + clip.length,
                        notes,
                        source: result?.midi_path ?? "",
                      };
                      updateTrack(track.id, (current) => ({ ...current, clips: [...current.clips, notated] }));
                    }
                    close();
                  }}
                >
                  <span className="sr-menu-label">{converting ? "识别中…" : "转 MIDI"}</span>
                  <span className="sr-menu-hint sr-mono">
                    {!isPlayable(clip.source)
                      ? "只有音频片段能转"
                      : (clip.notes?.length ?? 0) === 0
                        ? "把这段音频认成音符（哼唱、旋律都能试）"
                        : `重新识别 · 现在有 ${clip.notes?.length ?? 0} 个音符`}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  /* A drum track can be written from scratch — its roll opens on the five voices. */
                  disabled={(clip.notes?.length ?? 0) === 0 && trackTypeOf(track) !== "drums"}
                  onClick={() => {
                    openNotes(track.id, clip.id);
                    close();
                  }}
                >
                  <span className="sr-menu-label">编辑音符</span>
                  <span className="sr-menu-hint sr-mono">
                    {(clip.notes?.length ?? 0) === 0
                      ? trackTypeOf(track) === "drums"
                        ? "空鼓轨 · 直接在鼓件上点音符"
                        : "先用「转 MIDI」得到音符"
                      : `${clip.notes?.length} 个音符 · 钢琴卷帘`}
                  </span>
                </button>
                {(
                  [
                    { kind: "piano", hint: "三角波软起音，带一点混响" },
                    { kind: "bass", hint: "哼唱整体降八度的锯齿波" },
                    { kind: "strings", hint: "慢起音 pad，铺底用" },
                  ] as const
                ).map(({ kind, hint }) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className="sr-menu-item"
                    disabled={(clip.notes?.length ?? 0) === 0 || generating === clip.id}
                    onClick={() => {
                      close();
                      void generatePartTrack(clip, kind);
                    }}
                  >
                    <span className="sr-menu-label">
                      {generating === clip.id ? "生成中…" : `用这段生成${PART_PRESETS[kind].label}轨`}
                    </span>
                    <span className="sr-menu-hint sr-mono">
                      {(clip.notes?.length ?? 0) === 0
                        ? "片段里还没有音符（先转 MIDI）"
                        : `${clip.notes?.length} 个音符 → 一条新音轨 · ${hint}`}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={!isPlayable(clip.source) || onSplitStems === undefined || splitting.includes(clip.id)}
                  onClick={async () => {
                    if (clip.source === undefined || onSplitStems === undefined) return;
                    setSplitting((current) => [...current, clip.id]);
                    close();
                    await onSplitStems({
                      source: clip.source,
                      clipId: clip.id,
                      name: clip.name,
                      start: clip.start,
                      length: clip.length,
                    });
                    setSplitting((current) => current.filter((entry) => entry !== clip.id));
                  }}
                >
                  <span className="sr-menu-label">
                    {splitting.includes(clip.id) ? "分轨中…" : "分轨（Vocal / Drums / Bass / Other）"}
                  </span>
                  <span className="sr-menu-hint sr-mono">
                    {isPlayable(clip.source)
                      ? clip.stemsDir === undefined
                        ? "Demucs 本地分离，几分钟"
                        : "已分轨，可再分一次"
                      : "只有音频片段能分"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item sr-menu-item--danger"
                  onClick={() => {
                    removeClip(track.id, clip.id);
                    close();
                  }}
                >
                  <span className="sr-menu-label">删除</span>
                </button>
              </div>
            </>
          );
        })()}
    </div>
  );
}

/** One clip: drag the body to move it, the right edge to resize, Delete to remove. */
function Clip({
  clip,
  barPx,
  bpm,
  peaks,
  selected,
  onSelect,
  onSeekToStart,
  onMoveTo,
  onResize,
  onDelete,
  onMenu,
  onBeginEdit,
  onOpenNotes,
  onAudioHint,
  onDuplicate,
  splitting,
  rendering,
}: {
  clip: StudioClip;
  barPx: number;
  /** Project tempo, so fade markers can be drawn at their real width in pixels. */
  bpm: number;
  peaks?: number[];
  selected: boolean;
  onSelect: () => void;
  onSeekToStart: () => void;
  onMoveTo: (start: number, clientX: number, clientY: number) => void;
  onResize: (length: number) => void;
  onDelete: () => void;
  onMenu: (x: number, y: number) => void;
  onBeginEdit: () => void;
  /** Double-clicking a notated clip opens it in the piano roll. */
  onOpenNotes?: () => void;
  /** ...and double-clicking an audio clip says why it does not. */
  onAudioHint?: () => void;
  /** Alt-drag copies: the caller leaves this clip alone and starts dragging a duplicate. */
  onDuplicate?: () => void;
  /** A separation is running for this clip right now. */
  splitting?: boolean;
  /** The agent is re-rendering this clip's audio right now. */
  rendering?: boolean;
}) {
  const badge = analysisBadge(clip.analysis);
  const tempoNotice = tempoMismatchNotice(clip, bpm);
  const drag = useRef<{
    originX: number;
    start: number;
    length: number;
    mode: "move" | "resize";
    element: HTMLElement;
    pointerId: number;
  } | null>(null);

  const begin = (event: React.PointerEvent<HTMLElement>, mode: "move" | "resize") => {
    // Right-click opens the menu; only the primary button starts a drag (and the seek that comes
    // with it — seeking on right-click made 在播放头分割 impossible).
    if (event.button !== 0) return;
    onSelect();
    onSeekToStart();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    drag.current = {
      originX: event.clientX,
      start: clip.start,
      length: clip.length,
      mode,
      element,
      pointerId: event.pointerId,
    };
    event.stopPropagation();
  };

  /** Moves and releases are handled on the clip root, whichever element captured the pointer. */
  const track = (event: React.PointerEvent<HTMLDivElement>): boolean => {
    const active = drag.current;
    if (active === null) return false;
    const delta = (event.clientX - active.originX) / barPx;
    // A sixteenth of a bar is a sixteenth note: fine enough to place a clip on the beat, coarse
    // enough that a beginner's drag lands where it looks like it landed. Alt frees the grid.
    const unit = event.altKey ? 1 / 64 : 1 / 16;
    const quantise = (value: number) => Math.round(value / unit) * unit;
    if (active.mode === "move") {
      const start = Math.max(0, quantise(active.start + delta));
      if (start !== clip.start) onMoveTo(start, event.clientX, event.clientY);
    } else if (Math.abs(delta) >= unit) {
      onResize(Math.max(unit, quantise(active.length + delta)));
    }
    return true;
  };

  const release = () => {
    const active = drag.current;
    if (active === null) return;
    if (active.element.hasPointerCapture(active.pointerId))
      active.element.releasePointerCapture(active.pointerId);
    drag.current = null;
  };

  return (
    <div
      className="sr-clip"
      data-selected={selected || undefined}
      data-audio={isPlayable(clip.source) || undefined}
      style={{ left: clip.start * barPx, width: Math.max(barPx * 0.5, clip.length * barPx - 4) }}
      title={clip.source ?? clip.name}
      tabIndex={0}
      role="button"
      aria-label={clip.name}
      onPointerDown={(event) => {
        // Alt-drag leaves the clip where it is and drags a copy, the gesture every DAW shares.
        if (event.altKey && !event.shiftKey) onDuplicate?.();
        begin(event, "move");
      }}
      onPointerMove={(event) => {
        track(event);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect();
        onMenu(event.clientX, event.clientY);
      }}
      onDoubleClick={(event) => {
        if (onAudioHint !== undefined) {
          event.stopPropagation();
          onAudioHint();
          return;
        }
        /* `onOpenNotes` is only passed when there is something to edit (notes, or a drum kit that
           can be written from scratch) — re-checking for notes here closed the roll on an empty
           drum clip, which is exactly the case where you want to draw a beat by hand. */
        if (onOpenNotes === undefined) return;
        event.stopPropagation();
        onOpenNotes();
      }}
      onKeyDown={(event) => {
        if (event.key === "Delete" || event.key === "Backspace") onDelete();
        if (event.key === "ArrowRight") onMoveTo(clip.start + 1, 0, 0);
        if (event.key === "ArrowLeft") onMoveTo(Math.max(0, clip.start - 1), 0, 0);
      }}
    >
      <span className="sr-clip-name">{clip.name}</span>
      {/* Fade markers: a wedge over the ramped stretch, so a fade is visible where it acts. */}
      {(clip.fadeIn ?? 0) > 0 && (
        <span
          className="sr-clip-fade sr-clip-fade--in"
          aria-hidden="true"
          style={{ width: Math.max(6, (clip.fadeIn as number) * barsPerSecond(bpm) * barPx) }}
        />
      )}
      {(clip.fadeOut ?? 0) > 0 && (
        <span
          className="sr-clip-fade sr-clip-fade--out"
          aria-hidden="true"
          style={{ width: Math.max(6, (clip.fadeOut as number) * barsPerSecond(bpm) * barPx) }}
        />
      )}
      {clip.ramp !== undefined && (
        <span
          className="sr-clip-ramp"
          aria-hidden="true"
          data-up={clip.ramp.to > clip.ramp.from || undefined}
          style={{
            clipPath:
              clip.ramp.to > clip.ramp.from
                ? "polygon(0 100%, 100% 0, 100% 100%)"
                : "polygon(0 0, 100% 0, 100% 100%)",
          }}
        />
      )}
      {peaks !== undefined && (
        <span className="sr-clip-wave" aria-hidden="true">
          {peaks.map((peak, index) => (
            <i key={index} style={{ height: `${Math.max(6, Math.round(peak * 100))}%` }} />
          ))}
        </span>
      )}
      {clip.notes !== undefined && clip.notes.length > 0 && <NoteRoll notes={clip.notes} />}
      <span className="sr-clip-meta sr-mono">
        {Number(clip.length.toFixed(2))} 小节
        {badge !== "" && <span className="sr-clip-badge"> · {badge}</span>}
        {tempoNotice && <span className="sr-clip-badge sr-clip-badge--stale" title={tempoNotice}> · ⚠ {tempoNotice}</span>}
        {splitting && <span className="sr-clip-badge"> · 分轨中…</span>}
        {rendering && <span className="sr-clip-badge"> · 重渲染中…</span>}
        {clip.renderStale !== undefined && (
          <span className="sr-clip-badge sr-clip-badge--stale" title={clip.renderStale}>
            {" "}
            · ⚠ 需重渲染
          </span>
        )}
        {clip.stemsDir !== undefined && <span className="sr-clip-badge sr-clip-badge--stems"> · 已分轨</span>}
      </span>
      <span
        className="sr-clip-resize"
        aria-hidden="true"
        onPointerDown={(event) => begin(event, "resize")}
      />
    </div>
  );
}

/** Mini piano roll: every detected note as a small block, pitch on the vertical axis. */
function NoteRoll({ notes }: { notes: StudioNote[] }) {
  const start = notes.reduce((value, note) => Math.min(value, note.start_ms), Infinity);
  const end = notes.reduce((value, note) => Math.max(value, note.end_ms), 0);
  const span = Math.max(1, end - start);
  const lowest = notes.reduce((value, note) => Math.min(value, note.midi), 127);
  const highest = notes.reduce((value, note) => Math.max(value, note.midi), 0);
  const range = Math.max(1, highest - lowest);

  return (
    <span className="sr-noteroll" aria-hidden="true">
      {notes.map((note, index) => (
        <span
          key={`${note.midi}-${note.start_ms}-${index}`}
          className="sr-noteroll-note"
          style={{
            left: `${((note.start_ms - start) / span) * 100}%`,
            width: `${Math.max(2, ((note.end_ms - note.start_ms) / span) * 100)}%`,
            bottom: `${(1 - (note.midi - lowest) / range) * 100}%`,
          }}
        />
      ))}
    </span>
  );
}
