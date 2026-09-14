/**
 * ShadowRoom mark — the artwork from https://shadowroom.cn/images/logo.svg, inlined so it can
 * follow `currentColor` and stay legible when it is scaled down to UI sizes.
 *
 * The site file draws with `stroke-width: 1.5` on a 120.4 × 235.93 canvas, which is meant for the
 * big hero lockup. Below ~80px tall that hairline disappears, so the stroke is widened
 * proportionally as the mark gets smaller.
 */

const VIEW_W = 120.4;
const VIEW_H = 235.93;

export function BrandMark({
  height = 24,
  strokeWidth,
  className,
  title = "ShadowRoom",
}: {
  height?: number;
  strokeWidth?: number;
  className?: string;
  title?: string;
}) {
  const stroke = strokeWidth ?? Math.max(1.5, 6.2 * (24 / height));
  return (
    <svg
      className={className}
      width={(VIEW_W / VIEW_H) * height}
      height={height}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={title}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={0.92}
    >
      <polygon points="120.4 25.59 120.4 183.6 52.56 223.86 52.56 64.92 120.4 25.59" />
      <polyline points="78.58 12 25.99 41.62 47.56 55.86 100.23 25.32 78.58 12" />
      <path
        d="M418.62,310.14,350.7,348.38v94.28l41.66,29.17V375.05l67.84-39.32ZM382,451.38l-21-15V361l21,13.85ZM387.36,366l-21.57-14.25,52.59-29.61L440,335.46Z"
        transform="translate(-339.8 -310.14)"
      />
      <path
        d="M407.29,432.56v39.26l-24.36,13.44L339.8,456v64.26l42.52,25.84,77.88-46.46v-96.4ZM360.48,495,372,502.86v12.75l-11.55-7Zm79-7.16-46.81,27.92V503.49L428,484V444.74l11.55-6.4Z"
        transform="translate(-339.8 -310.14)"
      />
    </svg>
  );
}
