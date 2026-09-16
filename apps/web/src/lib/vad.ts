/**
 * 话音能量表：给悬浮球（和以后任何需要「谁在说话」的 UI）吃共享麦克风流。
 *
 * 契约（任务 13）：AnalyserNode `fftSize=256`，每帧取时域算 RMS 作振幅——不 own 流、不做
 * getUserMedia（那是 `lib/mic.ts` 引用计数管理器的职责）；流换了（设备插拔）跟着换 Analyser。
 * 灵敏度校准用相对值：RMS 除以运行峰值，安静环境不会永远「在说话」。
 */

export type VoiceMeter = {
  /** 当前振幅 0–1（相对最近的峰值电平）。 */
  level: () => number;
  /** 停表并释放 Analyser（不动麦克风的引用计数）。 */
  stop: () => void;
};

const FFT_SIZE = 256;
/** RMS 高于运行峰值的这个比例才算「在说话」。 */
const SPEAK_GATE = 0.12;

export function createVoiceMeter(stream: MediaStream): VoiceMeter {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  source.connect(analyser);
  const buffer = new Uint8Array(analyser.fftSize);
  let peak = 0.0001;
  let lastRms = 0;
  let stopped = false;

  const measure = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const value = (buffer[index] - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / buffer.length);
    lastRms = rms;
    // 运行峰值慢升快降：环境变响会短暂抬高门槛，安静下来几秒就恢复灵敏。
    peak = Math.max(rms, peak * 0.995, 0.02);
    window.requestAnimationFrame(measure);
  };
  window.requestAnimationFrame(measure);

  return {
    level: () => (peak > 0 ? Math.min(1, lastRms / (peak * SPEAK_GATE * 8)) : 0),
    stop: () => {
      stopped = true;
      source.disconnect();
      void context.close();
    },
  };
}

/**
 * 「在说话吗」的滞回：超过门槛算说话，**静音 1.5 秒**才回待机（任务 13 定的回待机时长）——
 * 一句中间的换气不该让球闪暗。
 */
export class SpeechLatch {
  private lastVoiceAt = 0;

  constructor(private readonly holdMs = 1500) {}

  update(level: number, now: number = Date.now()): boolean {
    if (level > 0.25) this.lastVoiceAt = now;
    return now - this.lastVoiceAt < this.holdMs;
  }
}
