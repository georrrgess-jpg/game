// Small inline icon set (stroke icons, 24px grid). Decorative unless given a label.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { label?: string };

function Svg({ label, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} {...rest}>
      {children}
    </svg>
  );
}

export const IconToday = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <circle cx="12" cy="15" r="1.6" fill="currentColor" />
  </Svg>
);
export const IconGames = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);
export const IconMarket = (p: P) => (
  <Svg {...p}>
    <path d="M4 19V5M4 19h16" />
    <path d="m7 14 3.5-4 3 2.5L19 7" />
  </Svg>
);
export const IconEvidence = (p: P) => (
  <Svg {...p}>
    <path d="M6 3.5h9l3.5 3.5v13.5H6z" />
    <path d="M9 11h6M9 14.5h6M9 18h3.5" />
  </Svg>
);
export const IconLab = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 3.5v6L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3l-5-8.5v-6" />
    <path d="M8 3.5h8M7.5 15h9" />
  </Svg>
);
export const IconReport = (p: P) => (
  <Svg {...p}>
    <path d="M4 20 20 4" strokeDasharray="2 3" />
    <circle cx="7" cy="16" r="1.5" fill="currentColor" />
    <circle cx="11" cy="12.5" r="1.5" fill="currentColor" />
    <circle cx="15.5" cy="9" r="1.5" fill="currentColor" />
    <path d="M3.5 3.5v17h17" />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Svg>
);
export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.5v.5" />
  </Svg>
);
export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconQuestion = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.6-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.3l1.4-1.8M20 20v-4.5h-4.5" />
  </Svg>
);
export const IconSpark = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
);
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10.5l5 5 5-5M4.5 20h15" />
  </Svg>
);
export const IconPrint = (p: P) => (
  <Svg {...p}>
    <path d="M7 9V3.5h10V9M7 17H4.5v-6.5a1.5 1.5 0 0 1 1.5-1.5h12a1.5 1.5 0 0 1 1.5 1.5V17H17" />
    <path d="M7 14h10v6.5H7z" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M9 5v14M15 5v14" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="m8 5 11 7-11 7z" />
  </Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.6 6.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);

export function BrandMark(p: P) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...p}>
      <rect width="32" height="32" rx="9" fill="var(--panel-3)" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="var(--accent)" strokeWidth="3" />
      <path d="M16 7a9 9 0 0 1 9 9" fill="none" stroke="var(--warn)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
