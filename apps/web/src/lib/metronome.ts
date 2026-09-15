/**
 * A click track that stays on the beat.
 *
 * The scheduler is the whole point: firing a click from `setInterval` drifts audibly within a couple
 * of bars, so this wakes up every {@link LOOKAHEAD_MS} and schedules every click that falls inside the
 * next {@link SCHEDULE_MS} directly on the AudioContext's own clock, where `start` is sample accurate.
 * `setInterval` decides *when to look*, never when to sound.
 *
 * The maths lives in {@link metronomeTimes} so it can be tested without an audio device: an audio
 * test would only ever prove that the machine has speakers.
 */

/** How often the scheduler wakes up. */
export const LOOKAHEAD_MS = 25;
/** How far ahead clicks are scheduled on the audio clock. */
export const SCHEDULE_MS = 120;

/** Beats per bar; the studio is 4/4 everywhere, including here. */
const BEATS_PER_BAR = 4;

/**
 * The times (in seconds, on the audio clock) of the clicks that fall inside `[from, to)`.
 *
 * @param from - the window start, in AudioContext seconds.
 * @param to - the window end (exclusive), in AudioContext seconds.
 * @param startTime - when the click track began, in AudioContext seconds.
 * @param bpm - tempo. A value ≤ 0 yields no clicks rather than an infinite loop.
 * @returns the times, oldest first.
 */
export function metronomeTimes(from: number, to: number, startTime: number, bpm: number): number[] {
  if (!(bpm > 0) || to <= from) return [];
  const beat = 60 / bpm;
  const firstIndex = Math.max(0, Math.ceil((from - startTime) / beat));
  const times: number[] = [];
  for (let index = firstIndex; startTime + index * beat < to; index += 1) {
    const time = startTime + index * beat;
    if (time >= from) times.push(time);
    if (times.length > 512) break; // a guard, not a musical decision
  }
  return times;
}

/** Which beat of the bar a click index lands on: 0 is the downbeat. */
export function beatInBar(index: number): number {
  return ((index % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
}

type Options = {
  /** Where the clicks come from (a real AudioContext in the app, a fake one in tests). */
  context: BaseAudioContext;
  /** The node everything is scheduled through, so one gain can mute the lot. */
  destination: AudioNode;
  bpm: number;
  /** Called with (click index, seconds) as each click is scheduled — used to flash the UI. */
  onSchedule?: (index: number, at: number) => void;
};

/**
 * Click track handle: `start()`, `stop()`, and the running click index.
 *
 * Every click is two short sine bursts (the downbeat is a different pitch) scheduled on the audio
 * clock. Nothing is scheduled while stopped, and `stop()` cancels the wake-ups rather than muting
 * them, so nothing sounds after it.
 */
export function createMetronome({ context, destination, bpm, onSchedule }: Options) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startTime = 0;
  let nextIndex = 0;

  const click = (index: number, at: number) => {
    const downbeat = beatInBar(index) === 0;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = downbeat ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(downbeat ? 0.22 : 0.14, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    oscillator.connect(gain).connect(destination);
    oscillator.start(at);
    oscillator.stop(at + 0.06);
    onSchedule?.(index, at);
  };

  const pump = () => {
    const now = context.currentTime;
    const until = now + SCHEDULE_MS / 1000;
    for (const at of metronomeTimes(now, until, startTime, bpm)) {
      // Recover this window's click index from its time, so a late wake-up does not lose beats.
      const index = Math.round((at - startTime) / (60 / bpm));
      if (index < nextIndex) continue;
      nextIndex = index + 1;
      click(index, at);
    }
  };

  return {
    /** Start clicking at `at` (default: now). Returns that time. */
    start(at?: number): number {
      if (timer !== null) return startTime;
      startTime = at ?? context.currentTime + 0.08;
      nextIndex = 0;
      pump();
      timer = setInterval(pump, LOOKAHEAD_MS);
      return startTime;
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    get running(): boolean {
      return timer !== null;
    },
    /** When the click track started, in AudioContext seconds. */
    get startTime(): number {
      return startTime;
    },
  };
}
