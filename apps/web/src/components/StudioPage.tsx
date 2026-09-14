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
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconPause, IconPlay, IconPlus, IconStop } from "./icons";
import {
  barsPerSecond,
  fileUrl,
  isPlayable,
  newClip,
  newTrack,
  type StudioClip,
  type StudioNote,
  type StudioProject,
  type StudioTrack,
} from "../lib/studio";

/** Pixels per bar at zoom 1. */
const BAR_PX = 56;

export function StudioPage({
  project,
  onChange,
  composer,
  onClose,
  onExport,
}: {
  project: StudioProject;
  /** Functional update: handlers must never write from a captured snapshot. */
  onChange: (patch: (project: StudioProject) => StudioProject) => void;
  composer: ReactNode;
  onClose: () => void;
  /** Bounce the arrangement through the generator plugin; resolves with the written path. */
  onExport?: (spec: Record<string, unknown>) => Promise<string | null>;
}) {
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importTo, setImportTo] = useState<string | undefined>(undefined);
  const [exportOpen, setExportOpen] = useState(false);
  const [sampleRate, setSampleRate] = useState(44100);
  const [bitDepth, setBitDepth] = useState(16);
  const [container, setContainer] = useState<"wav" | "aiff">("wav");
  const [outPath, setOutPath] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  /** One audio element per playable clip. */
  const players = useRef<Map<string, HTMLAudioElement>>(new Map());
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
    },
    [],
  );

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

  const changeClip = (trackId: string, clipId: string, patch: (clip: StudioClip) => StudioClip) => {
    updateTrack(trackId, (track) => ({
      ...track,
      clips: track.clips.map((clip) => (clip.id === clipId ? patch(clip) : clip)),
    }));
  };

  const removeClip = (trackId: string, clipId: string) => {
    updateTrack(trackId, (track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }));
    setSelected(null);
  };

  /** Import a file from disk onto a track: bars come from its real duration once metadata lands. */
  const importClip = (path: string, trackId: string) => {
    const name = path.split("/").filter(Boolean).pop() ?? path;
    const clip = newClip(name, 0, 8, path);
    updateTrack(trackId, (track) => ({ ...track, clips: [...track.clips, clip] }));
    setSelected({ trackId, clipId: clip.id });
    if (isPlayable(path)) {
      // The real length comes from the file once its metadata lands — read the tempo from the
      // *current* project inside the updater, never from this render's snapshot.
      const probe = new Audio(fileUrl(path));
      probe.addEventListener("loadedmetadata", () => {
        if (!Number.isFinite(probe.duration) || probe.duration <= 0) return;
        onChange((current) => {
          const length = Math.max(1, Math.ceil(probe.duration * barsPerSecond(current.bpm)));
          return {
            ...current,
            tracks: current.tracks.map((track) =>
              track.id === trackId
                ? { ...track, clips: track.clips.map((entry) => (entry.id === clip.id ? { ...entry, length } : entry)) }
                : track,
            ),
          };
        });
      });
    }
    setImportOpen(false);
    setImportPath("");
  };

  const anySoloTrack = project.tracks.find((track) => track.soloed);
  const positionLabel = `${Math.floor(playhead) + 1}.${Math.floor((playhead % 1) * 4) + 1}`;
  const grid = useMemo(() => Array.from({ length: project.bars }, (_, bar) => bar), [project.bars]);
  /** Import target: whatever the picker says, falling back to the selection then the first track. */
  const importTarget = importTo ?? selected?.trackId ?? project.tracks[0]?.id;

  return (
    <div className="sr-studio">
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
        <button
          type="button"
          className="sr-btn sr-studio-addtrack"
          onClick={() =>
            onChange((current) => ({ ...current, tracks: [...current.tracks, newTrack(`音轨 ${current.tracks.length + 1}`)] }))
          }
        >
          <IconPlus size={14} />
          音轨
        </button>
        <button
          type="button"
          className="sr-btn sr-studio-import"
          onClick={() => {
            setImportTo(importTarget);
            setImportOpen((open) => !open);
          }}
        >
          导入音频
        </button>
        <button
          type="button"
          className="sr-btn sr-studio-export"
          onClick={() => {
            setOutPath(
              (current) =>
                current ||
                `~/Documents/ShadowRoom/exports/${project.name.replace(/\s+/g, "-")}.${
                  container === "aiff" ? "aiff" : "wav"
                }`,
            );
            setExportOpen((open) => !open);
          }}
        >
          导出音频
        </button>
      </header>

      {exportOpen && (
        <div className="sr-studio-import-bar sr-studio-export-bar">
          <span className="sr-field-label sr-mono">采样率</span>
          <select
            className="sr-input sr-input--num"
            value={sampleRate}
            aria-label="采样率"
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
            onChange={(event) => {
              const next = event.target.value as "wav" | "aiff";
              setContainer(next);
              setOutPath((current) => current.replace(/\.(wav|aiff)$/i, next === "aiff" ? ".aiff" : ".wav"));
            }}
          >
            <option value="wav">WAV</option>
            <option value="aiff">AIFF</option>
          </select>
          <input
            className="sr-input sr-export-path"
            value={outPath}
            spellCheck={false}
            aria-label="输出路径"
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
                out_path: outPath.trim(),
                bpm: project.bpm,
                bars: project.bars,
                sample_rate: sampleRate,
                bit_depth: bitDepth,
                container,
                tracks: project.tracks.map((track) => ({
                  name: track.name,
                  gain: audible(track) ? track.volume / 100 : 0,
                  clips: track.clips
                    .filter((clip) => isPlayable(clip.source))
                    .map((clip) => ({ path: clip.source, start: clip.start, bars: clip.length })),
                })),
              });
              setExported(written);
              setExporting(false);
            }}
          >
            {exporting ? "导出中…" : "导出"}
          </button>
          {exported !== null && <span className="sr-studio-exported sr-mono">已写入 {exported}</span>}
          <span className="sr-field-label sr-mono">MP3 / AAC 需要编码器，暂不支持</span>
        </div>
      )}

      {importOpen && (
        <div className="sr-studio-import-bar">
          <span className="sr-field-label sr-mono">文件路径</span>
          <input
            className="sr-input"
            autoFocus
            value={importPath}
            spellCheck={false}
            placeholder="/Users/…/loop.wav"
            onChange={(event) => setImportPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setImportOpen(false);
              if (event.key === "Enter" && importPath.trim() !== "" && importTarget !== undefined) {
                importClip(importPath.trim(), importTarget);
              }
            }}
          />
          <select
            className="sr-input sr-studio-import-track"
            value={importTarget}
            aria-label="放到哪条轨道"
            onChange={(event) => setImportTo(event.target.value)}
          >
            {project.tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="sr-btn sr-btn--accent"
            disabled={importPath.trim() === "" || importTarget === undefined}
            onClick={() => importTarget !== undefined && importClip(importPath.trim(), importTarget)}
          >
            放到轨道
          </button>
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
          <div className="sr-studio-grid" style={{ width: project.bars * barPx }}>
            <div
              className="sr-studio-ruler"
              onPointerDown={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                seek((event.clientX - box.left) / barPx);
              }}
            >
              {grid.map((bar) => (
                <span key={bar} className="sr-studio-bar sr-mono" style={{ width: barPx }}>
                  {bar % 4 === 0 ? bar + 1 : ""}
                </span>
              ))}
            </div>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className="sr-studio-lane"
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
                    selected={selected?.clipId === clip.id}
                    onSelect={() => {
                      setSelected({ trackId: track.id, clipId: clip.id });
                      seek(clip.start);
                    }}
                    onMove={(start) => changeClip(track.id, clip.id, (current) => ({ ...current, start }))}
                    onResize={(length) => changeClip(track.id, clip.id, (current) => ({ ...current, length }))}
                    onDelete={() => removeClip(track.id, clip.id)}
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

      {composer !== null && <div className="sr-studio-composer">{composer}</div>}
      <div className="sr-studio-audio" ref={audioHost} hidden />
      {anySoloTrack !== undefined && (
        <p className="sr-studio-hint sr-mono">独奏中：{anySoloTrack.name}</p>
      )}
    </div>
  );
}

