/**
 * 悬浮球 v2.1 的渲染内核：**有体积的流体球**（Siri 那种），不是点云。
 *
 * 规格映射：
 * - 球体 = 多层径向渐变叠加（白核 → 主色 → 透明）+ 一层**缓慢漂移的 fbm 噪声纹理**（价值噪声
 *   3 octave，预烘焙到 128px 离屏 canvas，每帧只做平移/旋转混合——热路径零逐像素计算）；
 * - 粒子只做**边缘细密火花**（≈160 粒贴在球面，随 RMS 微微外扩），**不是散开的点云**；
 * - 颜色语义：空闲=极淡青蓝玻璃（呼吸）；你说=青蓝向外脉冲波纹；它说=青绿向内收。
 *
 * 硬约束：单实例单 rAF（ButlerOrb 驱动 `step()`）；数值类型、热路径零对象分配；
 * `prefers-reduced-motion` 时 ButlerOrb 不推进时间——只画一帧静态发光。所有进 canvas 的值
 * 先过 Number.isFinite（P0 的教训）。
 */

export type OrbPalette = { r: number; g: number; b: number };

export const PALETTES: Record<"idle" | "listening" | "speaking", OrbPalette> = {
  idle: { r: 56, g: 189, b: 248 }, // 青蓝玻璃
  listening: { r: 0x38, g: 0xbd, b: 0xf8 },
  speaking: { r: 0x34, g: 0xd3, b: 0x99 },
};

export const SPARK_COUNT = 160;
const MAX_SPARKS = 200;
const NOISE_SIZE = 128;
const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

