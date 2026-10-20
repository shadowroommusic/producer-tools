/**
 * The piano roll: editing the notes inside one clip.
 *
 * Built for the beginner who just asked an agent for a melody and now wants to change two notes —
 * not for a MIDI programmer. So there is one mouse behaviour (click to create, drag to move, drag the
 * right edge to resize, right-click or Delete to remove) instead of tool modes, the grid snaps to a
 * 16th by default with Alt to escape it, and pitch is drawn as a keyboard on the left.
 *
 * Notes keep their millisecond timestamps (see `StudioNote`): the grid is presentation, and the synth
 * that plays them, the MIDI writer that exports them and the agent that edits them all speak
 * milliseconds already.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DRUM_VOICES,
  clipNoteRange,
  drumVoice,
  newNoteId,
  quantiseNotes,
  transposeNotes,
  type StudioNote,
} from "../lib/studio";
import { IconPlus, IconStop } from "./icons";
import { outOfKeyNotes, parseProjectKey, snapNotesToKey } from "../lib/studio-key";

/** Pixels per beat at zoom 1 — one bar is four of these. */
const BEAT_PX = 48;
/** Pixels per semitone. */
const ROW_PX = 13;
/** Black keys, by pitch class, for the keyboard on the left. */
const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

type Props = {
  clipName: string;
  bpm: number;
  /**
   * A drum track's roll is the same editor with different row labels: Kick/Snare/Hi-hat instead of
   * C1/D1. Notes are still MIDI — the labels are the only difference, which is what makes one
   * editor enough for both.
   */
  drumKit?: boolean;
  /**
   * 工程调性（自由文本，#bitwig-adoption B 项）：解析得出音阶时，调外音标红，
   * 工具栏多一个「量化到调」。不给/解析不出 = 老行为，什么都不标。
   */
  projectKey?: string;
  /** The clip's own length in milliseconds — notes never leave it. */
  lengthMs: number;
  notes: StudioNote[];
  /** The whole new note array; the caller owns undo and persistence. */
  onChange: (notes: StudioNote[]) => void;
  /** Called once when a gesture starts, so one undo returns to the state before it. */
  onBeginEdit: () => void;
  /** Play one note so the user hears what they are editing. */
  onAudition?: (midi: number, durationMs: number) => void;
  onClose: () => void;
};