/** One clip: drag the body to move it, the right edge to resize, Delete to remove. */
function Clip({
  clip,
  barPx,
  selected,
  onSelect,
  onMove,
  onResize,
  onDelete,
}: {
  clip: StudioClip;
  barPx: number;
  selected: boolean;
  onSelect: () => void;
  onMove: (start: number) => void;
  onResize: (length: number) => void;
  onDelete: () => void;
}) {
  const drag = useRef<{
    originX: number;
    start: number;
    length: number;
    mode: "move" | "resize";
    element: HTMLElement;
    pointerId: number;
  } | null>(null);

  const begin = (event: React.PointerEvent<HTMLElement>, mode: "move" | "resize") => {
    onSelect();
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
    if (active.mode === "move") {
      if (Math.abs(delta) >= 0.5) onMove(Math.max(0, active.start + Math.round(delta)));
    } else if (Math.abs(delta) >= 0.4) {
      onResize(Math.max(1, active.length + Math.round(delta)));
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
      onPointerDown={(event) => begin(event, "move")}
      onPointerMove={(event) => {
        track(event);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(event) => {
        if (event.key === "Delete" || event.key === "Backspace") onDelete();
        if (event.key === "ArrowRight") onMove(clip.start + 1);
        if (event.key === "ArrowLeft") onMove(Math.max(0, clip.start - 1));
      }}
    >
      <span className="sr-clip-name">{clip.name}</span>
      {clip.notes !== undefined && clip.notes.length > 0 && <NoteRoll notes={clip.notes} />}
      <span className="sr-clip-meta sr-mono">{clip.length} 小节</span>
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
