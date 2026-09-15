/**
 * Interrupting the assistant by talking over it.
 *
 * The hard part is that the answer itself leaks back into the microphone. Two things make that
 * survivable:
 *
 * - **The baseline is the leakage.** We do not compare against a fixed number; we measure how loud
 *   the room is *while the answer plays* (its own echo included) and watch for a jump above that.
 * - **Two thresholds, not one.** A small rise for a short time pauses the speaking (a cough, a chair),
 *   and a bigger rise for longer cancels it (a real sentence). Pausing first means the user is not
 *   fought for the microphone, and nothing is thrown away until they clearly meant it.
 *
 * Chromium's echo canceller helps when the audio comes from the browser's own output, but the desktop
 * build plays TTS outside WebAudio (see DECISIONS ADR-018), so the detector must not assume AEC — the
 * ratios below are the ones that work *without* it.
 */

export type BargeInThresholds = {
  /** Baseline is measured for this long before thresholds are trusted. */
  calibrateMs: number;
  /** How much above the baseline counts as "maybe they started talking". */
  pauseRatio: number;
  /** …and how much counts as "they are definitely talking". */
  cancelRatio: number;
  /** Sustained time above the pause threshold. */
  pauseHoldMs: number;
  /** Sustained time above the cancel threshold. */
  cancelHoldMs: number;
  /** Absolute floor, so a quiet room's noise cannot trigger either. */
  floor: number;
};

export const DEFAULT_THRESHOLDS: BargeInThresholds = {
  calibrateMs: 300,
  pauseRatio: 1.3,
  cancelRatio: 1.7,
  pauseHoldMs: 120,
  cancelHoldMs: 200,
  floor: 0.08,
};

export type BargeInEvents = {
  /** The user might be talking: stop the sound for a moment without giving up the turn. */
  onPause?: () => void;
  /** The user is talking: the answer is cancelled and the turn is theirs. */
  onCancel?: () => void;
};

export type BargeInDetector = {
  /** The answer starts now: the baseline starts being measured from the next readings. */
  start: (now: number) => void;
  /** Feed one loudness reading (0–1) with its timestamp in milliseconds. */
  feed: (level: number, now: number) => void;
  /** Stop watching (the answer finished on its own or the call ended). */
  stop: () => void;
  /** What the detector currently believes, for tests and for the UI. */
  state: () => { baseline: number | null; paused: boolean; cancelled: boolean };
};

export function createBargeInDetector(events: BargeInEvents = {}, overrides: Partial<BargeInThresholds> = {}): BargeInDetector {
  const config: BargeInThresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  let startedAt = 0;
  let running = false;
  let baseline: number | null = null;
  let abovePauseSince: number | null = null;
  let aboveCancelSince: number | null = null;
  let lastBaselineUpdate = 0;
  let paused = false;
  let cancelled = false;

  return {
    start: (now) => {
      startedAt = now;
      lastBaselineUpdate = now;
      running = true;
      baseline = null;
      abovePauseSince = null;
      aboveCancelSince = null;
      paused = false;
      cancelled = false;
    },
    feed: (level, now) => {
      if (!running) return;
      // Calibration: the answer is already playing, so this window *is* the leakage.
      if (now - startedAt < config.calibrateMs) {
        baseline = baseline === null ? level : Math.max(baseline, level);
        return;
      }
      if (baseline === null) {
        baseline = level;
        lastBaselineUpdate = now;
        return;
      }
      const pauseLevel = Math.max(config.floor, baseline * config.pauseRatio);
      const cancelLevel = Math.max(config.floor, baseline * config.cancelRatio);

      /**
       * The baseline tracks the answer, and only the answer.
       *
       * Two rules, both learned from the unit test: it never *falls* (the answer's own pauses used to
       * drag it down, so the answer resuming looked like a barge-in and interrupted itself), and it
       * does not move while a candidate is being judged (otherwise a loud word would raise the bar it
       * has to clear, and nothing would ever count as an interruption).
       */
      const candidate = level >= pauseLevel;
      if (!candidate && level > baseline) {
        baseline += (level - baseline) * 0.05;
        lastBaselineUpdate = now;
      }

      if (level >= pauseLevel) abovePauseSince ??= now;
      else abovePauseSince = null;
      if (level >= cancelLevel) aboveCancelSince ??= now;
      else aboveCancelSince = null;

      if (!cancelled && aboveCancelSince !== null && now - aboveCancelSince >= config.cancelHoldMs) {
        cancelled = true;
        paused = false;
        events.onCancel?.();
        return;
      }
      if (!paused && abovePauseSince !== null && now - abovePauseSince >= config.pauseHoldMs) {
        paused = true;
        events.onPause?.();
      }
    },
    stop: () => {
      running = false;
      paused = false;
    },
    state: () => ({ baseline, paused, cancelled }),
  };
}

/**
 * When the user paused long enough for the turn to be over.
 *
 * A sentence that ended with punctuation is finished — waiting the full silence afterwards makes the
 * call feel slow for exactly the people who speak in complete sentences, which is most of them. A
 * trailing "但是" or "然后" means the thought is still coming, so those wait *longer*.
 */
export function turnSilenceMs(heard: string, base = 700): number {
  const text = heard.trim();
  if (text === "") return base;
  if (/[。！？!?]$/.test(text)) return Math.max(300, base - 400);
  if (/(,|，|、|；|;)$/.test(text)) return base;
  if (/(但是|然后|因为|所以|如果|而且|以及|and|but|so|because)$/i.test(text)) return base + 300;
  return base;
}
