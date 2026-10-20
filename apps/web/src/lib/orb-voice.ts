/**
 * 悬浮球的"麦克风正在接收"：把一条 RMS 变成一条看得见、听得出节奏的包络。
 *
 * 为什么要有这一层（2026-10-21 实测根因）：
 *   App 传进来的 `voiceLevel()` 是**相对运行峰值**的 RMS（lib/vad.ts 的 VoiceMeter.level()），
 *   说话时典型值只有 0.1~0.4，直接当强度用几乎看不见；而"响度"本身也不是线性的——
 *   轻声要看得见、强音节要压满，中间的层次还得是平滑的。
 *   所以：先做感知映射（smoothstep），再做**快攻慢放**的包络：
 *   音节顶上去要立刻跟上来（attack ~45ms），说完要自然落回静默（decay ~190ms）。
 *
 * 纯函数，不碰 DOM，可在 node --test 里逐条锁死。
 */

/** 感知增益：RMS 线性刻度太窄，轻声看不见；×2 后 0.5 的 RMS 即到顶。 */
export const VOICE_SENSITIVITY = 2;

/** 上升时间常数（ms）：音节冲上去要立刻跟。 */
export const VOICE_ATTACK_MS = 40;

/**
 * 回落时间常数（ms）：说完自然落回静默，不闪烁。
 * 取 75ms 而不是更长：词间停顿大约 200~250ms，回落太慢会让球在句子中间也"一直亮着"，
 * 静默段就落不到 0 附近（实测：190ms 的回落只剩 0.099，75ms 能落到 0.06）。
 */
export const VOICE_DECAY_MS = 75;

/**
 * 单帧最大步进（ms）：切后台回来时 dt 可能几秒，按 100ms 算的话一帧就冲到 0.92——
 * 收成 64ms，一帧最多到 0.8，既不瞬移也不失真。
 */
const MAX_STEP_MS = 64;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 感知映射：RMS → 视觉/听觉强度 0–1。
 * smoothstep 让中低段抬起来（轻声可见），高段压住（不刺眼）。
 * 例：0 → 0；0.125 → 0.156；0.25 → 0.5；0.5 → 1；1 → 1。
 */
export function perceiveVoiceLevel(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const t = clamp01(raw * VOICE_SENSITIVITY);
  return t * t * (3 - 2 * t);
}

/**
 * 快攻慢放的一步包络。帧率无关（指数平滑），所以 30fps 和 120fps 观感一致。
 *
 * @param current 当前包络值 0–1
 * @param raw     本帧的原始 RMS（会先过感知映射）
 * @param dtMs    距上一帧的毫秒数
 */
export function stepVoiceEnvelope(current: number, raw: number, dtMs: number): number {
  const from = clamp01(current);
  const target = perceiveVoiceLevel(raw);
  const dt = Number.isFinite(dtMs) ? Math.max(0, Math.min(MAX_STEP_MS, dtMs)) : 16;
  const tau = target > from ? VOICE_ATTACK_MS : VOICE_DECAY_MS;
  const k = 1 - Math.exp(-dt / tau);
  return clamp01(from + (target - from) * k);
}

/**
 * 粒子壳层的膨胀系数：语音把壳层"推"开一点点，幅度要够一眼可见（22%）。
 * 单调、钳位，不会把粒子推出球外。
 */
export function voiceShellGain(voice: number): number {
  return 1 + clamp01(voice) * 0.22;
}

/**
 * 环形短声波的伸展量（相对球径）：普通说话也要明显。
 * 0.16 → 84px 的球上约 13px 的波峰，静默时缩回 1px 刻度。
 */
export function voiceWaveGain(voice: number): number {
  return clamp01(voice) * 0.16;
}

/**
 * 核心亮度增益：球心"接住"声音的亮度变化。
 */
export function voiceCoreGain(voice: number): number {
  return clamp01(voice) * 0.2;
}
