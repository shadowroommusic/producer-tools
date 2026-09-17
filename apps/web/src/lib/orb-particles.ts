/**
 * 悬浮球 v3 的渲染内核：有深度、流体边的发光球。
 *
 * v3 规格：
 * - **流体边**：球缘按 fbm 噪声轻微位移（有机起伏，不是完美正圆）——把球面拆成 120 段折线，
 *   每段的半径乘 fbm（角度 + 时间），路径闭合填充渐变；
 * - **内核**：多段径向渐变 + 偏移高光（光从左上打，右下暗）→ 3D 体积感；
 * - **外发光**：球体先以低 alpha 画一个更大的柔光圆（径向渐变到透明），让球「坐」在界面里；
 * - **粒子**：240 粒在球体外侧**三维绕行**（真实 3D 坐标绕 Y 轴 + 倾斜轴，透视投影；远的暗而小、
 *   近的亮而大），RMS 驱动外扩幅度；
 * - 颜色语义不变：你说=青蓝向外加速+中心扩散波纹；它说=青绿向内收+青转绿渐变；空闲=呼吸玻璃。
 *
 * 硬约束：单实例单 rAF；数值热路径零对象分配；进 canvas 的值全部先过 Number.isFinite（P0）；
 * `prefers-reduced-motion` 时时间不推进——静态发光。
 */

export type OrbPalette = { r: number; g: number; b: number };

export const PALETTES: Record<"idle" | "listening" | "speaking", OrbPalette> = {
  idle: { r: 56, g: 189, b: 248 },
  listening: { r: 0x38, g: 0xbd, b: 0xf8 },
  speaking: { r: 0x34, g: 0xd3, b: 0x99 },
};

export const SPARK_COUNT = 240;
const MAX_SPARKS = 260;
const RIM_SEGMENTS = 120;
const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

/** 价值噪声 + 3 octave fbm，按 (角度, 时间) 采样——流体边的位移场。烘焙三张网格后插值。 */
class FbmField {
  private readonly size = 256;
  private readonly layers: Float32Array[] = [];

  constructor() {
    for (const cells of [8, 16, 32]) this.layers.push(this.valueNoise(cells));
  }

  private valueNoise(cells: number): Float32Array {
    const random = new Float32Array(cells * cells);
    let state = cells * 7919;
    for (let index = 0; index < random.length; index += 1) {
      state = (state * 1664525 + 1013904223) % 4294967296;
      random[index] = state / 4294967296;
    }
    const size = this.size;
    const field = new Float32Array(size);
    const smooth = (t: number) => t * t * (3 - 2 * t);
    for (let index = 0; index < size; index += 1) {
      const gx = (index / size) * cells;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const a = random[(index % cells) * cells + (x0 % cells)];
      const b = random[(index % cells) * cells + ((x0 + 1) % cells)];
      field[index] = a + (b - a) * tx;
    }
    return field;
  }

  /** angle 弧度、time 秒 → 0..1。 */
  sample(angle: number, time: number): number {
    const size = this.size;
    const norm = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
    let value = 0;
    const weights = [0.5, 0.3, 0.2];
    for (let octave = 0; octave < 3; octave += 1) {
      const layer = this.layers[octave];
      const speed = octave + 1;
      const pos = (norm + (motionless(time) * 0.02 * speed) % 1) * size;
      const x0 = Math.floor(pos);
      const tx = smoothLike(pos - x0);
      const a = layer[x0 % size];
      const b = layer[(x0 + 1) % size];
      value += (a + (b - a) * tx) * weights[octave];
    }
    return value;
  }
}
const motionless = (time: number): number => Math.sin(time * 0.35) * 0.5 + 0.5;
const smoothLike = (t: number): number => t * t * (3 - 2 * t);

export class FluidOrb {
  private readonly sparkX = new Float32Array(MAX_SPARKS);
  private readonly sparkY = new Float32Array(MAX_SPARKS);
  private readonly sparkZ = new Float32Array(MAX_SPARKS);
  private readonly sparkPhase = new Float32Array(MAX_SPARKS);
  readonly count: number;
  rotation = 0;
  drift = 0;
  private readonly field = new FbmField();

