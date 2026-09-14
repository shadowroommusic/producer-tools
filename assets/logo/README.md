# Brand assets

ShadowRoom's own brand files, taken from the label website so the app and the site stay identical.

| File | Where it comes from | Used for |
| --- | --- | --- |
| `shadowroom-mark-white.svg` | `https://shadowroom.cn/images/logo-white.svg` — byte-for-byte copy | the mark on dark backgrounds |
| `shadowroom-mark-grey.svg` | `https://shadowroom.cn/images/logo.svg` — byte-for-byte copy | the mark on light backgrounds |
| `shadowroom-mark.svg` | same artwork, stroke bound to `currentColor` | in-app SVG / theming |
| `favicon.ico`, `favicon.png`, `apple-touch-icon.png` | `https://shadowroom.cn/images/*` — byte-for-byte copies | app and browser icons |
| `shadow-producers-lockup.svg` | the mark above + our wordmark and tagline | lockups, README headers |

Fetched from shadowroom.cn on 2026-09-14. These are ShadowRoom Music's own files; no third-party
logo is bundled with this project.

The app renders the mark through `apps/web/src/components/BrandMark.tsx` (same geometry, stroke
width scaled for small sizes) and serves the icons from `apps/web/public/brand/`.
