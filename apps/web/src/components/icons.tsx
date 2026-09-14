/** 16px outline glyphs used across the shell (stroke follows `currentColor`). */
import type { ReactNode, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({
  children,
  size = 16,
  ...rest
}: SVGProps<SVGSVGElement> & { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPanelLeft = (props: IconProps) => (
  <Glyph {...props}>
    <rect x="2" y="3" width="12" height="10" rx="2.5" />
    <path d="M6.5 3v10" />
  </Glyph>
);

export const IconNewSession = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Glyph>
);

export const IconWorkbench = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M2.5 8.5 8 4l5.5 4.5V13H2.5V8.5Z" />
  </Glyph>
);

export const IconLibrary = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M6 12V4l6-1.2V10.5" />
    <circle cx="4.2" cy="12" r="1.8" />
    <circle cx="10.2" cy="10.6" r="1.8" />
  </Glyph>
);

export const IconConvert = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M3 5.5h8.5L9 3M13 10.5H4.5L7 13" />
  </Glyph>
);

export const IconSetPlan = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h9" />
  </Glyph>
);

export const IconStudio = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M3 5.5v5M6.3 3.5v9M9.7 5v6M13 3.5v9" />
  </Glyph>
);

export const IconDj = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M3 9.5v-1a5 5 0 0 1 10 0v1" />
    <rect x="2.2" y="9.5" width="3" height="4" rx="1.4" />
    <rect x="10.8" y="9.5" width="3" height="4" rx="1.4" />
  </Glyph>
);

export const IconPlugin = (props: IconProps) => (
  <Glyph {...props}>
    <rect x="3" y="3" width="10" height="10" rx="2.5" />
    <path d="M6.5 6.5h3v3h-3z" />
  </Glyph>
);

export const IconSettings = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 2.5v1.6M8 11.9v1.6M2.5 8h1.6M11.9 8h1.6M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M11.9 4.1l-1.1 1.1M5.2 10.8 4.1 11.9" />
  </Glyph>
);

export const IconPlus = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Glyph>
);

export const IconArrowUp = (props: IconProps) => (
  <Glyph {...props} strokeWidth={1.4}>
    <path d="M8 12.5v-9M4 7.5 8 3.5l4 4" />
  </Glyph>
);

export const IconStop = (props: IconProps) => (
  <Glyph {...props} strokeWidth={0}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="2.5" fill="currentColor" />
  </Glyph>
);

export const IconChevronDown = (props: IconProps) => (
  <Glyph {...props}>
    <path d="m4.5 6 3.5 3.5L11.5 6" />
  </Glyph>
);

export const IconChevronRight = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M6.5 4.5 10 8l-3.5 3.5" />
  </Glyph>
);

export const IconDock = (props: IconProps) => (
  <Glyph {...props}>
    <rect x="2" y="3" width="12" height="10" rx="2.5" />
    <path d="M9.5 3v10" />
  </Glyph>
);

export const IconExpand = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M9.5 6.5 13 3M10 3h3v3M6.5 9.5 3 13M3 10v3h3" />
  </Glyph>
);

export const IconCollapse = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M13 3 9.8 6.2M9.8 3.4v2.8h2.8M3 13l3.2-3.2M6.2 12.6V9.8H3.4" />
  </Glyph>
);

export const IconTool = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M10.4 3.2a3 3 0 0 0 3.3 3.9l-6.4 6.4a1.7 1.7 0 0 1-2.4-2.4l6.4-6.4a3 3 0 0 0-3.9-3.3l3 3.1" />
  </Glyph>
);

export const IconSpinner = (props: IconProps) => (
  <Glyph {...props} className="sr-spin">
    <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" />
  </Glyph>
);

/** Reasoning glyph: a small "spark" the Think row leads with. */
export const IconThink = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M8 2.8 9.4 6l3.3 1.4-3.3 1.4L8 12l-1.4-3.2L3.3 7.4 6.6 6 8 2.8Z" />
    <path d="M12.4 11.2 13 12.7l1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" />
  </Glyph>
);
