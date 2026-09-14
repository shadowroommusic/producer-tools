/**
 * Voice input and output for the composer.
 *
 * Input uses the browser's speech recognition when it exists (Chrome/Edge), and output uses
 * `speechSynthesis`. Both are best-effort: without them the UI simply disables the microphone, and
 * the transcript stays the only way to talk to the agent.
 */

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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
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
      for (const track of stream.getTracks()) track.stop();
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
