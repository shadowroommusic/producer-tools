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