/** 价值噪声（网格插值），fbm 叠 3 octave——烘焙用，不在热路径。 */
function valueNoise(size: number, cellSize: number, seed: number): Float32Array {
  const cells = Math.ceil(size / cellSize) + 2;
  const random = new Float32Array(cells * cells);
  let state = seed;
  for (let index = 0; index < random.length; index += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    random[index] = state / 4294967296;
  }
  const field = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const gx = x / cellSize;
      const gy = y / cellSize;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const a = random[y0 * cells + x0];
      const b = random[y0 * cells + x0 + 1];
      const c = random[(y0 + 1) * cells + x0];
      const d = random[(y0 + 1) * cells + x0 + 1];
      field[y * size + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return field;
}

export class FluidOrb {
  /** 边缘火花的球面分布与相位。 */
  private readonly sparkY = new Float32Array(MAX_SPARKS);
  private readonly sparkAngle = new Float32Array(MAX_SPARKS);
  private readonly sparkPhase = new Float32Array(MAX_SPARKS);
  readonly count: number;
  rotation = 0;
  drift = 0;
  private readonly noiseCanvas: HTMLCanvasElement;

  constructor(count: number = SPARK_COUNT) {
    this.count = Math.min(count, MAX_SPARKS);
    for (let index = 0; index < this.count; index += 1) {
      // 火花贴在球面赤道带（|y| ≤ 0.55），角度均匀。
      this.sparkY[index] = (Math.random() * 2 - 1) * 0.55;
      this.sparkAngle[index] = (index / this.count) * Math.PI * 2;
      this.sparkPhase[index] = Math.random() * Math.PI * 2;
    }
    // fbm 三 octave 烘焙成一张噪声纹理（白色 + alpha=噪声），热路径只做 drawImage。
    this.noiseCanvas = document.createElement("canvas");
    this.noiseCanvas.width = NOISE_SIZE;
    this.noiseCanvas.height = NOISE_SIZE;
    const noiseContext = this.noiseCanvas.getContext("2d");
    if (noiseContext === null) throw new Error("2d context unavailable");
    // 三 octave 在数值域叠加成一张 fbm，再一次性烘焙（ lighter 叠层会把 R 通道叠爆出伪影）。
    const layers: Array<{ cell: number; weight: number }> = [
      { cell: 16, weight: 0.5 },
      { cell: 32, weight: 0.3 },
      { cell: 64, weight: 0.2 },
    ];
    const combined = new Float32Array(NOISE_SIZE * NOISE_SIZE);
    for (const { cell, weight } of layers) {
      const layer = valueNoise(NOISE_SIZE, cell, cell * 7919);
      for (let index = 0; index < combined.length; index += 1) combined[index] += layer[index] * weight;
    }
    const imageData = noiseContext.createImageData(NOISE_SIZE, NOISE_SIZE);
    for (let index = 0; index < NOISE_SIZE * NOISE_SIZE; index += 1) {
      // 亮度写进 RGB（暖白），alpha 恒定——`lighter` 叠加时不会再把某个通道顶爆成伪彩色。
      const brightness = Math.round(Math.min(1, combined[index]) * 110);
      imageData.data[index * 4 + 0] = brightness;
      imageData.data[index * 4 + 1] = brightness;
      imageData.data[index * 4 + 2] = brightness;
      imageData.data[index * 4 + 3] = 255;
    }
    noiseContext.putImageData(imageData, 0, 0);

  }

  step(
    context: CanvasRenderingContext2D,
    rawSize: number,
    options: { level: number; palette: OrbPalette; mode: "idle" | "listening" | "speaking"; motion: boolean; time: number },
  ): number {
    const level = FINITE(options.level, 0);
    const time = FINITE(options.time, 0);
    const { palette, mode, motion } = options;
    const size = FINITE(rawSize, 96);
    const center = size / 2;
    const radius = size * 0.44;
    if (motion) {
      this.rotation += 0.003 + level * 0.008;
      this.drift += 0.0025;
    }
    context.clearRect(0, 0, size, size);

    // 1. 球体基底：白核 → 主色 → 透明 的多层径向渐变（内核偏左上，Siri 的高光感）。
    const gradient = context.createRadialGradient(
      center - radius * 0.18,
      center - radius * 0.22,
      radius * 0.05,
      center,
      center,
      radius,
    );
    gradient.addColorStop(0, `rgba(255,255,255,${(0.55 + level * 0.4).toFixed(3)})`);
    gradient.addColorStop(0.35, `rgba(${palette.r},${palette.g},${palette.b},${(mode === "idle" ? 0.28 : 0.72).toFixed(3)})`);
    gradient.addColorStop(0.75, `rgba(${palette.r},${palette.g},${palette.b},${(mode === "idle" ? 0.12 : 0.38).toFixed(3)})`);
    gradient.addColorStop(1, `rgba(${palette.r},${palette.g},${palette.b},0)`);
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.fill();

    // 2. 噪声纹理层：裁剪进球体，缓慢平移+旋转，`lighter` 叠出流体的体积感。
    context.save();
    context.beginPath();
    context.arc(center, center, radius * 0.99, 0, Math.PI * 2);
    context.clip();
    // 不用 lighter：灰噪声以 lighter 叠在蓝体上会出现互补色伪影（实测中心发红）。
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = mode === "idle" ? 0.08 : 0.14 + level * 0.16;
    context.translate(center + (motion ? Math.sin(this.drift) * radius * 0.3 : 0), center + (motion ? Math.cos(this.drift * 0.8) * radius * 0.3 : 0));
    if (motion) context.rotate(this.rotation * 0.4);
    context.drawImage(this.noiseCanvas, -radius, -radius, radius * 2, radius * 2);
    context.restore();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;

    // 3. 你说/它说的脉冲波纹：listening 向外两圈、speaking 向内收。
    if (mode === "listening" || mode === "speaking") {
      const outward = mode === "listening";
      for (let ring = 1; ring <= 2; ring += 1) {
        const wave = (time * 0.9 + ring * 0.5) % 1;
        const waveRadius = outward
          ? radius * (0.75 + wave * 0.45 + level * 0.2)
          : radius * (1.15 - wave * 0.35 + level * 0.1);
        context.strokeStyle = `rgba(${palette.r},${palette.g},${palette.b},${((1 - wave) * 0.35).toFixed(3)})`;
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(center, center, Math.max(2, waveRadius), 0, Math.PI * 2);
        context.stroke();
      }
    }

    // 4. 边缘火花：贴球面赤道带的细密亮点，随 RMS 微微外扩，自转带动。
    for (let index = 0; index < this.count; index += 1) {
      const angle = this.sparkAngle[index] + this.rotation;
      const bandY = this.sparkY[index];
      const ringRadius = Math.sqrt(Math.max(0, 1 - bandY * bandY));
      const sparkle = motion ? 0.5 + 0.5 * Math.sin(time * 3 + this.sparkPhase[index]) : 0.6;
      const outward = radius * (1.005 + level * 0.12 * (0.4 + sparkle * 0.6));
      const x = center + Math.cos(angle) * outward * ringRadius;
      const y = center + bandY * outward;
      const alpha = (0.25 + level * 0.6) * sparkle * (mode === "idle" ? 0.35 : 1);
      context.fillStyle = `rgba(${Math.min(255, palette.r + 120)},${Math.min(255, palette.g + 120)},${Math.min(255, palette.b + 120)},${alpha.toFixed(3)})`;
      context.beginPath();
      context.arc(x, y, 0.8 + sparkle * 1.1 * (size / 96), 0, Math.PI * 2);
      context.fill();
    }
    return this.count;
  }
}
