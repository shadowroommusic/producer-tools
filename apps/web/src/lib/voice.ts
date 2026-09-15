/**
 * Voice input and output for the composer.
 *
 * Input uses the browser's speech recognition when it exists (Chrome/Edge), and output uses
 * `speechSynthesis`. Both are best-effort: without them the UI simply disables the microphone, and
 * the transcript stays the only way to talk to the agent.
 */

/**
 * The extension is spelled out because this file is also run by `node --test` (which strips types
 * instead of bundling, and resolves nothing implicitly). Vite is happy either way.
 */
import { acquireMicrophone, releaseMicrophone } from "./mic.ts";

type RecognitionResult = {
  isFinal: boolean;
  0: { transcript: string };
};

type RecognitionEvent = {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
};

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export function voiceInputSupported(): boolean {
  return recognitionConstructor() !== undefined;
}

export function voiceOutputSupported(): boolean {
  return typeof window.speechSynthesis !== "undefined";
}

export type VoiceSession = {
  stop: () => void;
};

/**
 * Endpointing for the voice call: the call listens, the *user* decides when the turn is over by
 * stopping, and the answer comes back without anyone pressing anything.
 *
 * The detector watches loudness rather than the recognizer's own phrase breaks: Chrome ends a result
 * whenever it feels like it (and `continuous` mode still splits on pauses), so a final transcript is
 * not a turn boundary — a stretch of quiet after speech is. The noise floor adapts, otherwise a room
 * with a fan in it would either never trigger or trigger on the fan.
 *
 * Pure on purpose: the maths is the part worth testing, and it must not depend on a browser.
 */
export type TurnDetectorOptions = {
  /** Loudness (0–1, the value `VoiceCapture.level()` returns) that counts as speech in a quiet room. */
  speechLevel?: number;
  /** Quiet after speech that closes the turn, in ms. */
  silenceMs?: number;
  /** How long the level must stay above the threshold before it counts as speech, in ms. */
  holdMs?: number;
  /** The user started talking again. */
  onSpeechStart?: () => void;
  /** The user spoke and then stopped: this is the end of their turn. */
  onTurnEnd?: () => void;
};

export type TurnDetector = {
  /** Feed one loudness reading with the matching timestamp (`performance.now()`). */
  feed: (level: number, now: number) => void;
  /** Back to "nothing heard yet" — call it when a new turn begins. */
  reset: () => void;
  /** True between the start of a burst of speech and the end of the turn. */
  inTurn: () => boolean;
};

/**
 * Create the endpointer used by the call.
 * @param options - thresholds and the two callbacks the call state machine hangs off.
 * @returns the detector; feed it every animation frame for the length of the call.
 */
export function createTurnDetector(options: TurnDetectorOptions = {}): TurnDetector {
  const speechLevel = options.speechLevel ?? 0.1;
  const silenceMs = options.silenceMs ?? 900;
  const holdMs = options.holdMs ?? 70;
  /** Noise floor: falls immediately, creeps back up, so speech itself never becomes the baseline. */
  let floor = speechLevel;
  let loudSince: number | null = null;
  let lastVoiceAt = 0;
  let speaking = false;
  let turnOpen = false;

  return {
    feed: (level, now) => {
      floor = level < floor ? level : floor + (level - floor) * 0.0004;
      const threshold = Math.max(speechLevel, floor * 2.5);
      if (level > threshold) {
        loudSince ??= now;
        lastVoiceAt = now;
        if (!speaking && now - loudSince >= holdMs) {
          speaking = true;
          if (!turnOpen) {
            turnOpen = true;
            options.onSpeechStart?.();
          }
        }
        return;
      }
      loudSince = null;
      if (speaking && now - lastVoiceAt >= silenceMs) {
        speaking = false;
        turnOpen = false;
        options.onTurnEnd?.();
      }
    },
    reset: () => {
      loudSince = null;
      speaking = false;
      turnOpen = false;
    },
    inTurn: () => speaking,
  };
}

/**
 * Barge-in for the answer that is playing: interrupting it must work with the mic the call already
 * holds, but the answer itself leaks into that mic (especially on speakers). So the trigger is a
 * *jump* above the running baseline — the answer's own level — not an absolute number. The first
 * half second only measures the baseline, so the answer can never cut itself off on its first word.
 */
export type BargeIn = {
  /** The answer starts here: the baseline (the answer's own leakage) is measured from now on. */
  start: (now: number) => void;
  /** Feed one loudness reading. */
  feed: (level: number, now: number) => void;
  /** True once the user has talked over the answer long enough. */
  fired: () => boolean;
  reset: () => void;
};

