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
  barsPerSecond,
  duplicateSection,
  insertBars,
  notesRevision,
  removeSection,
  repeatLastSection,
  structureRevision,
  withNoteIds,
  fileUrl,
  isPlayable,
  newClip,
  newTrack,
  trackFromImport,
  analysisBadge,
  type StudioAnalysis,
  type StudioClip,
  type StudioNote,
  type StudioProject,
  type StudioTrack,
} from "../lib/studio";
import { createNotePlayer } from "../lib/synth";
import { peaksFor } from "../lib/waveform";
import { PianoRoll } from "./PianoRoll";

/** Pixels per bar at zoom 1. */
const BAR_PX = 56;

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
  onPickImport,
  onAnalyze,
  onExportFormats,
  onSplitStems,
  onNoteContextChange,
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
  /** A native "choose file…" dialog on the machine; resolves with paths to reference in place. */
  onPickImport?: () => Promise<string[]>;
  /** Tempo/key detection for one file (the analysis plugin); `null` when it could not listen. */
  onAnalyze?: (path: string, context: { wasEmpty: boolean }) => Promise<StudioAnalysis | null>;
  /** Which export containers this machine can actually write, from the generator plugin. */
  onExportFormats?: () => Promise<ExportFormat[]>;
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
  /** Clips whose separation is running right now. */
  const [splitting, setSplitting] = useState<string[]>([]);
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
  /** The clip whose notes the piano roll is editing (at most one: the editor shows one clip). */
  const [editing, setEditing] = useState<{ trackId: string; clipId: string } | null>(null);
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
      const level = audible(track) ? Math.min(1, track.volume / 100) : 0;
      for (const clip of track.clips) {
        const element = players.current.get(clip.id);
        if (element !== undefined) element.volume = level;
      }
    }
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
        const level = audible(track) ? Math.min(1, track.volume / 100) : 0;
        element.volume = level;
        if (inside) {
          const offset = Math.max(0, (bar - clip.start) * secondsPerBar);
          if (Math.abs(element.currentTime - offset) > 0.15) element.currentTime = offset;
          if (play && element.paused && level > 0) void element.play().catch(() => undefined);
          if (!play && !element.paused) element.pause();
        } else if (!element.paused) {
          element.pause();
        }
      }
    }
  };

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
      if (next >= project.bars) {
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
  }, [playing, project.bpm, project.bars, project.tracks, anySolo]);

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
      const created: Array<{ trackId: string; clipId: string }> = [];
      onChange((current) => {
        let tracks = [...current.tracks];
        const names = tracks.map((track) => track.name);
        for (const path of clean) {
          const track = trackFromImport(path, names);
          names.push(track.name);
          tracks = [...tracks, track];
          created.push({ trackId: track.id, clipId: track.clips[0].id });
        }
        return { ...current, tracks };
      });
      setSelected(created.at(-1) ?? null);
      setImportOpen(false);
      setImportPath("");

      for (const [index, path] of clean.entries()) {
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
        <div className="sr-transport-position sr-mono">{positionLabel}</div>
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
              inputMode="numeric"
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  bars: Math.max(4, Math.min(128, Number(event.target.value) || current.bars)),
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
            title={
              project.tracks.length >= MAX_TRACKS
                ? `最多 ${MAX_TRACKS} 条音轨；删掉一条再加，或者让智能体帮你合并`
                : `加一条音轨（上限 ${MAX_TRACKS}）`
            }
            onClick={() =>
              onChange((current) =>
                current.tracks.length >= MAX_TRACKS
                  ? current
                  : { ...current, tracks: [...current.tracks, newTrack(`音轨 ${current.tracks.length + 1}`)] },
              )
            }
          >
            <IconPlus size={14} />
            音轨
          </button>
          {project.tracks.length > MAX_TRACKS && (
            <span className="sr-transport-hint sr-mono" title={`超过上限 ${MAX_TRACKS} 条；删掉几条就恢复`}>
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
        </div>
      )}

      <div className="sr-studio-body">
        <div className="sr-studio-headers">
          <div className="sr-studio-headers-top" />
          <div className="sr-studio-headers-scroll sr-scroll">
            {project.tracks.map((track) => {
              const live = !track.muted && (anySolo ? track.soloed : true);
              return (
                <div key={track.id} className="sr-track-head" data-muted={!live || undefined}>
                  <input
                    className="sr-track-name"
                    value={track.name}
                    aria-label="音轨名称"
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
                      aria-label={`删除 ${track.name}`}
                      title="删除轨道"
                      onClick={() =>
                        onChange((current) => ({
                          ...current,
                          tracks: current.tracks.filter((entry) => entry.id !== track.id),
                        }))
                      }
                    >
                      ×
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
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className="sr-studio-lane"
                data-track-id={track.id}
                data-muted={!(audible(track)) || undefined}
                onDoubleClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  addClip(track.id, (event.clientX - box.left) / barPx);
                }}
              >
                {track.clips.map((clip) => (
                  <Clip
                    key={clip.id}
                    clip={clip}
                    barPx={barPx}
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
                    onOpenNotes={() => openNotes(track.id, clip.id)}
                    rendering={rendering.includes(clip.id)}
                    onDuplicate={() => {
                      const copy = { ...clip, id: `${clip.id}-copy-${Date.now().toString(36)}` };
                      updateTrack(track.id, (current) => ({ ...current, clips: [...current.clips, copy] }));
                    }}
                    splitting={splitting.includes(clip.id)}
                  />
                ))}
              </div>
            ))}
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
          if (clip === undefined || (clip.notes?.length ?? 0) === 0) return null;
          return (
            <PianoRoll
              clipName={clip.name}
              bpm={project.bpm}
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
      {anySoloTrack !== undefined && (
        <p className="sr-studio-hint sr-mono">独奏中：{anySoloTrack.name}</p>
      )}

      {/* Right-click actions on a clip. */}
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
                  <span className="sr-menu-hint sr-mono">{inside ? `第 ${positionLabel} 小节` : "播放头不在片段里"}</span>
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
                    {isPlayable(clip.source) ? `${clip.notes?.length ?? 0} 个音符` : "只有音频片段能转"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sr-menu-item"
                  disabled={(clip.notes?.length ?? 0) === 0}
                  onClick={() => {
                    openNotes(track.id, clip.id);
                    close();
                  }}
                >
                  <span className="sr-menu-label">编辑音符</span>
                  <span className="sr-menu-hint sr-mono">
                    {(clip.notes?.length ?? 0) === 0 ? "先用「转 MIDI」得到音符" : `${clip.notes?.length} 个音符 · 钢琴卷帘`}
                  </span>
                </button>
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
                    {splitting.includes(clip.id) ? "分轨中…" : "分轨（人声 / 鼓 / 贝斯 / 其它）"}
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
  onDuplicate,
  splitting,
  rendering,
}: {
  clip: StudioClip;
  barPx: number;
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
  /** Alt-drag copies: the caller leaves this clip alone and starts dragging a duplicate. */
  onDuplicate?: () => void;
  /** A separation is running for this clip right now. */
  splitting?: boolean;
  /** The agent is re-rendering this clip's audio right now. */
  rendering?: boolean;
}) {
  const badge = analysisBadge(clip.analysis);
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
        if ((clip.notes?.length ?? 0) === 0 || onOpenNotes === undefined) return;
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
        {splitting && <span className="sr-clip-badge"> · 分轨中…</span>}
        {rendering && <span className="sr-clip-badge"> · 重渲染中…</span>}
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
