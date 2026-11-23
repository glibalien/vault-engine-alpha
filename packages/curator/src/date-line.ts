/**
 * Calendar dates the Curator writes for the owner or tells a model (#459): the wiki Log stamp, the
 * "Today is …" line and the dates printed in evidence. All of them are taken in one zone, the
 * `tz` setting as `Config.curatorTz` carries it (empty `tz` = this host's zone), so they agree
 * with each other, with the journal's headings and with the Engine's wiki "today" (#448). Stored
 * timestamps stay UTC; only these display dates use the zone.
 */

/** This host's zone: what an empty `tz` means. */
function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** `timeZone` when it names a zone, else the host's: the fallback Engine's `wikiTimeZone` applies. */
function usableTimeZone(timeZone: string | undefined): string {
  const zone = timeZone?.trim() ?? '';
  if (zone === '') return hostTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return hostTimeZone();
  }
}

/** The calendar date (YYYY-MM-DD) of `instant` in `timeZone`; the host's zone when absent. */
export function localDate(instant: Date | number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: usableTimeZone(timeZone), calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/** e.g. "Today is Friday, 2026-07-10 (Europe/Amsterdam)." Built per call — never
 *  capture at module load; the curator daemon runs for days. Date-only: a clock
 *  time would change the system prompt on every call and defeat prefix caching. */
export function currentDateLine(now: Date = new Date(), timeZone?: string): string {
  const zone = usableTimeZone(timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(now);
  return `Today is ${weekday}, ${localDate(now, zone)} (${zone}).`;
}

/** Prepend the run's date so Log entries are consistently dated regardless of model output. */
export function stampLog(logEntry: string, date: Date = new Date(), timeZone?: string): string {
  return `**${localDate(date, timeZone)}** — ${logEntry}`;
}
