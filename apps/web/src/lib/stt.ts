/**
 * Turning speech into text, behind an interface.
 *
 * The browser implementation wraps `SpeechRecognition` (Chrome/Edge). It is a **development**
 * implementation: Electron does not ship Chromium's speech service, so a packaged desktop build has
 * no `SpeechRecognition` at all (see DECISIONS ADR-018). The replacement — streaming sherpa-onnx
 * through the bridge, or a cloud provider — implements this same shape, and the call logic above it
 * never learns which one it is talking to.
 */

export type STTHandlers = {
  /** Words as they are recognised, before the sentence is finished. */
  onPartial?: (text: string) => void;
  /** A finished phrase — not necessarily the end of the turn; the endpointer decides that. */
  onFinal?: (text: string) => void;
  /** Recognition stopped on its own (it does that after every pause). */
  onEnd?: () => void;
  onError?: (message: string) => void;
};

export type STTSession = { stop: () => void };

export type STTProvider = {
  /** Can this machine recognise speech at all? */
  supported: () => boolean;
  /** Where recognition comes from, for the settings page and for honest error messages. */
  source: () => "browser" | "bridge" | "cloud";
  start: (handlers: STTHandlers) => STTSession;
};

type RecognitionResult = {
  isFinal: boolean;
  0: { transcript: string };
};

type RecognitionEvent = {
  resultIndex: number;
  results: { length: number } & Record<number, RecognitionResult>;
};

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** The browser's own recogniser (Chrome/Edge). Absent in Electron by design. */
export function createBrowserSTT(): STTProvider {
  return {
    supported: () => recognitionConstructor() !== null,
    source: () => "browser",
    start: (handlers) => {
      const Constructor = recognitionConstructor();
      if (Constructor === null) {
        handlers.onError?.("这个环境没有语音识别（桌面包里要用本地识别）");
        return { stop: () => undefined };
      }
      const recognition = new Constructor();
      recognition.lang = navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
      /**
       * `continuous` keeps one session alive across pauses. We still restart on `onend`, because the
       * browser ends the session anyway after a silence — see `listen()` in App.tsx.
       */
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let partial = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = result[0]?.transcript ?? "";
          if (result.isFinal) handlers.onFinal?.(text.trim());
          else partial += text;
        }
        if (partial !== "") handlers.onPartial?.(partial.trim());
      };
      recognition.onerror = (event) => handlers.onError?.(event.error ?? "语音识别失败");
      recognition.onend = () => handlers.onEnd?.();
      recognition.start();
      return { stop: () => recognition.stop() };
    },
  };
}
