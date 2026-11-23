import type { SettingDescriptor } from '../types.js';

/**
 * Wiki rendering settings (`Settings/Wiki.md`). The names wikis read in notes (kinds, fields,
 * status values, the wiki folder) moved to the vault domain; their old keys here are aliases
 * (`VAULT_ALIASES`).
 */
export interface WikiSettings {
  subpageCap: number; liveTaskGroupCap: number; liveRelatedCap: number;
  renderRelatedLive: boolean;
  staleDays: number; upcomingDays: number; recentDays: number;
}

const n = (key: string, dflt: number, description: string): SettingDescriptor =>
  ({ key, domain: 'wiki', type: { kind: 'int', min: 1 }, default: dflt, reload: 'next-use', description });
// A day-count window. Capped at ten years so a date computed from it stays in range.
const days = (key: string, dflt: number, description: string): SettingDescriptor =>
  ({ key, domain: 'wiki', type: { kind: 'int', min: 1, max: 3650 }, default: dflt, reload: 'next-use', description });

export const WIKI_DESCRIPTORS: SettingDescriptor[] = [
  n('subpageCap', 20, 'Maximum sub-pages listed on a wiki home.'),
  n('liveTaskGroupCap', 8, 'Maximum tasks rendered per live task group.'),
  n('liveRelatedCap', 12, 'Maximum entries in live related sections.'),
  { key: 'renderRelatedLive', domain: 'wiki', type: { kind: 'bool' }, default: true, reload: 'next-use',
    description: 'Render live related sections on wiki pages.' },
  days('staleDays', 30, 'Days without a change after which a project\'s notes and tasks count as stale.'),
  days('upcomingDays', 14, 'Days ahead, counting from today, in which an open task\'s due date makes it upcoming. Today is the date in Curator\'s tz setting, else the Engine host\'s zone.'),
  days('recentDays', 7, 'Days back in which a finished task counts as recently done and a changed note counts toward recent activity.'),
];
