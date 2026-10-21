/**
 * 悬浮球的位置逻辑（从 ButlerOrb.tsx 拆出来：.tsx 进不了 node 单测，吸附/夹取/持久化
 * 都是能离屏验证的纯计算）。
 *
 * 用户拥有最终位置：页面切换、控件出现或 dock 开合都不会移动球；只有拖动松手后的边缘
 * 吸附，以及窗口/球尺寸变化造成的越界夹取会修正坐标。位置持久化进 localStorage 的
 * `shadowroom.orb.position`。
 */

export const ORB_SIZE = 84;
/** 通话态基准径：与闲置径按同一档比例缩放（Kimi 主审：通话态按同一比例缩放）。 */
export const ORB_ACTIVE_SIZE = 124;
export const POSITION_KEY = "shadowroom.orb.position";
export const ORB_SCALE_KEY = "shadowroom.orb.scale.v1";
export const DEFAULT_ORB_SCALE = 1;
export const MIN_ORB_SCALE = 0.25;
export const MAX_ORB_SCALE = 1.25;
export const ORB_SCALE_STEP = 0.25;
/** 最小档的视觉球只有约 21px，但命中圆不得低于这个直径（可点击性不随视觉缩小）。 */
export const ORB_MIN_HIT_PX = 32;

/** 视口与位置的离屏形状。 */
export type Viewport = { width: number; height: number };
export type Position = { x: number; y: number };

const MARGIN = 12;
const SNAP_DISTANCE = 48;

/**
 * Idle size is a user preference; the call size scales by the same ratio so a deliberately tiny
 * resting orb keeps a proportional (still readable) call orb, and vice versa.
 */
export function orbSizeAtScale(scale: number, baseSize: number = ORB_SIZE): number {
  return Math.round(baseSize * clampOrbScale(scale));
}

/** Pointer target for a visual size: never below ORB_MIN_HIT_PX, so 25% stays clickable. */
export function orbHitSize(visualSize: number): number {
  return Math.max(ORB_MIN_HIT_PX, Math.round(visualSize));
}

/** Quantize to the five menu stops so saved values and button steps cannot drift apart. */
export function clampOrbScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ORB_SCALE;
  const clamped = Math.max(MIN_ORB_SCALE, Math.min(MAX_ORB_SCALE, value));
  return Math.round(clamped / ORB_SCALE_STEP) * ORB_SCALE_STEP;
}

export function loadOrbScale(storage: Pick<Storage, "getItem">): number {
  try {
    const raw = storage.getItem(ORB_SCALE_KEY);
    if (raw === null) return DEFAULT_ORB_SCALE;
    return clampOrbScale(Number(raw));
  } catch {
    return DEFAULT_ORB_SCALE;
  }
}

export function saveOrbScale(storage: Pick<Storage, "setItem">, scale: number): void {
  try {
    storage.setItem(ORB_SCALE_KEY, String(clampOrbScale(scale)));
  } catch {
    // A storage-denied browser keeps the chosen size for this session only.
  }
}

/**
 * 视口边界夹取：窗口内留 12px 边距，不许只露半个球。
 *
 * `size` 必须传**当前**球径（72 空闲 / 112 通话）：按小尺寸夹到边缘后再长大，
 * 多出来的部分会悬到视口外。夹取、吸附和控件距离都按当前尺寸计算。
 */
export function clampToViewport(x: number, y: number, viewport: Viewport, size: number = ORB_SIZE): Position {
  return {
    x: Math.max(MARGIN, Math.min(viewport.width - size - MARGIN, x)),
    y: Math.max(MARGIN, Math.min(viewport.height - size - MARGIN, y)),
  };
}

/** 松手吸附：离任一边缘不足 48px 时贴到该边缘的 12px 边距处。 */
export function snapToViewport(pos: Position, viewport: Viewport, size: number = ORB_SIZE): Position {
  const maxX = viewport.width - size - MARGIN;
  const maxY = viewport.height - size - MARGIN;
  const next = clampToViewport(pos.x, pos.y, viewport, size);
  if (next.x - MARGIN < SNAP_DISTANCE) next.x = MARGIN;
  if (maxX - next.x < SNAP_DISTANCE) next.x = maxX;
  if (next.y - MARGIN < SNAP_DISTANCE) next.y = MARGIN;
  if (maxY - next.y < SNAP_DISTANCE) next.y = maxY;
  return next;
}

/** 默认位置：屏幕中下方；用户之后可以自由拖到任意位置。 */
export function defaultPosition(viewport: Viewport, size: number = ORB_SIZE): Position {
  return clampToViewport((viewport.width - size) / 2, viewport.height - size - 140, viewport, size);
}

/** 读持久化位置：结构不对（缺字段/非数字/坏 JSON）一律当没有。 */
export function loadPosition(storage: Pick<Storage, "getItem">): Position | null {
  try {
    const raw = storage.getItem(POSITION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Position;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePosition(storage: Pick<Storage, "setItem">, pos: Position): void {
  try {
    storage.setItem(POSITION_KEY, JSON.stringify(pos));
  } catch {
    // 隐私模式等 storage 不可写：位置照样能用，只是不跨刷新保持。
  }
}
