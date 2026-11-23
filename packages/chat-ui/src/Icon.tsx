const PATHS = {
  files: '<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h4l2 2.5h5A1.5 1.5 0 0 1 17 7v8.5A1.5 1.5 0 0 1 15.5 17h-11A1.5 1.5 0 0 1 3 15.5z"/>',
  types: '<circle cx="6" cy="6" r="2.4"/><circle cx="14" cy="6" r="2.4"/><circle cx="10" cy="14" r="2.4"/><path d="M6 8.4v.6a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-.6"/>',
  graph: '<circle cx="5" cy="5" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="10" cy="15" r="2"/><path d="M6.7 6.3 8.7 13M13.6 7.4 11.2 13.6M6.8 5.6l6.4.6"/>',
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 3.5 3.5"/>',
  pin: '<path d="M10 2.5v6M6.5 8.5h7l-1.2 3.5h-4.6zM10 12v5.5"/>',
  send: '<path d="M3.4 10 16.5 4l-3 12-3.8-4.4z"/><path d="M9.7 11.6 16.5 4"/>',
  check: '<path d="M4 10.5 8 14.5 16 5.5"/>',
  chevron: '<path d="M7.5 4.5 13 10l-5.5 5.5"/>',
  sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M16 4l-1.4 1.4M5.4 14.6 4 16"/>',
  moon: '<path d="M16 11.2A6.5 6.5 0 0 1 8.8 4 6.5 6.5 0 1 0 16 11.2"/>',
  cmd: '<path d="M7 4.5A2.5 2.5 0 1 0 9.5 7v6A2.5 2.5 0 1 0 7 15.5 2.5 2.5 0 0 0 9.5 13V7A2.5 2.5 0 0 0 7 4.5M13 4.5A2.5 2.5 0 1 1 10.5 7v6a2.5 2.5 0 1 0 2.5-2.5"/>',
  sparkle: '<path d="M10 2.5 11.6 7.4 16.5 9 11.6 10.6 10 15.5 8.4 10.6 3.5 9 8.4 7.4z"/>',
  close: '<path d="M5 5l10 10M15 5 5 15"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  table: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M3 12h14M8.5 8v8"/>',
  kanban: '<rect x="3" y="4" width="4" height="12" rx="1"/><rect x="8" y="4" width="4" height="9" rx="1"/><rect x="13" y="4" width="4" height="7" rx="1"/>',
  list: '<path d="M7 5.5h9M7 10h9M7 14.5h9M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01"/>',
  filter: '<path d="M3.5 5h13l-5 6v4l-3 1.5V11z"/>',
  sort: '<path d="M6 4v12M6 16l-2.5-2.5M6 16l2.5-2.5M13 4l2.5 2.5M13 4l-2.5 2.5M13 4v12"/>',
  refresh: '<path d="M15.5 6.5A6 6 0 1 0 16 10M15.5 3.5v3h-3"/>',
  doc: '<path d="M5 3.5h6l3.5 3.5v9.5A1 1 0 0 1 13.5 17h-8.5A1 1 0 0 1 4 16V4.5A1 1 0 0 1 5 3.5z"/><path d="M11 3.5V7h3.5"/>',
  chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v5A1.5 1.5 0 0 1 14.5 12H7l-3 3z"/>',
  calendar: '<rect x="3.5" y="4.5" width="13" height="12" rx="1.5"/><path d="M3.5 8h13M7 3v3M13 3v3"/>',
  jump: '<path d="M5 10h10M11 6l4 4-4 4"/>',
  panelRight: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M12.5 4v12"/>',
  panelLeft: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M7.5 4v12"/>',
  layout: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 9h14M9 9v7"/>',
  dot: '<circle cx="10" cy="10" r="3"/>',
  mic: '<rect x="7.5" y="2.5" width="5" height="9" rx="2.5"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5v2.5M7 17h6"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/>',
  trash: '<path d="M4 6h12M8 6V4.5h4V6M7 6v9.5h6V6"/>',
  link: '<path d="M8 12h4"/><path d="M9.5 7.5 7 7.5a4.5 4.5 0 0 0 0 9l2.5 0"/><path d="M14.5 7.5 17 7.5a4.5 4.5 0 0 1 0 9l-2.5 0"/>',
} as const;

export type IconName = keyof typeof PATHS;

import type { CSSProperties } from 'react';

export function Icon({ name, className, style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
