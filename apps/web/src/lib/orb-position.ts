/**
 * 悬浮球的位置逻辑（从 ButlerOrb.tsx 拆出来：.tsx 进不了 node 单测，而这正好是
 * 吸附/夹取/持久化这类能离屏验证的纯计算——viewport 与受保护控件由调用方喂进来）。
 *
 * 口径（ButlerOrb 头注与 app.css 同源）：窗口内留 12px 边距；松手时离任一边不足 48px
 * 吸附到该边缘；吸附点不得压受保护控件；位置持久化进 localStorage 的
 * `shadowroom.orb.position`。
 */

export const ORB_SIZE = 64;
export const POSITION_KEY = "shadowroom.orb.position";

/** 视口与受保护矩形的离屏形状（DOMRect 的字段子集即可）。 */
export type Viewport = { width: number; height: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Position = { x: number; y: number };

const MARGIN = 12;
const SNAP_DISTANCE = 48;

/**
 * 视口边界夹取：窗口内留 12px 边距，不许只露半个球。
 *
 * `size` 必须传**当前**球径（64 空闲 / 80 通话）：2026-10-16 实测——按 64 夹到右缘后
 * 通话态长到 80，会多出 16px 悬在视口外（用户报「球被裁掉小半」）。夹取与吸附都按它算。
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
  let nearest = protectedRects[0];
  let bestDistance = Infinity;
  for (const rect of protectedRects) {
    const dx = rect.x + rect.w / 2 - (next.x + ORB_SIZE / 2);
    const dy = rect.y + rect.h / 2 - (next.y + ORB_SIZE / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = rect;
    }
  }
  const awayX = Math.sign(next.x + ORB_SIZE / 2 - (nearest.x + nearest.w / 2)) || -1;
  const awayY = Math.sign(next.y + ORB_SIZE / 2 - (nearest.y + nearest.h / 2)) || -1;
  let candidate = { ...next };
  // 垂直优先退让，顶住后整行水平扫描。
  for (let step = 0; step < 24; step += 1) {
    const moved = clampToViewport(candidate.x, candidate.y + awayY * 24, viewport, size);
    if (moved.y === candidate.y) break;
    candidate = moved;
    if (!hits(candidate)) return candidate;
  }
  const scanStart = awayX > 0 ? next.x : viewport.width - size - MARGIN;
  for (let step = 0; step < 24; step += 1) {
    const moved = clampToViewport(scanStart + (awayX > 0 ? step : -step) * 32, candidate.y, viewport, size);
    if (moved.x === candidate.x) continue;
    candidate = moved;
    if (!hits(candidate)) return candidate;
  }
  return candidate;
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