export function PianoRoll({
  clipName,
  bpm,
  projectKey,
  drumKit = false,
  lengthMs,
  notes,
  onChange,
  onBeginEdit,
  onAudition,
  onClose,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [step, setStep] = useState(4); // grid divisions per beat: 4 = sixteenths
  const [selection, setSelection] = useState<string[]>([]);
  const drag = useRef<{
    kind: "move" | "resize" | "velocity";
    ids: string[];
    originX: number;
    originY: number;
    snapshot: StudioNote[];
    pointerId: number;
    element: HTMLElement;
  } | null>(null);

  const beatMs = 60_000 / Math.max(1, bpm);
  const stepMs = beatMs / step;
  const pixelsPerMs = (BEAT_PX * zoom) / beatMs;
  const { from, to } = useMemo(() => clipNoteRange(notes), [notes]);
  /** 调外音集合（按 note id）：工程调性解析不出时为空——标红是提示不是限制。 */
  const keyParsed = useMemo(() => parseProjectKey(projectKey), [projectKey]);
  const offKeyIds = useMemo(
    () => new Set(outOfKeyNotes(keyParsed, notes).map((note) => note.id ?? "")),
    [keyParsed, notes],
  );
  /**
   * Which pitches get a row.
   *
   * Normally that is just the range the clip uses. A drum track is different: the kit's five voices
   * are *always* there to click on — an empty drum clip opens with Kick / Snare / Clap / Hi-hat
   * waiting, which is the whole point of naming the rows. The rest of the keyboard is not taken away
   * (a note at 45 still gets its row, named by pitch), because a row that cannot be reached is a
   * dead end for anyone who learned a fill from a tutorial.
   */
  const rows = useMemo(() => {
    if (!drumKit) return Array.from({ length: to - from + 1 }, (_, index) => to - index);
    const pitches = new Set<number>();
    /* An empty drum clip opens as five rows — a kit, not a keyboard. Once a note exists outside the
       kit (a tom fill someone typed in), its row is added rather than being hidden. */
    if (notes.length > 0) {
      for (let pitch = from; pitch <= to; pitch += 1) pitches.add(pitch);
    }
    for (const voice of DRUM_VOICES) pitches.add(voice.midi);
    return [...pitches].sort((a, b) => b - a);
  }, [drumKit, from, to, notes.length]);
  /** Row index instead of `to - midi`: the drum rows are not contiguous. */
  const rowOf = (midi: number) => {
    const index = rows.indexOf(midi);
    return index === -1 ? 0 : index;
  };
  const bars = Math.max(1, Math.ceil(lengthMs / beatMs / 4));
  const width = bars * 4 * BEAT_PX * zoom;
  const height = rows.length * ROW_PX;

  /** Snap a time to the grid, unless the caller is holding Alt. */
  const snap = (ms: number, free: boolean) => (free ? ms : Math.round(ms / stepMs) * stepMs);
  const apply = (next: StudioNote[]) => onChange([...next].sort((a, b) => a.start_ms - b.start_ms));

  const commitGesture = useCallback(() => {
    const active = drag.current;
    if (active === null) return;
    drag.current = null;
    if (active.element.hasPointerCapture(active.pointerId)) {
      active.element.releasePointerCapture(active.pointerId);
    }
  }, []);

  const beginGesture = (
    event: React.PointerEvent<HTMLElement>,
    kind: "move" | "resize" | "velocity",
    ids: string[],
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onBeginEdit();
    drag.current = {
      kind,
      ids,
      originX: event.clientX,
      originY: event.clientY,
      snapshot: notes,
      pointerId: event.pointerId,
      element: event.currentTarget,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    const dxMs = (event.clientX - active.originX) / pixelsPerMs;
    const dyRows = Math.round((event.clientY - active.originY) / ROW_PX);
    const free = event.altKey;
    apply(
      active.snapshot.map((note) => {
        if (!active.ids.includes(note.id ?? "")) return note;
        if (active.kind === "resize") {
          const end = Math.max(note.start_ms + stepMs, snap(note.end_ms + dxMs, free));
          return { ...note, end_ms: Math.round(Math.min(lengthMs, end)) };
        }
        if (active.kind === "velocity") {
          return { ...note, velocity: Math.max(1, Math.min(127, (note.velocity ?? 100) - dyRows * 6)) };
        }
        const length = note.end_ms - note.start_ms;
        const start = Math.max(0, Math.min(lengthMs - length, snap(note.start_ms + dxMs, free)));
        return {
          ...note,
          start_ms: Math.round(start),
          end_ms: Math.round(start + length),
          midi: Math.max(0, Math.min(127, note.midi + dyRows)),
        };
      }),
    );
  };

  /** A click on the empty grid creates one note there (a 16th long) and auditions it. */
  const createAt = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const pitch = rows[Math.max(0, Math.min(rows.length - 1, Math.floor((event.clientY - box.top) / ROW_PX)))];
    const start = Math.max(0, Math.min(Math.max(0, lengthMs - stepMs), snap((event.clientX - box.left) / pixelsPerMs, event.altKey)));
    const note: StudioNote = {
      id: newNoteId(),
      midi: Math.max(0, Math.min(127, pitch)),
      start_ms: Math.round(start),
      end_ms: Math.round(Math.min(lengthMs, start + stepMs)),
      velocity: 100,
    };
    onBeginEdit();
    apply([...notes, note]);
    setSelection([note.id as string]);
    onAudition?.(note.midi, note.end_ms - note.start_ms);
  };

  const removeSelected = useCallback(() => {
    if (selection.length === 0) return;
    onBeginEdit();
    apply(notes.filter((note) => !selection.includes(note.id ?? "")));
    setSelection([]);
  }, [notes, onBeginEdit, selection]);

  // Keyboard editing: arrows transpose, Q quantises, Delete removes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        removeSelected();
        return;
      }
      const selected = notes.filter((note) => selection.includes(note.id ?? ""));
      if (selected.length === 0) return;
      const replaceSelected = (next: (note: StudioNote) => StudioNote) => {
        event.preventDefault();
        onBeginEdit();
        apply(notes.map((note) => (selection.includes(note.id ?? "") ? next(note) : note)));
      };
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const semitones = (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1);
        replaceSelected((note) => transposeNotes([note], semitones)[0]);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const delta = (event.key === "ArrowRight" ? 1 : -1) * stepMs;
        replaceSelected((note) => {
          const length = note.end_ms - note.start_ms;
          const start = Math.max(0, Math.min(lengthMs - length, note.start_ms + delta));
          return { ...note, start_ms: start, end_ms: start + length };
        });
      } else if (event.key.toLowerCase() === "q") {
        replaceSelected((note) => quantiseNotes([note], stepMs)[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, lengthMs, notes, onBeginEdit, removeSelected, selection, stepMs]);

  return (
    <section className="sr-roll" aria-label="钢琴卷帘">
      <header className="sr-roll-head">
        <div className="sr-roll-heading">
          <span className="sr-roll-title">{clipName}</span>
          <span className="sr-roll-meta sr-mono">
            {notes.length} 个音符 · {bars} 小节 · 网格 1/{step * 4}
            {keyParsed !== null && offKeyIds.size > 0 ? ` · 调外 ${offKeyIds.size}` : ""}
          </span>
          {drumKit && <span className="sr-roll-tag sr-mono">Drums · 按鼓件编辑</span>}
        </div>
        <div className="sr-roll-actions">
          <button
            type="button"
            className="sr-btn"
            disabled={selection.length === 0}
            title="把选中的音符对齐到网格（Q）"
            onClick={() => {
              onBeginEdit();
              apply(notes.map((note) => (selection.includes(note.id ?? "") ? quantiseNotes([note], stepMs)[0] : note)));
            }}
          >
            量化
          </button>
          <button
            type="button"
            className="sr-btn"
            disabled={keyParsed === null || (selection.length === 0 && notes.length === 0)}
            title={
              keyParsed === null
                ? "工程调性没写或没看懂（支持 Am / A minor / 8A / C大调），先在上面填一个"
                : `把${selection.length > 0 ? "选中" : "全部"}音符吸附到工程调内（并列向上）`
            }
            onClick={() => {
              onBeginEdit();
              const targets = selection.length > 0 ? selection : notes.map((note) => note.id ?? "");
              apply(
                snapNotesToKey(keyParsed, notes).map((note, index) =>
                  targets.includes(notes[index].id ?? "") ? note : notes[index],
                ),
              );
            }}
          >
            量化到调
          </button>
          <button
            type="button"
            className="sr-btn"
            disabled={selection.length === 0}
            title="升高一个半音（↑），Shift 升八度"
            onClick={() => {
              onBeginEdit();
              apply(notes.map((note) => (selection.includes(note.id ?? "") ? transposeNotes([note], 1)[0] : note)));
            }}
          >
            +½
          </button>
          <button
            type="button"
            className="sr-btn"
            disabled={selection.length === 0}
            title="降低一个半音（↓），Shift 降八度"
            onClick={() => {
              onBeginEdit();
              apply(notes.map((note) => (selection.includes(note.id ?? "") ? transposeNotes([note], -1)[0] : note)));
            }}
          >
            −½
          </button>
          <select
            className="sr-input sr-input--num"
            value={step}
            aria-label="网格"
            onChange={(event) => setStep(Number(event.target.value))}
          >
            <option value={1}>1/4</option>
            <option value={2}>1/8</option>
            <option value={4}>1/16</option>
            <option value={8}>1/32</option>
          </select>
          <button type="button" className="sr-icon-btn" aria-label="缩小" title="缩小" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}>
            −
          </button>
          <button type="button" className="sr-icon-btn" aria-label="放大" title="放大" onClick={() => setZoom((value) => Math.min(4, value + 0.25))}>
            <IconPlus size={14} />
          </button>
          <button type="button" className="sr-icon-btn" aria-label="关闭编辑器" title="关闭钢琴卷帘" onClick={onClose}>
            <IconStop size={14} />
          </button>
        </div>
      </header>

      <div className="sr-roll-body sr-scroll" data-kit={drumKit || undefined}>
        <div className="sr-roll-keys" style={{ height }}>
          {rows.map((pitch) => {
            const voice = drumKit ? drumVoice(pitch) : undefined;
            const noteName = `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
            return (
              <button
                key={pitch}
                type="button"
                className="sr-roll-key"
                data-black={BLACK.has(pitch % 12) || undefined}
                data-voice={voice?.name}
                style={{ height: ROW_PX }}
                title={voice === undefined ? `${noteName} · 点一下试听` : `${voice.name} · MIDI ${pitch} · 点一下试听`}
                onClick={() => onAudition?.(pitch, stepMs * 2)}
              >
                <span className="sr-roll-key-label sr-mono">
                  {/* Kick, Snare, Clap… stay English: they are the names on every drum machine. */}
                  {voice !== undefined
                    ? voice.name
                    : pitch % 12 === 0
                      ? `C${Math.floor(pitch / 12) - 1}`
                      : ""}
                </span>
              </button>
            );
          })}
        </div>

        <div
          className="sr-roll-surface"
          style={{ width, height, ["--sr-roll-beat" as string]: `${BEAT_PX * zoom}px`, ["--sr-roll-row" as string]: `${ROW_PX}px` }}
          onPointerDown={createAt}
        >
          {notes.map((note) => {
            const id = note.id ?? "";
            const velocity = note.velocity ?? 100;
            const voice = drumKit ? drumVoice(note.midi) : undefined;
            return (
              <div
                key={id}
                className="sr-roll-note"
                data-selected={selection.includes(id) || undefined}
                data-offkey={offKeyIds.has(id) || undefined}
                style={{
                  left: note.start_ms * pixelsPerMs,
                  width: Math.max(6, (note.end_ms - note.start_ms) * pixelsPerMs),
                  top: rowOf(note.midi) * ROW_PX + 1,
                  opacity: 0.35 + (velocity / 127) * 0.65,
                }}
                title={
                  voice === undefined
                    ? `${NAMES[note.midi % 12]}${Math.floor(note.midi / 12) - 1} · 力度 ${velocity}`
                    : `${voice.name} · 力度 ${velocity}`
                }
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const additive = event.shiftKey;
                  const nextSelection = additive
                    ? selection.includes(id)
                      ? selection
                      : [...selection, id]
                    : [id];
                  setSelection(nextSelection);
                  onAudition?.(note.midi, note.end_ms - note.start_ms);
                  beginGesture(event, event.altKey ? "velocity" : "move", nextSelection);
                }}
                onPointerMove={onPointerMove}
                onPointerUp={commitGesture}
                onPointerCancel={commitGesture}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onBeginEdit();
                  apply(notes.filter((entry) => entry.id !== id));
                }}
              >
                <span
                  className="sr-roll-handle"
                  aria-hidden="true"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setSelection([id]);
                    beginGesture(event, "resize", [id]);
                  }}
                  onPointerMove={onPointerMove}
                  onPointerUp={commitGesture}
                />
              </div>
            );
          })}
        </div>
      </div>

      <p className="sr-roll-hint">
        单击空白=加音符 · 拖动=移动 · 拖右边缘=改长度 · 右键=删除 · Shift+单击=多选 · 方向键=移调（Shift 八度）· Q=量化 · Alt+拖动=不对齐
      </p>
    </section>
  );
}
