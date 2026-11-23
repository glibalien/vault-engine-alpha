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

/** Lucide glyphs (24-unit grid) — the icon family Obsidian and Bases use, for the
 *  Bases-style toolbar, layout menu and property-type headers. Licensed ISC (lucide.dev). */
const LUCIDE = {
  'b-table': '<path d="M12 3v18"/> <rect width="18" height="18" x="3" y="3" rx="2"/> <path d="M3 9h18"/> <path d="M3 15h18"/>',
  'b-kanban': '<rect width="18" height="18" x="3" y="3" rx="2"/> <path d="M8 7v7"/> <path d="M12 7v4"/> <path d="M16 7v9"/>',
  'b-list': '<path d="M13 5h8"/> <path d="M13 12h8"/> <path d="M13 19h8"/> <path d="m3 17 2 2 4-4"/> <path d="m3 7 2 2 4-4"/>',
  'b-calendar': '<path d="M8 2v3"/> <path d="M16 2v3"/> <rect x="3" y="3" width="18" height="18" rx="2"/> <path d="M3 9h18"/>',
  'b-sort': '<path d="m21 16-4 4-4-4"/> <path d="M17 20V4"/> <path d="m3 8 4-4 4 4"/> <path d="M7 4v16"/>',
  'b-filter': '<path d="M2 5h20"/> <path d="M6 12h12"/> <path d="M9 19h6"/>',
  'b-properties': '<path d="M3 5h.01"/> <path d="M3 12h.01"/> <path d="M3 19h.01"/> <path d="M8 5h13"/> <path d="M8 12h13"/> <path d="M8 19h13"/>',
  'b-search': '<path d="m21 21-4.34-4.34"/> <circle cx="11" cy="11" r="8"/>',
  'b-plus': '<path d="M5 12h14"/> <path d="M12 5v14"/>',
  'b-chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'b-sparkles': '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/> <path d="M20 2v4"/> <path d="M22 4h-4"/> <circle cx="4" cy="20" r="2"/>',
  'b-refresh': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/> <path d="M21 3v5h-5"/> <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/> <path d="M8 16H3v5"/>',
  'b-check': '<path d="M20 6 9 17l-5-5"/>',
  'b-x': '<path d="M18 6 6 18"/> <path d="m6 6 12 12"/>',
  'b-pin': '<path d="M12 17v5"/> <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  'b-pin-off': '<path d="M12 17v5"/> <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/> <path d="m2 2 20 20"/> <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
  'b-file': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/> <path d="M14 2v5a1 1 0 0 0 1 1h5"/> <path d="M10 9H8"/> <path d="M16 13H8"/> <path d="M16 17H8"/>',
  'b-text': '<path d="M21 5H3"/> <path d="M15 12H3"/> <path d="M17 19H3"/>',
  'b-hash': '<line x1="4" x2="20" y1="9" y2="9"/> <line x1="4" x2="20" y1="15" y2="15"/> <line x1="10" x2="8" y1="3" y2="21"/> <line x1="16" x2="14" y1="3" y2="21"/>',
  'b-link': '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/> <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'b-checkbox': '<rect width="18" height="18" x="3" y="3" rx="2"/> <path d="m16 9-5.5 5.5L8 12"/>',
  'b-tag': '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/> <circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  'b-enum': '<circle cx="12" cy="12" r="1"/> <circle cx="12" cy="12" r="10"/>',
  'b-more': '<circle cx="12" cy="12" r="1"/> <circle cx="19" cy="12" r="1"/> <circle cx="5" cy="12" r="1"/>',
  'b-stats': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/> <path d="M18 17V9"/> <path d="M13 17V5"/> <path d="M8 17v-3"/>',
  'b-coins': '<path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"/> <path d="M15 6h1v4"/> <path d="m6.134 14.768.866-.5 2 3.464"/> <circle cx="16" cy="8" r="6"/>',
  'b-boards': '<rect width="7" height="9" x="3" y="3" rx="1"/> <rect width="7" height="5" x="14" y="3" rx="1"/> <rect width="7" height="9" x="14" y="12" rx="1"/> <rect width="7" height="5" x="3" y="16" rx="1"/>',
  'b-overflow': '<path d="m6 17 5-5-5-5"/> <path d="m13 17 5-5-5-5"/>',
  'b-eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/> <circle cx="12" cy="12" r="3"/>',
  'b-arrow-up': '<path d="m5 12 7-7 7 7"/> <path d="M12 19V5"/>',
  'b-arrow-down': '<path d="M12 5v14"/> <path d="m19 12-7 7-7-7"/>',
  'b-trash': '<path d="M10 11v6"/> <path d="M14 11v6"/> <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/> <path d="M3 6h18"/> <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  'b-pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/> <path d="m15 5 4 4"/>',
  'b-unlink': '<path d="M9 17H7A5 5 0 0 1 7 7"/> <path d="M15 7h2a5 5 0 0 1 4 8"/> <line x1="8" x2="12" y1="12" y2="12"/> <line x1="2" x2="22" y1="2" y2="22"/>',
  'b-book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/> <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  'b-house': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/> <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'b-rotate-cw': '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/> <path d="M21 3v5h-5"/>',
  'b-layers': '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/> <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/> <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  'b-chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'b-clock': '<circle cx="12" cy="12" r="10"/> <path d="M12 6v6l4 2"/>',
  'b-info': '<circle cx="12" cy="12" r="10"/> <path d="M12 16v-4"/> <path d="M12 8h.01"/>',
  'b-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/> <path d="M12 9v4"/> <path d="M12 17h.01"/>',
  'b-history': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/> <path d="M3 3v5h5"/> <path d="M12 7v5l4 2"/>',
  'b-undo': '<path d="M9 14 4 9l5-5"/> <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  'b-library': '<path d="m16 6 4 14"/> <path d="M12 6v14"/> <path d="M8 8v12"/> <path d="M4 4v16"/>',
  'b-collapse-all': '<path d="m3 10 2.5-2.5L3 5"/> <path d="m3 19 2.5-2.5L3 14"/> <path d="M10 6h11"/> <path d="M10 12h11"/> <path d="M10 18h11"/>',
  'b-unplug': '<path d="m19 5 3-3"/> <path d="m2 22 3-3"/> <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/> <path d="M7.5 13.5 10 11"/> <path d="M10.5 16.5 13 14"/> <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
  'b-globe': '<circle cx="12" cy="12" r="10"/> <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/> <path d="M2 12h20"/>',
  'b-circle-check': '<circle cx="12" cy="12" r="10"/> <path d="m9 12 2 2 4-4"/>',
  'b-contact': '<path d="M16 2v2"/> <path d="M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/> <path d="M8 2v2"/> <circle cx="12" cy="11" r="3"/> <rect x="3" y="4" width="18" height="18" rx="2"/>',
  'b-user': '<circle cx="12" cy="8" r="5"/> <path d="M20 21a8 8 0 0 0-16 0"/>',
  'b-building': '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/> <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/> <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/> <path d="M10 6h4"/> <path d="M10 10h4"/> <path d="M10 14h4"/> <path d="M10 18h4"/>',
} as const;

export type IconName = keyof typeof PATHS | keyof typeof LUCIDE;

import type { CSSProperties } from 'react';

export function Icon({ name, className, style }: { name: IconName; className?: string; style?: CSSProperties }) {
  const lucide = name in LUCIDE;
  const markup = lucide ? LUCIDE[name as keyof typeof LUCIDE] : PATHS[name as keyof typeof PATHS];
  return (
    <svg
      viewBox={lucide ? '0 0 24 24' : '0 0 20 20'}
      fill="none"
      stroke="currentColor"
      strokeWidth={lucide ? 1.75 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
