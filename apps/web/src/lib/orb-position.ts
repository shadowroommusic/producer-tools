/**
 * 悬浮球的位置逻辑（从 ButlerOrb.tsx 拆出来：.tsx 进不了 node 单测，而这正好是
 * 吸附/夹取/持久化这类能离屏验证的纯计算——viewport 与受保护控件由调用方喂进来）。
 *
 * 口径（ButlerOrb 头注与 app.css 同源）：窗口内留 12px 边距；松手时离任一边不足 48px
 * 吸附到该边缘；吸附点不得压受保护控件；位置持久化进 localStorage 的
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

/** 视口与受保护矩形的离屏形状（DOMRect 的字段子集即可）。 */
export type Viewport = { width: number; height: number };
export type Rect = { x: number; y: number; w: number; h: number };
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

/**
 * 保护性退避：位置若与任一受保护控件（新建会话/导入/导出/录音/缩放药丸/底部输入框/发送）
 * 相交，垂直退、退不动整行扫描，直到无相交——球永不停在控件上。
 */
export function avoidProtected(next: Position, protectedRects: Rect[], viewport: Viewport, size: number = ORB_SIZE): Position {
  const hits = (point: Position) =>
    protectedRects.some(
      (rect) =>
        !(point.x > rect.x + rect.w || point.x + size < rect.x || point.y > rect.y + rect.h || point.y + size < rect.y),
    );
  if (!hits(next)) return next;
  const minX = MARGIN;
  const minY = MARGIN;
  const maxX = Math.max(minX, viewport.width - size - MARGIN);
  const maxY = Math.max(minY, viewport.height - size - MARGIN);
  const xs = new Set<number>([minX, maxX, Math.max(minX, Math.min(maxX, next.x))]);
  const ys = new Set<number>([minY, maxY, Math.max(minY, Math.min(maxY, next.y))]);
  for (const rect of protectedRects) {
    xs.add(Math.max(minX, Math.min(maxX, rect.x - size - MARGIN)));
    xs.add(Math.max(minX, Math.min(maxX, rect.x + rect.w + MARGIN)));
    ys.add(Math.max(minY, Math.min(maxY, rect.y - size - MARGIN)));
    ys.add(Math.max(minY, Math.min(maxY, rect.y + rect.h + MARGIN)));
  }
  /**
   * A one-direction escape is not enough: when the only collision sits at the bottom-right
   * corner (Studio's zoom control), pushing down immediately clamps and the horizontal fallback
   * starts from the already-overlapping x. Search the small viewport span instead and choose the
   * nearest collision-free point, so the ball moves just far enough and never parks on a control.
   */
  for (let x = minX; x <= maxX; x += 16) xs.add(x);
  for (let y = minY; y <= maxY; y += 16) ys.add(y);
  let best: Position | null = null;
  let bestDistance = Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const candidate = { x, y };
      if (hits(candidate)) continue;
      const distance = (x - next.x) ** 2 + (y - next.y) ** 2;
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  if (best !== null) return best;

  /**
   * A page can theoretically cover the whole viewport with protected controls. In that case no
   * answer can satisfy both "stay visible" and "never overlap"; keep the orb visible at the
   * nearest edge instead of returning an arbitrary position outside the viewport.
   */
  return clampToViewport(next.x, next.y, viewport, size);
}

/** 松手吸附：离任一边缘不足 48px 时贴到该边缘的 12px 边距处；再对受保护控件做保护性退避。 */
export function snapToViewport(pos: Position, viewport: Viewport, protectedRects: Rect[] = [], size: number = ORB_SIZE): Position {
  const maxX = viewport.width - size - MARGIN;
  const maxY = viewport.height - size - MARGIN;
  const next = clampToViewport(pos.x, pos.y, viewport, size);
  if (next.x - MARGIN < SNAP_DISTANCE) next.x = MARGIN;
  if (maxX - next.x < SNAP_DISTANCE) next.x = maxX;
  if (next.y - MARGIN < SNAP_DISTANCE) next.y = MARGIN;
  if (maxY - next.y < SNAP_DISTANCE) next.y = maxY;
  return avoidProtected(next, protectedRects, viewport, size);
}

/** 默认位置：右下角距右/底 24px（不压 DJ 推荐卡末行与 Studio 时间线中央，D2 巡检），再退避控件。 */
export function defaultPosition(viewport: Viewport, protectedRects: Rect[] = [], size: number = ORB_SIZE): Position {
  return avoidProtected(
    { x: viewport.width - size - 24, y: viewport.height - size - 24 },
    protectedRects,
    viewport,
    size,
  );
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
