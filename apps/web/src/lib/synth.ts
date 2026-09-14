/**
 * Note playback for notated clips.
 *
 * The studio draws a mini piano roll for a clip that carries notes (a hummed melody, a MIDI clip),
 * so it has to *play* them too — a clip you can see and cannot hear reads as broken. Notes are
 * scheduled on one shared `AudioContext` with a short attack/release envelope, ahead of time, which
 * keeps them on the grid instead of following whatever the animation frame is doing.
 */
import type { StudioNote } from "./studio";

/** One playing clip: everything it scheduled, stoppable as a unit. */
export type NoteVoice = {
  stop: () => void;
};

export type NotePlayer = {
  /** The shared context. Created lazily, because browsers want a gesture first. */
  context: () => AudioContext;
  /**
   * Schedule a clip's notes.
   * @param notes - the clip's notes, milliseconds relative to the clip.
   * @param options - `leadSeconds` is how far the clip's zero is from *now* (so notes already passed
   *   are skipped when seeking into the middle); `gain` is the track's level, 0–1.
   * @returns a handle that stops whatever was scheduled, or `null` when there was nothing to play.
   */
  play: (notes: StudioNote[], options: { leadSeconds: number; gain: number }) => NoteVoice | null;
  /** Suspend the context (no sound while the transport is stopped). */
  quiet: () => void;
};

/** MIDI note number → frequency in Hz. */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function createNotePlayer(): NotePlayer {
  let context: AudioContext | null = null;
  const contextFor = (): AudioContext => {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    return context;
  };

  return {
    context: contextFor,
    quiet: () => {
      if (context !== null && context.state === "running") void context.suspend();
    },
    play: (notes, { leadSeconds, gain }) => {
      const live = notes.filter((note) => note.end_ms / 1000 + leadSeconds > 0);
      if (live.length === 0 || gain <= 0) return null;
      const audio = contextFor();
      const nodes: AudioScheduledSourceNode[] = [];
      const master = audio.createGain();
      // Keep a notated part under the rendered audio: the same clip can be playing underneath.
      master.gain.value = Math.min(0.5, gain * 0.35);
      master.connect(audio.destination);
      for (const note of live) {
        const start = audio.currentTime + leadSeconds + note.start_ms / 1000;
        const end = audio.currentTime + leadSeconds + note.end_ms / 1000;
        if (end <= audio.currentTime) continue;
        const oscillator = audio.createOscillator();
        oscillator.type = "triangle";
        oscillator.frequency.value = midiToHz(note.midi);
        const envelope = audio.createGain();
        const from = Math.max(audio.currentTime, start);
        const attack = Math.min(0.008, Math.max(0.001, (end - from) / 4));
        envelope.gain.setValueAtTime(0.0001, from);
        envelope.gain.linearRampToValueAtTime(1, from + attack);
        envelope.gain.setValueAtTime(1, Math.max(from + attack, end - 0.05));
        envelope.gain.linearRampToValueAtTime(0.0001, end);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(from);
        oscillator.stop(end + 0.02);
        nodes.push(oscillator);
      }
      return {
        stop: () => {
          for (const node of nodes) {
            try {
              node.stop();
            } catch {
              /* already stopped */
            }
          }
          master.disconnect();
        },
      };
    },
  };
}
