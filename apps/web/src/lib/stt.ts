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
  /**
   * 整句识别（桥式 / 云端）：通话先录一段，说完再交给它。
   *
   * 有这个方法 = 回合制提供者：`start()` 是空会话，调用方**不要**等 partial，直接在
   * 回合结束时把手里的 WAV 递给它。没有这个方法 = 流式提供者（浏览器自带的那种）。
   * 形状刻意写进接口：App 的通话状态机只问一次「你有没有 transcribe」，不猜协议。
   */
  transcribe?: (wav: Blob) => Promise<{ text: string } | { error: string }>;
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

/**
 * 桥式整句识别：录音 → `POST /api/agent/providers/stt`（key 留在桥里）→ 文字。
 *
 * 为什么需要它：Chrome 的 SpeechRecognition 要连 Google 的识别服务——国内基本连不上，
 * 桌面包里更没有这个 API（ADR-018）。用户 2026-10 的实测结论「通话根本用不了」就是从这来的。
 * MiniMax 的形状已实测（`/v1/speech_to_text`，multipart，`asr-1.0`），协议名走能力配置。
 */
export function createBridgeSTT(options: {
  baseUrl: string;
  credentialRef: string | null;
  protocol: string;
  model: string;
}): STTProvider {
  return {
    supported: () => true,
    source: () => "bridge",
    /** 回合制：没有流式会话可开。 */
    start: () => ({ stop: () => undefined }),
    transcribe: async (wav) => {
      try {
        const bytes = new Uint8Array(await wav.arrayBuffer());
        let binary = "";
        const chunkSize = 0x8000;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
        }
        const response = await fetch("/api/agent/providers/stt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            audio: btoa(binary),
            format: "wav",
            baseUrl: options.baseUrl,
            credentialRef: options.credentialRef,
            protocol: options.protocol,
            protocolName: options.protocol,
            model: options.model,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
        if (typeof payload.text === "string") return { text: payload.text };
        return { error: payload.error ?? `识别失败（HTTP ${response.status}）` };
      } catch (cause) {
        return { error: `识别失败：${cause instanceof Error ? cause.message : String(cause)}` };
      }
    },
  };
}
