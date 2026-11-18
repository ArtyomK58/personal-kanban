import type { SVGProps } from "react";
const base = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
type P = SVGProps<SVGSVGElement> & { size?: number };
const I = ({ size = 16, children, ...p }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" strokeWidth={1.5} {...base} {...p}>{children}</svg>
);
export const Logo = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#2F4FBF" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <rect x="2" y="2" width="16" height="16" rx="4" /><path d="M6.5 6v8M10 6v5M13.5 6v3" />
  </svg>
);
export const Plus = (p: P) => <I strokeWidth={1.6} {...p}><path d="M8 3v10M3 8h10" /></I>;
export const Snowflake = (p: P) => <I size={14} strokeWidth={1.35} {...p}>
  <path d="M8 1.5v13M2.4 4.75l11.2 6.5m0-6.5-11.2 6.5M6.2 2.7 8 4.5l1.8-1.8m0 10.6L8 11.5l-1.8 1.8M2.6 6.8l2.4-.7-.6-2.4m7.2 8.6-.6-2.4 2.4-.7m0-2.4-2.4-.7.6-2.4m-7.2 8.6.6-2.4-2.4-.7" />
</I>;
export const Search = (p: P) => <I {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></I>;
export const More = (p: P) => <I strokeWidth={2.2} {...p}><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" /></I>;
export const Check = (p: P) => <I strokeWidth={1.8} {...p}><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></I>;
export const CopyLink = (p: P) => <I {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6A1 1 0 0 0 2.5 3.5v6A1 1 0 0 0 3.5 10.5h2" /></I>;
export const Close = (p: P) => <I strokeWidth={1.6} {...p}><path d="M4 4l8 8M12 4l-8 8" /></I>;
export const CommentIcon = (p: P) => <I size={14} strokeWidth={1.4} {...p}><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" /></I>;
export const Lines = (p: P) => <I size={14} strokeWidth={1.4} {...p}><path d="M3 4.5h10M3 8h10M3 11.5h6" /></I>;
export const Calendar = (p: P) => <I size={14} strokeWidth={1.4} {...p}><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></I>;
export const External = (p: P) => <I {...p}><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" /></I>;
export const ArrowLeft = (p: P) => <I {...p}><path d="M13 8H3M7 4 3 8l4 4" /></I>;
export const Alert = (p: P) => <I {...p}><circle cx="8" cy="8" r="6" /><path d="M8 5v3.5M8 11h.01" /></I>;
export const Trash = (p: P) => <I {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></I>;
export const Pencil = (p: P) => <I {...p}><path d="M10.5 3.5l2 2L6 12H4v-2z" /></I>;
