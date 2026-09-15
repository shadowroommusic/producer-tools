/**
 * Speaking out loud, behind an interface.
 *
 * Today the voice is the system one (`speechSynthesis`) — good enough to test a call, and the only
 * thing that works without shipping a model. Tomorrow it is Piper or Kokoro generating an AudioBuffer
 * we play ourselves (see DECISIONS ADR-018): the reason is that a system voice gives us **no audio
 * stream**, so no echo reference, and `cancel()` is not instant. Both of those matter for a call, so
 * the interface promises more than the browser implementation can do — `synthesize()` returns an
 * AudioBuffer or null, and the call logic already handles both.
 */

export type VoiceInfo = {
  id: string;
  label: string;
  lang: string;
  /** Where the voice comes from, so settings can explain a list that changes per machine. */
  source: "system" | "piper" | "kokoro" | "cloud";
};

export type TTSProvider = {
  /** Which voices this machine can actually use right now. */
  voices: () => Promise<VoiceInfo[]>;
  /** Speak, calling back when the audio finished (or when it was cancelled). */
  speak: (text: string, options?: { voiceId?: string; rate?: number; pitch?: number; onEnd?: () => void }) => void;
  /** Stop immediately — the user is talking. */
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
 * a reference signal for echo cancellation (DECISIONS ADR-019). Returns null when the provider answers
 * with an error, so the caller can fall back to the system voice.
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
    if (payload.audio === undefined) {
      if (payload.error !== undefined) throw new Error(payload.error);
      return null;
    }
    const binary = atob(payload.audio);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return audioContext().decodeAudioData(bytes.buffer);
  };
  return {
    voices: async () => [],
    synthesize,
    speak: (text, speakOptions) => {
      void synthesize(text)
        .then((buffer) => {
          if (buffer === null) return;
          const source = audioContext().createBufferSource();
          playing?.stop();
          playing = source;
          source.buffer = buffer;
          source.connect(audioContext().destination);
          source.onended = () => {
            if (playing === source) playing = null;
            speakOptions?.onEnd?.();
          };
          source.start();
        })
        .catch(() => speakOptions?.onEnd?.());
    },
    cancel: () => {
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
      if (!supported || text.trim() === "") return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const wanted = options?.voiceId;
      if (wanted !== undefined) {
        const match = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === wanted || voice.name === wanted);
        if (match !== undefined) utterance.voice = match;
      }
      utterance.lang = utterance.voice?.lang ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en-US");
      utterance.rate = options?.rate ?? 1.02;
      utterance.pitch = options?.pitch ?? 1;
      speaking = true;
      utterance.onend = () => {
        speaking = false;
        options?.onEnd?.();
      };
      utterance.onerror = () => {
        speaking = false;
        options?.onEnd?.();
      };
      window.speechSynthesis.speak(utterance);
    },
    cancel: () => {
      if (!supported) return;
      speaking = false;
      window.speechSynthesis.cancel();
    },
    synthesize: async () => null, // a system voice cannot hand us the audio
    speaking: () => speaking,
  };
}
