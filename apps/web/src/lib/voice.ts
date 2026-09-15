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

/**
 * Can this environment capture the microphone at all?
 *
 * Deliberately *not* a question about `SpeechRecognition`: the desktop build has no browser recogniser
 * (see DECISIONS ADR-018) but very much has a microphone, and a call button that hides itself there
 * would be a lie. What recognition is available is reported inside the call, as a notice.
 */
export function voiceInputSupported(): boolean {
  return typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;
}


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
  /**
   * Quiet after speech that closes the turn, in ms. A function gets the words recognised so far,
   * which is how a finished sentence can be answered sooner than a dangling "但是…".
   */
  silenceMs?: number | ((heard: string) => number);
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
  /** Tell the detector what has been recognised so far (the adaptive silence reads it). */
  heard: (text: string) => void;
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
  const holdMs = options.holdMs ?? 70;
  const silenceFor = (heard: string) =>
    typeof options.silenceMs === "function" ? options.silenceMs(heard) : (options.silenceMs ?? 900);
  /** Noise floor: falls immediately, creeps back up, so speech itself never becomes the baseline. */
  let floor = speechLevel;
  let loudSince: number | null = null;
  let lastVoiceAt = 0;
  let speaking = false;
  let turnOpen = false;
  /** The words recognised during this turn, for the adaptive silence. */
  let heard = "";

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
      if (speaking && now - lastVoiceAt >= silenceFor(heard)) {
        speaking = false;
        turnOpen = false;
        options.onTurnEnd?.();
      }
    },
    reset: () => {
      loudSince = null;
      speaking = false;
      turnOpen = false;
      heard = "";
    },
    heard: (text) => {
      heard = text;
    },
    inTurn: () => speaking,
  };
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

/**
 * Upload a recording through the agent bridge and get back the path the agent can read.
 *
 * Same endpoint as a studio take (`/api/agent/record`), on purpose: there used to be two upload paths
 * with different guarantees — this one wrote whatever the browser produced, the studio's one always
 * converted to PCM WAV — so the agent could receive a webm from a voice turn and a wav from a take,
 * for no reason a user could see.
 */
export async function saveRecording(blob: Blob, label: string): Promise<string | null> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const response = await fetch("/api/agent/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `${label}-${stamp}`, extension: "wav", data: btoa(binary) }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { path?: string };
  return payload.path ?? null;
}