export function createBargeIn(options: {
  /** Called once the user has been talking over the answer for `holdMs`. */
  onSpeak: () => void;
  /** Sustained-over-baseline time before the answer is stopped, in ms. */
  holdMs?: number;
  /** How far above the baseline the voice has to be, as a ratio. */
  ratio?: number;
  /** Absolute floor, so silence around a quiet answer cannot trigger it. */
  floor?: number;
}): BargeIn {
  const holdMs = options.holdMs ?? 260;
  const ratio = options.ratio ?? 1.7;
  const floorLevel = options.floor ?? 0.16;
  /** The answer's own loudness as it leaks into the microphone; `null` until the first reading. */
  let baseline: number | null = null;
  let warmupUntil = 0;
  let loudSince: number | null = null;
  let fired = false;

  return {
    start: (now) => {
      baseline = null;
      loudSince = null;
      fired = false;
      warmupUntil = now + 500;
    },
    feed: (level, now) => {
      if (fired) return;
      baseline ??= level;
      const threshold = Math.max(floorLevel, baseline * ratio);
      if (level > threshold && now >= warmupUntil) {
        // Above the answer: this is the candidate voice. The baseline must *not* follow it, or the
        // answer's own level would rise to meet the interruption and the trigger would never fire
        // (measured: a 5%/frame EMA swallowed a 0.45 voice over a 0.18 answer in ~250ms).
        loudSince ??= now;
        if (now - loudSince >= holdMs) {
          fired = true;
          options.onSpeak();
        }
        return;
      }
      if (!(level > threshold)) {
        // Only quiet stretches teach the detector what "the answer alone" sounds like — and it is a
        // peak hold, not an average: an answer that pauses between words must not lower its own
        // threshold far enough for the next word to look like an interruption.
        baseline = Math.max(level, baseline * 0.997);
        loudSince = null;
      }
    },
    fired: () => fired,
    reset: () => {
      baseline = null;
      warmupUntil = 0;
      loudSince = null;
      fired = false;
    },
  };
}

/**
 * Start listening. Interim words are handed to `onPartial` so the draft fills while the user speaks;
 * finished phrases go to `onFinal`. Returns a handle that stops the microphone.
 */
export function startListening(
  handlers: {
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onEnd: () => void;
    onError?: (message: string) => void;
  },
): VoiceSession | null {
  const Constructor = recognitionConstructor();
  if (Constructor === undefined) return null;
  const recognition = new Constructor();
  recognition.lang = navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.onresult = (event) => {
    let partial = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) handlers.onFinal(text.trim());
      else partial += text;
    }
    if (partial !== "") handlers.onPartial(partial.trim());
  };
  recognition.onerror = (event) => {
    handlers.onError?.(event.error ?? "语音识别失败");
  };
  recognition.onend = () => handlers.onEnd();
  recognition.start();
  return { stop: () => recognition.stop() };
}

/** Speak one assistant answer (used when the turn was started by voice). */
export function speak(text: string, onEnd?: () => void): void {
  if (!voiceOutputSupported() || text.trim() === "") return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
  if (onEnd) utterance.onend = () => onEnd();
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (voiceOutputSupported()) window.speechSynthesis.cancel();
}

/** Encode mono float samples as a 16-bit PCM WAV blob (no dependencies, readable by `wave`). */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

/**
 * Live microphone capture for a voice call: keeps the PCM so a phrase can be saved as a WAV, and
 * exposes a loudness reading the waveform UI can draw.
 */
export type VoiceCapture = {
  /** Current loudness, 0–1. */
  level: () => number;
  /** WAV of everything since the previous call, and moves the marker forward. */
  takeWav: () => Blob | null;
  /** Sample rate, so the recorded file can be described. */
  sampleRate: number;
  stop: () => void;
};

export async function startCapture(): Promise<VoiceCapture | null> {
  if (navigator.mediaDevices?.getUserMedia === undefined) return null;
  /**
   * The voice mode and the 录音 button share one microphone (see `lib/mic.ts`): asking twice would
   * show two "is recording" indicators and let one of them stop a track the other is still reading.
   * The first asker's constraints win, which is why they are the ones a voice call wants.
   */
  const stream = await acquireMicrophone({ audio: { echoCancellation: true, noiseSuppression: true } });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let marker = 0;
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(context.destination);

  const wave = new Uint8Array(analyser.fftSize);
  return {
    level: () => {
      analyser.getByteTimeDomainData(wave);
      let sum = 0;
      for (let index = 0; index < wave.length; index += 1) {
        const value = (wave[index] - 128) / 128;
        sum += value * value;
      }
      return Math.min(1, Math.sqrt(sum / wave.length) * 4);
    },
    takeWav: () => {
      const slice = chunks.slice(marker);
      marker = chunks.length;
      const total = slice.reduce((count, chunk) => count + chunk.length, 0);
      if (total === 0) return null;
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of slice) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return encodeWav(merged, context.sampleRate);
    },
    sampleRate: context.sampleRate,
    stop: () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      void context.close();
      releaseMicrophone();
    },
  };
}

/** Upload a recording through the agent bridge and get back the path the agent can read. */
export async function saveRecording(blob: Blob, label: string): Promise<string | null> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const response = await fetch("/api/agent/audio", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `${label}-${stamp}.wav`, data: btoa(binary) }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { path?: string };
  return payload.path ?? null;
}
