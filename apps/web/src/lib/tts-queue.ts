/**
 * 句级朗读队列：一个播放器、按顺序、句间留一点气口。
 *
 * 为什么要单独一层：现在的说话逻辑把多句拼成一段交给 TTS，流式回复每来一句又调一次 speak，
 * 而两个 provider 的 speak 都会先 cancel 上一句——第一句往往只说出一半。队列把"谁在说、
 * 下一句是什么、什么时候该停"收成一处，TTS provider 只负责把一段文字变成声音。
 *
 * 约束：
 * - 新句**绝不**取消当前句（打断只走 `clear()`）；
 * - `clear()` 幂等，且不触发 `onIdle`（取消不是"说完"）；
 * - 取消后迟到的 `onEnd` 不得再启动下一句（epoch 防竞态）；
 * - 超时是一条独立退出路径：播放器不回调时，队列不能永远卡在"正在说"。
 *
 * 纯逻辑、无 DOM 依赖，时间源由 `sleep` 注入，Node 可直接测。
 */

export type SpeechQueueSpeaker = {
  speak: (
    text: string,
    options: {
      voiceId?: string;
      onStart?: () => void;
      onEnd?: () => void;
      onError?: (message: string) => void;
    },
  ) => void;
  cancel: () => void;
};

export type SpeechQueueOptions = {
  /** 每次取播放器都重新问一遍：换音色/换供应商后，下一句自动用新实例。 */
  speaker: () => SpeechQueueSpeaker;
  /** 句间停顿，默认 120ms（100–160ms 都算自然）。 */
  gapMs?: number;
  /** 单句超时，默认 30s：播放器不回调时的退出路径。 */
  timeoutMs?: number;
  /** 测试注入：默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 当前在念的句子（字幕）；null = 已经没在念。 */
  onSentence?: (text: string | null) => void;
  /** 队列自然播完（取消不算）。 */
  onIdle?: () => void;
  /** 合成/播放失败；队列会继续下一句，不吞掉原因。 */
  onError?: (message: string, text: string) => void;
};

export type SpeechQueue = {
  /** 入队；空白文本被忽略并返回 false。 */
  push: (text: string, options?: { voiceId?: string }) => boolean;
  /** 取消当前句并清空队列（幂等）。 */
  clear: () => void;
  /** 还没念完的句数（含正在念的那句）。 */
  pending: () => number;
  /** 是否正在播（含句间停顿）。 */
  busy: () => boolean;
  /** 队列自然播完时 resolve；被 clear 取消时也会 resolve（调用方看 onIdle 区分）。 */
  whenIdle: () => Promise<void>;
};

/** 默认句间停顿：比 TTS 自身句尾的静音再补一点，听感才不像连读。 */
export const SPEECH_GAP_MS = 120;
/** 默认单句超时。 */
export const SPEECH_TIMEOUT_MS = 30_000;

type SpeechItem = { text: string; voiceId?: string };

export function createSpeechQueue(options: SpeechQueueOptions): SpeechQueue {
  const gapMs = options.gapMs ?? SPEECH_GAP_MS;
  const timeoutMs = options.timeoutMs ?? SPEECH_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let items: SpeechItem[] = [];
  /** 每次 clear 递增：迟到的回调靠它作废。 */
  let epoch = 0;
  let pumping = false;
  /** 正在播的那一句的收尾函数（clear/超时用）。 */
  let finishCurrent: (() => void) | null = null;
  let waiters: Array<() => void> = [];

  const settleWaiters = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const speakOnce = (item: SpeechItem, token: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const speaker = options.speaker();
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        if (finishCurrent === finish) finishCurrent = null;
        resolve();
      };
      finishCurrent = finish;
      timer = setTimeout(() => {
        if (token === epoch) {
          options.onError?.(`朗读超时（${Math.round(timeoutMs / 1000)} 秒）`, item.text);
          // 卡住的播放器要收掉，否则下一句会叠在它上面。
          speaker.cancel();
        }
        finish();
      }, timeoutMs);
      try {
        speaker.speak(item.text, {
          ...(item.voiceId === undefined ? {} : { voiceId: item.voiceId }),
          onEnd: finish,
          onError: (message) => {
            if (token === epoch) options.onError?.(message, item.text);
            finish();
          },
        });
      } catch (cause) {
        options.onError?.(cause instanceof Error ? cause.message : String(cause), item.text);
        finish();
      }
    });

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    const myEpoch = epoch;
    try {
      while (items.length > 0 && myEpoch === epoch) {
        const item = items.shift() as SpeechItem;
        options.onSentence?.(item.text);
        await speakOnce(item, myEpoch);
        if (myEpoch !== epoch) break;
        if (items.length > 0) await sleep(gapMs);
      }
    } finally {
      pumping = false;
      // clear 之后又 push 了新句：重新起泵（clear 期间 pump 还在跑时的边界）。
      if (items.length > 0) {
        void pump();
        return;
      }
      if (myEpoch === epoch) {
        options.onSentence?.(null);
        options.onIdle?.();
      }
      settleWaiters();
    }
  };

  return {
    push: (text, pushOptions) => {
      const trimmed = text.trim();
      if (trimmed === "") return false;
      items.push({
        text: trimmed,
        ...(pushOptions?.voiceId === undefined || pushOptions.voiceId === "" ? {} : { voiceId: pushOptions.voiceId }),
      });
      void pump();
      return true;
    },
    clear: () => {
      /** 没有在播、队列也空：什么都不做（幂等，且不误伤下一句）。 */
      if (finishCurrent === null && items.length === 0) return;
      epoch += 1;
      items = [];
      const finish = finishCurrent;
      finishCurrent = null;
      if (finish !== null) {
        options.speaker().cancel();
        finish();
      }
      options.onSentence?.(null);
      // 取消不是"说完"：这里不调 onIdle，但等待者要放行，免得调用方永远等下去。
      settleWaiters();
    },
    pending: () => items.length + (finishCurrent === null ? 0 : 1),
    busy: () => pumping,
    whenIdle: () =>
      pumping || items.length > 0 || finishCurrent !== null ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve(),
  };
}
