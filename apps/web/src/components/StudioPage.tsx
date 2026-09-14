/**
 * Studio — the multi-track page.
 *
 * Layout follows the DAWs this is modelled on (GarageBand / FL Studio): a transport strip on top, a
 * fixed column of track headers on the left (name, mute/solo, fader, meter), and a scrolling
 * bar-ruled timeline of clips on the right, with the composer docked underneath so the agent sits
 * where the transport controls live in those apps.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconPause, IconPlay, IconPlus, IconStop } from "./icons";
import {
  newClip,
  newTrack,
  type StudioClip,
  type StudioProject,
  type StudioTrack,
} from "../lib/studio";

/** Pixels per bar on the timeline. */
const BAR_PX = 56;

export function StudioPage({
  project,
  onChange,
  composer,
  onClose,
}: {
  project: StudioProject;
  onChange: (next: StudioProject) => void;
  composer: ReactNode;
  onClose: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0); // bars
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null);
  const frame = useRef<number | null>(null);
  const last = useRef<number>(0);

  // Transport: the playhead advances in real time at the project tempo (4/4).
  useEffect(() => {
    if (!playing) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      return;
    }
    last.current = performance.now();
    const tick = (now: number) => {
      const seconds = (now - last.current) / 1000;
      last.current = now;
      setPlayhead((bars) => {
        const next = bars + (seconds * project.bpm) / 4;
        return next >= project.bars ? 0 : next;
      });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [playing, project.bpm, project.bars]);

  const updateTrack = (trackId: string, patch: (track: StudioTrack) => StudioTrack) => {
    onChange({ ...project, tracks: project.tracks.map((track) => (track.id === trackId ? patch(track) : track)) });
  };

  const addClip = (trackId: string, start: number) => {
    const track = project.tracks.find((entry) => entry.id === trackId);
    if (track === undefined) return;
    const clip = newClip(`${track.name} ${track.clips.length + 1}`, Math.max(0, Math.round(start)), 4);
    updateTrack(trackId, (current) => ({ ...current, clips: [...current.clips, clip] }));
    setSelected({ trackId, clipId: clip.id });
  };

  const moveClip = (trackId: string, clipId: string, start: number) => {
    updateTrack(trackId, (track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === clipId ? { ...clip, start: Math.max(0, Math.round(start)) } : clip,
      ),
    }));
  };

  const anySolo = project.tracks.some((track) => track.soloed);
  const position = `${Math.floor(playhead) + 1}.${Math.floor((playhead % 1) * 4) + 1}`;

  return (
    <div className="sr-studio">
      <header className="sr-studio-transport">
        <button
          type="button"
          className="sr-btn sr-studio-back"
          onClick={onClose}
          title="回到工程列表"
        >
          ‹ 工程
        </button>
        <div className="sr-transport-buttons">
          <button
            type="button"
            className="sr-icon-btn sr-transport-play"
            aria-label={playing ? "暂停" : "播放"}
            title={playing ? "暂停" : "播放"}
            aria-pressed={playing}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>
          <button
            type="button"
            className="sr-icon-btn"
            aria-label="停止"
            title="停止"
            onClick={() => {
              setPlaying(false);
              setPlayhead(0);
            }}
          >
            <IconStop size={14} />
          </button>
        </div>
        <div className="sr-transport-position sr-mono">{position}</div>
        <div className="sr-transport-fields">
          <label className="sr-transport-field">
            <span className="sr-field-label sr-mono">BPM</span>
            <input
              className="sr-input sr-input--num"
              value={project.bpm}
              inputMode="numeric"
              onChange={(event) =>
                onChange({ ...project, bpm: Math.max(40, Math.min(220, Number(event.target.value) || project.bpm)) })
              }
            />
          </label>
          <label className="sr-transport-field">
            <span className="sr-field-label sr-mono">调性</span>
            <input
              className="sr-input sr-input--key"
              value={project.key}
              onChange={(event) => onChange({ ...project, key: event.target.value })}
            />
          </label>
          <label className="sr-transport-field">
            <span className="sr-field-label sr-mono">小节</span>
            <input
              className="sr-input sr-input--num"
              value={project.bars}
              inputMode="numeric"
              onChange={(event) =>
                onChange({ ...project, bars: Math.max(4, Math.min(128, Number(event.target.value) || project.bars)) })
              }
            />
          </label>
        </div>
        <button
          type="button"
          className="sr-btn sr-studio-addtrack"
          onClick={() => onChange({ ...project, tracks: [...project.tracks, newTrack(`音轨 ${project.tracks.length + 1}`)] })}
        >
          <IconPlus size={14} />
          音轨
        </button>
      </header>

      <div className="sr-studio-body">
        <div className="sr-studio-headers">
          <div className="sr-studio-headers-top" />
          <div className="sr-studio-headers-scroll sr-scroll">
            {project.tracks.map((track) => {
              const audible = !track.muted && (anySolo ? track.soloed : true);
              return (
                <div key={track.id} className="sr-track-head" data-muted={!audible || undefined}>
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
                  </div>
                  <div className="sr-meter" aria-hidden="true">
                    <span
                      className="sr-meter-fill"
                      data-live={playing && audible ? true : undefined}
                      style={{ width: `${audible ? track.volume : 0}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="sr-studio-timeline sr-scroll">
          <div className="sr-studio-grid" style={{ width: project.bars * BAR_PX }}>
            <div className="sr-studio-ruler">
              {Array.from({ length: project.bars }, (_, bar) => (
                <span key={bar} className="sr-studio-bar sr-mono" style={{ width: BAR_PX }}>
                  {bar % 4 === 0 ? bar + 1 : ""}
                </span>
              ))}
            </div>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className="sr-studio-lane"
                data-muted={(!(!track.muted && (anySolo ? track.soloed : true))) || undefined}
                onDoubleClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  addClip(track.id, (event.clientX - box.left) / BAR_PX);
                }}
              >
                {track.clips.map((clip) => (
                  <Clip
                    key={clip.id}
                    clip={clip}
                    selected={selected?.clipId === clip.id}
                    onSelect={() => setSelected({ trackId: track.id, clipId: clip.id })}
                    onMove={(start) => moveClip(track.id, clip.id, start)}
                    onDelete={() => {
                      updateTrack(track.id, (current) => ({
                        ...current,
                        clips: current.clips.filter((entry) => entry.id !== clip.id),
                      }));
                      setSelected(null);
                    }}
                  />
                ))}
              </div>
            ))}
            <div className="sr-playhead" style={{ left: playhead * BAR_PX }} aria-hidden="true" />
          </div>
        </div>
      </div>

      <div className="sr-studio-composer">{composer}</div>
    </div>
  );
}

/** One clip: drag it along its lane to move it, click to select, Delete removes it. */
function Clip({
  clip,
  selected,
  onSelect,
  onMove,
  onDelete,
}: {
  clip: StudioClip;
  selected: boolean;
  onSelect: () => void;
  onMove: (start: number) => void;
  onDelete: () => void;
}) {
  const drag = useRef<{ originX: number; startBar: number } | null>(null);
  return (
    <div
      className="sr-clip"
      data-selected={selected || undefined}
      style={{ left: clip.start * BAR_PX, width: clip.length * BAR_PX - 4 }}
      title={clip.source ?? clip.name}
      tabIndex={0}
      role="button"
      aria-label={clip.name}
      onPointerDown={(event) => {
        onSelect();
        drag.current = { originX: event.clientX, startBar: clip.start };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = (event.clientX - active.originX) / BAR_PX;
        if (Math.abs(delta) >= 0.5) onMove(active.startBar + Math.round(delta));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (event.key === "Delete" || event.key === "Backspace") onDelete();
        if (event.key === "ArrowRight") onMove(clip.start + 1);
        if (event.key === "ArrowLeft") onMove(Math.max(0, clip.start - 1));
      }}
    >
      <span className="sr-clip-name">{clip.name}</span>
      <span className="sr-clip-meta sr-mono">{clip.length} 小节</span>
    </div>
  );
}
