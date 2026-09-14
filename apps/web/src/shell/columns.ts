/**
 * Column geometry for the three-column shell.
 *
 * Same solve as DeepSeek Harness's ui-layout: the right column shrinks and then loses its track
 * before the centre is allowed below its minimum, and the sidebar never concedes — it collapses to
 * a rail instead (AppFrame decides that from the measured frame width).
 */

/** Resolved widths for one frame. */
export interface Columns {
  sidebar: number;
  center: number;
  rightbar: number;
}

/** Centre width protected while the dock is open. */
export const CENTER_MIN = 400;
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264;
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420;
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280;
/** Closed-sidebar rail: a 36px control column inside 10px paddings. */
export const SIDEBAR_COLLAPSED = 56;
/** Frame width below which the sidebar collapses to the rail. */
export const SIDEBAR_AUTO_COLLAPSE = 1024;
/** Dock drag clamp floor. */
export const RIGHTBAR_MIN = 300;
/** Maximum dock width as a fraction of the frame. */
export const RIGHTBAR_MAX_RATIO = 0.7;
/** First-open dock width as a fraction of the frame. */
export const RIGHTBAR_DEFAULT_RATIO = 0.45;
/** The dock is a side panel (chat / one plugin), not a second workspace: keep it narrow. */
export const RIGHTBAR_DEFAULT_MIN = 360;
/** …and never wider than this on a first open. */
export const RIGHTBAR_DEFAULT_MAX = 520;

/**
 * Clamp a column width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width, rounded to whole pixels.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * Solve the three column widths for one frame.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar preference in px (0 = collapsed).
 * @param rightbar - requested dock width in px (0 = no track).
 * @returns the resolved widths.
 */
export function computeColumns(viewport: number, sidebar: number, rightbar: number): Columns {
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  const available = viewport - s - CENTER_MIN;
  const r =
    rightbar === 0 || available < RIGHTBAR_MIN
      ? 0
      : Math.min(available, clampWidth(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO));
  return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r };
}

/**
 * Dock width before any drag: a comfortable side panel, not 45% of the screen. The centre column
 * keeps the work surface — measured feedback after the first version squeezed Studio to 600px.
 * @param viewport - frame width in px.
 * @returns the default dock width in px.
 */
export function defaultDockWidth(viewport: number): number {
  return clampWidth(viewport * 0.28, RIGHTBAR_DEFAULT_MIN, RIGHTBAR_DEFAULT_MAX);
}
