import type { ReactNode } from "react";

const paths = {
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />,
  settings: <><path d="m9 4 1-2h4l1 2 2 1 2-.1 2 3.4-1 1.7v4l1 1.7-2 3.4-2-.1-2 1-1 2h-4l-1-2-2-1-2 .1-2-3.4 1-1.7v-4L3 8.4 5 5l2 .1Z" /><circle cx="12" cy="12" r="3" /></>,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10M18 8v1a6 6 0 0 1-6 6H6" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  monitor: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8m-4-5v5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
} satisfies Record<string, ReactNode>;

/** Decorative icons; the containing control provides its accessible name. */
export function Icon({ name, className = "" }: { name: keyof typeof paths; className?: string }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`app-icon ${className}`}>
    {paths[name]}
  </svg>;
}
