/**
 * 悬浮球的粒子系统（任务：iOS-27-Siri 风格的等离子球）。
 *
 * 约 180 个粒子按斐波那契球面分布，绕 Y 轴慢速自转 + 2D 透视投影；每颗粒子的半径与亮度由
 * 「音频 RMS × 噪声场」驱动——看起来像一团发光的等离子，而不是三个同心环。
 *
 * 硬性约束：单实例单 rAF（由 ButlerOrb 驱动 `step()`），粒子 ≤240，全部数值类型、零对象分配
 * （渲染热路径不产生 GC 压力）。`prefers-reduced-motion` 时 ButlerOrb 直接不调 step/不转不漂，
 * 只画一帧静态发光。
 */

export type OrbPalette = {
  /** 粒子主色（你说=青蓝 #38BDF8 / 它说=青绿 #34D399 / 空闲=中性）。 */
  r: number;
  g: number;
  b: number;
};

export const PALETTES: Record<"idle" | "listening" | "speaking", OrbPalette> = {
  idle: { r: 148, g: 163, b: 184 }, // slate：极淡的中性
  listening: { r: 0x38, g: 0xbd, b: 0xf8 }, // 青蓝
  speaking: { r: 0x34, g: 0xd3, b: 0x99 }, // 青绿
};

export const PARTICLE_COUNT = 180;
const MAX_PARTICLES = 240;

/** 便宜的三维伪噪声（几层不同频率的 sin 叠加）：足够像「噪声场」，零依赖零分配。 */
function noise3(x: number, y: number, z: number, t: number): number {
  return (
    0.5 +
    0.25 * Math.sin(x * 3.1 + t * 1.7) +
    0.15 * Math.sin(y * 4.3 - t * 1.3) +
    0.10 * Math.sin(z * 5.7 + t * 2.1)
  );
}

export class OrbParticles {
  /** 单位球面上的静止分布（斐波那契格），渲染时乘半径。 */
  private readonly baseX = new Float32Array(MAX_PARTICLES);
  private readonly baseY = new Float32Array(MAX_PARTICLES);
  private readonly baseZ = new Float32Array(MAX_PARTICLES);
  /** 每颗粒子的相位：噪声场按它错开，避免全体同呼吸。 */
  private readonly phase = new Float32Array(MAX_PARTICLES);
  count = PARTICLE_COUNT;
  /** 自转角（弧度）；reduced-motion 时不增。 */
  rotation = 0;
  /** 慢漂移的相位（空闲时的整体微动）。 */
  drift = 0;

  constructor(count: number = PARTICLE_COUNT) {
    const n = Math.min(count, MAX_PARTICLES);
    this.count = n;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < n; index += 1) {
      // 斐波那契球面：y 均匀分层，经度转黄金角——每颗粒子等面积、无极点堆积。
      const y = 1 - (index / (n - 1)) * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * index;
      this.baseX[index] = Math.cos(theta) * radius;
      this.baseY[index] = y;
      this.baseZ[index] = Math.sin(theta) * radius;
      this.phase[index] = (index * 0.6180339887) % 1;
    }
  }

  /**
   * 推进并渲染一帧。
   * @param context 2D 画布上下文（已按 devicePixelRatio 缩放，坐标以 CSS 像素计）。
   * @param size 画布 CSS 边长（球直径）。
   * @param options.level 音频 RMS 0–1（驱动半径与亮度）。
   * @param options.palette 粒子颜色。
   * @param options.mode listening 时粒子**向外扩散脉冲**，speaking 时**向内收**，idle 慢漂移。
   * @param options.motion false（prefers-reduced-motion）时：不自转、不漂移、不呼吸，静态发光。
   * @param options.time 秒（性能计时外部采样用不到，动画相位用）。
   * @returns 本帧渲染的粒子数（测试用）。
   */
  step(
    context: CanvasRenderingContext2D,
    size: number,
    options: { level: number; palette: OrbPalette; mode: "idle" | "listening" | "speaking"; motion: boolean; time: number },
  ): number {
    const { level, palette, mode, motion, time } = options;
    const center = size / 2;
    const baseRadius = size * 0.34;
    if (motion) {
      this.rotation += 0.004 + level * 0.01;
      this.drift += 0.003;
    }
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    context.clearRect(0, 0, size, size);

    // 后半球先画（画家算法按 z 排序太贵；按 sin 分两批已经足够「球」的错觉）。
    for (let pass = 0; pass < 2; pass += 1) {
      for (let index = 0; index < this.count; index += 1) {
        const x = this.baseX[index];
        const y = this.baseY[index];
        const z = this.baseZ[index];
        const rotatedX = x * cos - z * sin;
        const rotatedZ = x * sin + z * cos;
        const front = rotatedZ >= 0;
        if ((pass === 0) === front) continue;

        // 噪声场 × 音频 RMS：决定这颗粒子此刻离开球面的距离与亮度。
        const n = noise3(rotatedX, y, rotatedZ, motion ? time : 0);
        const pulse = mode === "listening" ? level * (0.5 + n) : mode === "speaking" ? -level * (0.4 + n * 0.8) : 0;
        const drift = motion ? Math.sin(time * 0.8 + this.phase[index] * Math.PI * 2) * 0.06 : 0;
        const radial = baseRadius * (1 + drift + (motion ? n - 0.5 : 0) * 0.22 + pulse * 0.55);

        // 2D 透视投影：z 越靠前越大越亮。
        const perspective = 1 / (1.6 - rotatedZ * 0.55);
        const px = center + rotatedX * radial * perspective;
        const py = center - y * radial * perspective;
        const depth = (rotatedZ + 1) / 2; // 0 后 → 1 前
        const energy = Math.min(1, 0.18 + level * 0.9 * (0.4 + n * 0.8));
        const alpha = (0.12 + depth * 0.5) * energy * (mode === "idle" ? 0.32 : 1);
        const sizePx = (0.8 + depth * 1.4 + level * 1.6 * n) * (size / 72);

        context.beginPath();
        context.fillStyle = `rgba(${palette.r},${palette.g},${palette.b},${alpha.toFixed(3)})`;
        context.arc(px, py, sizePx, 0, Math.PI * 2);
        context.fill();
      }
    }
    return this.count;
  }
}
