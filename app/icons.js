// Ícones de traço usados no site (decorativos: aria-hidden).

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export function Logo({ live = false, size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="28" height="20" rx="6" stroke="currentColor" strokeWidth="2.3" />
      <path d="M12 31h10" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
      <circle cx="24.5" cy="13.5" r="2.7" fill={live ? "var(--live)" : "var(--accent)"} />
    </svg>
  );
}

export const IconVolume = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  </svg>
);
export const IconVolumeLoud = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 5a10 10 0 0 1 0 14" />
  </svg>
);
export const IconMute = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M22 9l-6 6M16 9l6 6" />
  </svg>
);
export const IconFull = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);
export const IconX = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const IconCopy = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
export const IconSend = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={2.2}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconStop = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);
export const IconGrid = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={1.8}>
    <rect x="2" y="4" width="9" height="7" rx="2" />
    <rect x="13" y="4" width="9" height="7" rx="2" />
    <rect x="2" y="13" width="9" height="7" rx="2" />
    <rect x="13" y="13" width="9" height="7" rx="2" />
  </svg>
);
export const IconChat = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={1.8}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />
    <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
  </svg>
);
export const IconScreen = ({ size = 40 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={1.6}>
    <rect x="2" y="4" width="20" height="13" rx="3" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);
