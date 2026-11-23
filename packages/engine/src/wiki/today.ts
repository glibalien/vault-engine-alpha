import type Database from 'better-sqlite3';
import { getStoredSettings } from '../settings/store.js';

/**
 * The IANA zone a wiki's "today" is taken in (#448), and every other calendar
 * date the Engine shows the owner or tells a model (#459): Curator's `tz`
 * setting, the owner's zone that the installer asks for, else this host's zone,
 * the same fallback Curator applies to an empty `tz`. The Engine stores and
 * serves the curator settings domain, so it reads the value here without
 * importing Curator.
 */
export function wikiTimeZone(db: Database.Database): string {
  const configured = getStoredSettings(db, 'curator').tz;
  const zone = typeof configured === 'string' ? configured.trim() : '';
  if (zone !== '' && isTimeZone(zone)) return zone;
  return hostTimeZone();
}

/** This host's zone: what an empty or unknown `tz` means. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** The calendar date (YYYY-MM-DD) of instant `ms` in `timeZone`. */
export function calendarDate(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const part = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/** `date` (YYYY-MM-DD) moved by whole calendar days; daylight saving does not shift it. */
export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