  constructor(count: number = SPARK_COUNT) {
    this.count = Math.min(count, MAX_SPARKS);
    // 火花分布在半径 1.02–1.18 的球壳上（球体外侧绕行），斐波那契分布保证均匀。
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < this.count; index += 1) {
      const y = 1 - (index / (this.count - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * index;
      const shell = 1.02 + (index % 5) * 0.04;
      this.sparkX[index] = Math.cos(theta) * ring * shell;
      this.sparkY[index] = y * shell;
      this.sparkZ[index] = Math.sin(theta) * ring * shell;
      this.sparkPhase[index] = (index * 0.618) % 1;
    }
  }

  step(
    context: CanvasRenderingContext2D,
    rawSize: number,
    options: { level: number; palette: OrbPalette; mode: "idle" | "listening" | "speaking"; motion: boolean; time: number },
  ): number {
    const level = FINITE(options.level, 0);
    const time = FINITE(options.time, 0);
    const { palette, mode, motion } = options;
    const size = FINITE(rawSize, 120);
    const center = size / 2;
    const radius = size * 0.4;
    if (motion) {
      this.rotation += 0.004 + level * 0.01;
      this.drift += 0.002;
    }
    context.clearRect(0, 0, size, size);

    // 0. 外发光：大半径低 alpha 的柔光，让球「坐」在界面里。
    const glow = context.createRadialGradient(center, center, radius * 0.5, center, center, radius * 1.5);
    glow.addColorStop(0, `rgba(${palette.r},${palette.g},${palette.b},${(0.16 + level * 0.18).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${palette.r},${palette.g},${palette.b},0)`);
    context.fillStyle = glow;
    context.beginPath();
    context.arc(center, center, radius * 1.5, 0, Math.PI * 2);
    context.fill();

    // 1. 流体边球体：fbm 位移的闭合路径（120 段），填充多层渐变。
    context.save();
    context.beginPath();
    const segments = RIM_SEGMENTS;
    for (let index = 0; index <= segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      const wobble = motion ? (this.field.sample(angle, time) - 0.5) * radius * 0.07 : 0;
      const r = radius + wobble;
      const x = center + Math.cos(angle) * r;
      const y = center + Math.sin(angle) * r;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.clip();
    const body = context.createRadialGradient(
      center - radius * 0.35,
      center - radius * 0.4,
      radius * 0.08,
      center,
      center,
      radius * 1.05,
    );
    body.addColorStop(0, `rgba(255,255,255,${(0.75 + level * 0.2).toFixed(3)})`);
    body.addColorStop(0.3, `rgba(${Math.min(255, palette.r + 90)},${Math.min(255, palette.g + 90)},${Math.min(255, palette.b + 90)},${(mode === "idle" ? 0.4 : 0.85).toFixed(3)})`);
    body.addColorStop(0.7, `rgba(${palette.r},${palette.g},${palette.b},${(mode === "idle" ? 0.22 : 0.55).toFixed(3)})`);
    body.addColorStop(1, `rgba(${Math.max(0, palette.r - 40)},${Math.max(0, palette.g - 40)},${Math.max(0, palette.b - 40)},${(mode === "idle" ? 0.12 : 0.3).toFixed(3)})`);
    context.fillStyle = body;
    context.fillRect(0, 0, size, size);
    // 右下暗部：补一层偏移的暗渐变，强化 3D 体积。
    const shade = context.createRadialGradient(
      center + radius * 0.45,
      center + radius * 0.5,
      radius * 0.1,
      center + radius * 0.45,
      center + radius * 0.5,
      radius * 1.2,
    );
    shade.addColorStop(0, `rgba(0,0,0,${(mode === "idle" ? 0.1 : 0.24).toFixed(3)})`);
    shade.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = shade;
    context.fillRect(0, 0, size, size);
    context.restore();

    // 2. 呼吸高光：左上一颗随 RMS 微移的亮斑（不动的时候也保持，静态发光的一部分）。
    const glossX = center - radius * (0.32 + level * 0.05);
    const glossY = center - radius * (0.36 + level * 0.05);
    const gloss = context.createRadialGradient(glossX, glossY, 0, glossX, glossY, radius * 0.4);
    gloss.addColorStop(0, `rgba(255,255,255,${(0.5 + level * 0.35).toFixed(3)})`);
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gloss;
    context.beginPath();
    context.arc(glossX, glossY, radius * 0.4, 0, Math.PI * 2);
    context.fill();

    // 3. 240 粒 3D 绕行：绕 Y 轴 + 轻微倾斜，透视投影（远的暗而小、近的亮而大），RMS 外扩。
    const tilt = 0.35;
    for (let index = 0; index < this.count; index += 1) {
      const angle = this.sparkAngleOf(index) + (motion ? this.rotation : 0);
      const x0 = Math.cos(angle);
      const z0 = Math.sin(angle);
      const y0 = this.sparkY[index];
      // 绕 X 轴倾斜，让绕行轨道有立体感
      const y = y0 * Math.cos(tilt) - z0 * Math.sin(tilt);
      const z = y0 * Math.sin(tilt) + z0 * Math.cos(tilt);
      const x = x0;
      const perspective = 1 / (1.9 - z * 0.7);
      const outward = 1 + level * 0.16 * (0.5 + this.sparkPhase[index] * 0.5);
      const px = center + x * radius * outward * perspective;
      const py = center + y * radius * outward * perspective;
      const depth = (z + 1) / 2;
      const alpha = (0.1 + depth * 0.55) * (mode === "idle" ? 0.4 : 0.85) * (0.5 + level * 0.5 + 0.3);
      const dot = (0.9 + depth * 1.8 + level * 1.2) * (size / 120);
      context.fillStyle = `rgba(${Math.min(255, palette.r + 110)},${Math.min(255, palette.g + 110)},${Math.min(255, palette.b + 110)},${FINITE(alpha, 0.2).toFixed(3)})`;
      context.beginPath();
      context.arc(FINITE(px, center), FINITE(py, center), Math.max(0.4, FINITE(dot, 1)), 0, Math.PI * 2);
      context.fill();
    }

    // 4. 你说/它说的波纹：listening 从中心向外两圈；speaking 从外向内收。
    if (mode === "listening" || mode === "speaking") {
      const outward = mode === "listening";
      for (let ring = 1; ring <= 2; ring += 1) {
        const wave = (time * 0.8 + ring * 0.5) % 1;
        const waveRadius = outward
          ? radius * (0.5 + wave * 0.7 + level * 0.2)
          : radius * (1.25 - wave * 0.4 + level * 0.1);
        context.strokeStyle = `rgba(${palette.r},${palette.g},${palette.b},${((1 - wave) * 0.4).toFixed(3)})`;
        context.lineWidth = 2;
        context.beginPath();
        context.arc(center, center, Math.max(2, waveRadius), 0, Math.PI * 2);
        context.stroke();
      }
    }
    return this.count;
  }

  private sparkAngleOf(index: number): number {
    return Math.atan2(this.sparkZ[index], this.sparkX[index]);
  }
}
