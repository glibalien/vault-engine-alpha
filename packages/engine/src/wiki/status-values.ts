// src/wiki/status-values.ts
//
// The values of a wiki home page's `wiki_status` field (#547).

export const WIKI_STATUSES = ['current', 'behind', 'paused', 'paused-behind', 'building', 'failed'] as const;

export type WikiStatus = typeof WIKI_STATUSES[number];

export function isWikiStatus(value: unknown): value is WikiStatus {
  return typeof value === 'string' && (WIKI_STATUSES as readonly string[]).includes(value);
}
