/**
 * Speaking out loud, behind an interface.
 *
 * Today the voice is the system one (`speechSynthesis`) or a configured provider's (bridge) —
 * both are played here. The interface is deliberately small: who may speak, when it started, when it
 * ended, and **why it failed**. Failures used to be swallowed (the call simply went silent after a
 * voice change); now every implementation reports through `onError`, and cancellation is explicit.
 *
 * Two rules that the call depends on:
 * - `speak()` never cancels what is already playing. Serialisation belongs to `lib/tts-queue.ts`;
 *   an implicit `cancel()` there was cutting the first sentence in half.
 * - `cancel()` is the only way to stop, and it also suppresses the cancelled utterance's callbacks,
 *   so a late `onEnd` cannot be mistaken for "finished".
 *
 * Why not keep the system voice as the main path: it gives us **no audio stream**, so no echo
 * reference and no precise barge-in (DECISIONS ADR-018/019). The provider path returns an AudioBuffer
 * we play ourselves — `synthesize()` is the shape the desktop build needs.
 */

export type VoiceInfo = {
  id: string;
  label: string;
  lang: string;
  /** Where the voice comes from, so settings can explain a list that changes per machine. */
  source: "system" | "piper" | "kokoro" | "cloud";
};

export type SpeakOptions = {
  voiceId?: string;
  rate?: number;
  pitch?: number;
  /** The first audible moment (used to measure first-audio latency). */
  onStart?: () => void;
  /** Finished, failed or cancelled — exactly once per `speak`. */
  onEnd?: () => void;
  /** A real failure with a reason the UI can show. Never a silent stop. */
  onError?: (message: string) => void;
};

export type TTSProvider = {
  /** Which voices this machine can actually use right now. */
  voices: () => Promise<VoiceInfo[]>;
  /** Speak, calling back when the audio finished (or when it was cancelled). */
  speak: (text: string, options?: SpeakOptions) => void;
  /** Stop immediately — the user is talking, or a new voice was chosen. */
  cancel: () => void;
  /** Play an utterance and hand back the audio, or null when the implementation cannot produce one. */
  synthesize: (text: string, options?: { voiceId?: string; rate?: number; pitch?: number }) => Promise<AudioBuffer | null>;
  speaking: () => boolean;
};

/** Voices worth trying, best first, for each language we ship. Names differ across OS versions. */
export const PREFERRED_VOICES: Record<"zh" | "en", string[]> = {
  zh: ["Tingting", "婷婷", "Meijia", "美佳", "Sinji", "Siri", "Google 普通话", "Microsoft Huihui", "Microsoft Yaoyao"],
  en: ["Samantha", "Ava", "Serena", "Google US English", "Microsoft Aria", "Microsoft Zira"],
};

/**
 * Pick the voices a person would actually want, out of whatever the machine has.
 *
 * Order: the curated names per language (in the order above), then any other voice for that language.
 * A machine with no voices at all returns nothing, and the caller falls back to "system default" —
 * which is also what a headless browser and a machine without voice packs look like.
 */
export function rankVoices(available: Array<{ voiceURI: string; name: string; lang: string }>, language: "zh" | "en"): VoiceInfo[] {
  const wanted = PREFERRED_VOICES[language];
  const matches = available.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  const rank = (voice: { name: string }) => {
    const index = wanted.findIndex((name) => voice.name.toLowerCase().includes(name.toLowerCase()));
    return index === -1 ? wanted.length : index;
  };
  return [...matches]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((voice) => ({ id: voice.voiceURI, label: voice.name, lang: voice.lang, source: "system" as const }));
}

/**
 * Split an answer into the pieces worth sending to the synthesizer separately.
 *
 * A call should start talking after the first sentence, not after the last one: sentence-by-sentence
 * playback is the cheapest large latency win there is (the model keeps streaming while the first
 * sentence is already in the user's ear).
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parts = trimmed
    .split(/(?<=[。！？!?…])\s*|\n+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  /**
   * A trailing fragment with no punctuation is the sentence still being written. It is handed back as
   * the remainder so the caller can wait for more text instead of speaking half a word.
   */
  return parts;
}

/**
 * Speech from a provider the user configured, played by us.
 *
 * The bytes come back through the bridge (the key never reaches the page), get decoded into an
 * AudioBuffer and played through WebAudio — which is also what the desktop build needs in order to have
 * a reference signal for echo cancellation (DECISIONS ADR-019).
 *
 * The voice is an **instance** property (`options.voice`), not a per-call one: the call rebuilds the
 * provider when the chosen voice changes, so "which voice" has exactly one answer. Passing a second
 * voice per `speak()` would be a second truth and the old one would win at random.
 */
