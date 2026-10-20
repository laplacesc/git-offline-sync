import type { ReactNode } from "react";

const paths = {
  moon: <path d="M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  clear: <path d="m6 6 12 12M6 18 18 6" />,
  deselect: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 12h8" /></>,
  rebase: <><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 16v-3a7 7 0 0 1 7-7h3M6 10V4m-3 3 3-3 3 3" /></>,
  push: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
  identity: <><circle cx="9" cy="7" r="4" /><path d="M2 21v-2a7 7 0 0 1 10-6m3 8 6-6-3-3-6 6v3h3Z" /></>,
  worktree: <><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7ZM12 10v7m-3-3.5h6" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5M5.1 8a8 8 0 0 1 13.2-3L20 7M4 17l1.7 2A8 8 0 0 0 18.9 16" /></>,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />,
  settings: <><path d="m9 4 1-2h4l1 2 2 1 2-.1 2 3.4-1 1.7v4l1 1.7-2 3.4-2-.1-2 1-1 2h-4l-1-2-2-1-2 .1-2-3.4 1-1.7v-4L3 8.4 5 5l2 .1Z" /><circle cx="12" cy="12" r="3" /></>,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10M18 8v1a6 6 0 0 1-6 6H6" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  monitor: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8m-4-5v5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

/** Decorative icons; the containing control provides its accessible name. */
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`app-icon ${className}`}>
    {paths[name]}
  </svg>;
}