export function createBridgeTTS(options: {
  baseUrl: string;
  credentialRef: string | null;
  protocol: string;
  model: string;
  endpointPath?: string;
  voice?: string;
  format?: string;
}): TTSProvider {
  let context: AudioContext | null = null;
  let playing: AudioBufferSourceNode | null = null;
  /** 每次 speak/cancel 递增：迟到的合成结果不得盖掉新的一句。 */
  let token = 0;
  const audioContext = () => {
    context ??= new AudioContext();
    return context;
  };
  const synthesize = async (text: string): Promise<AudioBuffer | null> => {
    const response = await fetch("/api/agent/providers/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        baseUrl: options.baseUrl,
        credentialRef: options.credentialRef,
        protocol: options.protocol,
        model: options.model,
        ...(options.endpointPath === undefined ? {} : { endpointPath: options.endpointPath }),
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        ...(options.format === undefined ? {} : { format: options.format }),
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as { audio?: string; error?: string };
    if (typeof payload.audio !== "string") {
      /**
       * 桥对合成失败返回 200 + `{error}`（key 不出本机，错误只能在体里）。以前这里返回 null、
       * 调用方当成"正常结束"，于是换了个不存在的音色后通话彻底没声。
       */
      throw new Error(payload.error ?? `供应商没有返回音频（HTTP ${response.status}）`);
    }
    const binary = atob(payload.audio);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    try {
      return await audioContext().decodeAudioData(bytes.buffer);
    } catch (cause) {
      throw new Error(`音频解码失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  return {
    voices: async () => [],
    synthesize,
    speak: (text, speakOptions) => {
      const mine = ++token;
      void synthesize(text)
        .then((buffer) => {
          if (mine !== token) return;
          if (buffer === null) {
            speakOptions?.onError?.("供应商没有返回音频");
            speakOptions?.onEnd?.();
            return;
          }
          const source = audioContext().createBufferSource();
          playing = source;
          source.buffer = buffer;
          source.connect(audioContext().destination);
          source.onended = () => {
            // cancel() 之后 onended 也会来：只有仍是当前句才算"自然播完"。
            if (playing !== source) return;
            playing = null;
            speakOptions?.onEnd?.();
          };
          source.start();
          speakOptions?.onStart?.();
        })
        .catch((cause) => {
          if (mine !== token) return;
          speakOptions?.onError?.(cause instanceof Error ? cause.message : String(cause));
          speakOptions?.onEnd?.();
        });
    },
    cancel: () => {
      token += 1;
      playing?.stop();
      playing = null;
    },
    speaking: () => playing !== null,
  };
}

/** The system-voice implementation. Works in the browser and inside Electron. */
export function createSystemTTS(): TTSProvider {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  let speaking = false;
  /** 当前这一句的取消钩子：cancel 之后它的 onend/onerror 都不许再回调。 */
  let current: { cancel: () => void } | null = null;
  /** Voices arrive asynchronously on every platform; the first call usually returns []. */
  const loadVoices = (): Promise<SpeechSynthesisVoice[]> =>
    new Promise((resolve) => {
      if (!supported) {
        resolve([]);
        return;
      }
      const immediate = window.speechSynthesis.getVoices();
      if (immediate.length > 0) {
        resolve(immediate);
        return;
      }
      const timer = window.setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1200);
      window.speechSynthesis.addEventListener(
        "voiceschanged",
        () => {
          window.clearTimeout(timer);
          resolve(window.speechSynthesis.getVoices());
        },
        { once: true },
      );
    });

  return {
    voices: async () => {
      const available = await loadVoices();
      return [
        ...rankVoices(available.map((voice) => ({ voiceURI: voice.voiceURI, name: voice.name, lang: voice.lang })), "zh"),
        ...rankVoices(available.map((voice) => ({ voiceURI: voice.voiceURI, name: voice.name, lang: voice.lang })), "en"),
      ];
    },
    speak: (text, options) => {
      if (!supported) {
        options?.onError?.("这台环境没有系统语音");
        options?.onEnd?.();
        return;
      }
      if (text.trim() === "") {
        options?.onEnd?.();
        return;
      }
      // 注意：这里**没有** speechSynthesis.cancel()。串行由队列负责；在这里 cancel 等于把
      // 上一句拦腰截断（用户听到的"死板地念"有一半来自这个）。
      const utterance = new SpeechSynthesisUtterance(text);
      const wanted = options?.voiceId;
      if (wanted !== undefined) {
        const match = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === wanted || voice.name === wanted);
        if (match !== undefined) utterance.voice = match;
      }
      utterance.lang = utterance.voice?.lang ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en-US");
      utterance.rate = options?.rate ?? 1.02;
      utterance.pitch = options?.pitch ?? 1;
      let settled = false;
      let cancelled = false;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        if (current === handle) current = null;
        speaking = false;
        if (cancelled) return;
        if (error !== undefined) options?.onError?.(error);
        options?.onEnd?.();
      };
      const handle = {
        cancel: () => {
          cancelled = true;
          if (!settled) {
            settled = true;
            speaking = false;
            if (current === handle) current = null;
          }
        },
      };
      current = handle;
      speaking = true;
      utterance.onstart = () => options?.onStart?.();
      utterance.onend = () => finish();
      utterance.onerror = (event) => finish(`系统语音失败：${event.error ?? "未知错误"}`);
      window.speechSynthesis.speak(utterance);
    },
    cancel: () => {
      if (!supported) return;
      speaking = false;
      const handle = current;
      current = null;
      handle?.cancel();
      window.speechSynthesis.cancel();
    },
    synthesize: async () => null, // a system voice cannot hand us the audio
    speaking: () => speaking,
  };
}

/**
 * 试听一次合成结果（设置页用）。
 *
 * 单独一个函数是为了让"试听"和"通话"用同一条播放链路（WebAudio），而不是设置页再手写一遍
 * AudioContext 创建/连接/关闭。
 */
export function playAudioBuffer(buffer: AudioBuffer): Promise<void> {
  const context = new AudioContext();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  return new Promise((resolve) => {
    source.onended = () => {
      void context.close();
      resolve();
    };
    source.start();
  });
}
