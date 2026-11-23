import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { buildProjectDigest } from '../../src/wiki/digest.js';
import { buildProjectEvidence } from '../../src/wiki/evidence.js';
import { addCalendarDays, calendarDate, wikiTimeZone } from '../../src/wiki/today.js';
import { renderWikiLiveSections } from '../../src/wiki/write-helpers.js';
import { setStoredSettings } from '../../src/settings/store.js';

type Db = ReturnType<typeof createTestDb>;
const DAY_MS = 86_400_000;

afterEach(() => {
  vi.useRealTimers();
});

/** Freeze Date.now() at `iso` for the code under test. */
function pinClock(iso: string): number {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  return Date.now();
}

describe('calendarDate and addCalendarDays', () => {
  it('gives the date in the zone, not in UTC', () => {
    const ms = Date.parse('2026-03-10T03:30:00Z');
    expect(calendarDate(ms, 'UTC')).toBe('2026-03-10');
    expect(calendarDate(ms, 'America/New_York')).toBe('2026-03-09');
    expect(calendarDate(Date.parse('2026-03-09T20:30:00Z'), 'Asia/Tokyo')).toBe('2026-03-10');
  });

  it('moves by calendar days across a daylight-saving change and a month end', () => {
    expect(addCalendarDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addCalendarDays('2026-02-27', 14)).toBe('2026-03-13');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('wikiTimeZone', () => {
  it('reads the curator tz setting', () => {
    const db = createTestDb();
    setStoredSettings(db, 'curator', { tz: 'Asia/Tokyo' });
    expect(wikiTimeZone(db)).toBe('Asia/Tokyo');
  });

  it('falls back to the host zone when no tz is configured, or it is empty or unknown', () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const db = createTestDb();
    expect(wikiTimeZone(db)).toBe(host);
    setStoredSettings(db, 'curator', { tz: '  ' });
    expect(wikiTimeZone(db)).toBe(host);
    setStoredSettings(db, 'curator', { tz: 'Mars/Olympus_Mons' });
    expect(wikiTimeZone(db)).toBe(host);
  });
});

describe('wiki today in the configured time zone (#448)', () => {
  it('keeps a task due today out of overdue late in the evening west of UTC', () => {
    // 23:30 on 9 March in New York is already 10 March in UTC.
    const db = createTestDb();
    setStoredSettings(db, 'curator', { tz: 'America/New_York' });
    pinClock('2026-03-10T03:30:00Z');
    seedProjectWithTasks(db, {
      dueYesterday: '2026-03-08',
      dueToday: '2026-03-09',
      dueLastUpcoming: '2026-03-23',
      dueAfterWindow: '2026-03-24',
    });

    const digest = buildProjectDigest(db, { project: 'Project' });
    expect(digest.windows).toEqual({
      today: '2026-03-09', time_zone: 'America/New_York', stale_days: 30, upcoming_days: 14, recent_days: 7,
    });
    expect(digest.tasks.overdue.map(t => t.id)).toEqual(['dueYesterday']);
    expect(digest.tasks.upcoming.map(t => t.id)).toEqual(['dueToday', 'dueLastUpcoming']);
  });

  it('counts a task due yesterday as overdue early in the morning east of UTC', () => {
    // 05:30 on 10 March in Tokyo is still 9 March in UTC.
    const db = createTestDb();
    setStoredSettings(db, 'curator', { tz: 'Asia/Tokyo' });
    pinClock('2026-03-09T20:30:00Z');
    seedProjectWithTasks(db, { dueYesterday: '2026-03-09', dueToday: '2026-03-10' });

    const digest = buildProjectDigest(db, { project: 'Project' });
    expect(digest.windows.today).toBe('2026-03-10');
    expect(digest.tasks.overdue.map(t => t.id)).toEqual(['dueYesterday']);
    expect(digest.tasks.upcoming.map(t => t.id)).toEqual(['dueToday']);
  });

  it('cuts evidence meetings and the meetings page on the same day as the tasks', () => {
    const db = createTestDb();
    setStoredSettings(db, 'curator', { tz: 'America/New_York' });
    const now = pinClock('2026-03-10T03:30:00Z');
    seedProjectWithTasks(db, { dueToday: '2026-03-09' });
    seedNode(db, 'mToday', 'Meeting Today.md', 'Meeting Today', now, ['meeting']);
    seedNode(db, 'mTomorrow', 'Meeting Tomorrow.md', 'Meeting Tomorrow', now, ['meeting']);
    field(db, 'mToday', 'date', '2026-03-09');
    field(db, 'mTomorrow', 'date', '2026-03-10');
    rel(db, 'mToday', 'Project', 'project', 'p1');
    rel(db, 'mTomorrow', 'Project', 'project', 'p1');

    const evidence = buildProjectEvidence(db, { project: 'Project' });
    expect(evidence.windows.today).toBe('2026-03-09');
    expect(evidence.meetings.upcoming.map(m => m.id)).toEqual(['mTomorrow']);
    expect(evidence.meetings.recent.map(m => m.id)).toEqual(['mToday']);

    const digest = buildProjectDigest(db, { project: 'Project' });
    const live = renderWikiLiveSections(db, {
      config: digest.config_used, projectId: 'p1', digest, target: 'subpage', pageKind: 'meetings',
    });
    expect(live.meetings).toMatch(/\*\*Upcoming \(1\)\*\*\n- \[\[Meeting Tomorrow\]\]/);
    expect(live.meetings).toMatch(/\*\*Recent \(1\)\*\*\n- \[\[Meeting Today\]\]/);
  });
});

describe('wiki task windows as settings (#448)', () => {
  it('cuts upcoming, stale, recently done and hot with the configured day counts', () => {
    const db = createTestDb();
    setStoredSettings(db, 'curator', { tz: 'UTC' });
    const now = pinClock('2026-06-15T12:00:00Z');
    seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
    seedTask(db, 'dueIn3', now, 'open', '2026-06-18');
    seedTask(db, 'dueIn5', now, 'open', '2026-06-20');
    seedTask(db, 'doneDayAgo', now - 1 * DAY_MS, 'done', null);
    seedTask(db, 'done3DaysAgo', now - 3 * DAY_MS, 'done', null);
    seedNode(db, 'n12', 'Twelve Days.md', 'Twelve Days', now - 12 * DAY_MS, ['note']);
    rel(db, 'n12', 'Project', 'project', 'p1');

    const defaults = buildProjectDigest(db, { project: 'Project' });
    expect(defaults.tasks.upcoming.map(t => t.id)).toEqual(['dueIn3', 'dueIn5']);
    expect(defaults.tasks.done_recent.map(t => t.id).sort()).toEqual(['done3DaysAgo', 'doneDayAgo']);
    expect(defaults.signals.stale.map(n => n.id)).not.toContain('n12');

    setStoredSettings(db, 'wiki', { upcomingDays: 3, recentDays: 2, staleDays: 10 });
    const configured = buildProjectDigest(db, { project: 'Project' });
    expect(configured.windows).toEqual({
      today: '2026-06-15', time_zone: 'UTC', stale_days: 10, upcoming_days: 3, recent_days: 2,
    });
    expect(configured.tasks.upcoming.map(t => t.id)).toEqual(['dueIn3']);
    expect(configured.tasks.done_recent.map(t => t.id)).toEqual(['doneDayAgo']);
    expect(configured.signals.hot.map(n => n.id)).not.toContain('done3DaysAgo');
    expect(configured.signals.stale.map(n => n.id)).toContain('n12');

    // A caller's explicit window still wins over the setting.
    const overridden = buildProjectDigest(db, { project: 'Project', upcoming_days: 5, stale_days: 30 });
    expect(overridden.windows).toMatchObject({ upcoming_days: 5, stale_days: 30 });
    expect(overridden.tasks.upcoming.map(t => t.id)).toEqual(['dueIn3', 'dueIn5']);
  });
});

function seedProjectWithTasks(db: Db, dueById: Record<string, string>): void {
  const now = Date.now();
  seedNode(db, 'p1', 'Project.md', 'Project', now, ['project']);
  for (const [id, due] of Object.entries(dueById)) seedTask(db, id, now, 'open', due);
}

function seedTask(db: Db, id: string, mtime: number, status: string, due: string | null): void {
  seedNode(db, id, `${id}.md`, id, mtime, ['task']);
  field(db, id, 'status', status);
  if (due !== null) field(db, id, 'due', due);
  rel(db, id, 'Project', 'project', 'p1');
}

function seedNode(db: Db, id: string, path: string, title: string, mtime: number, types: string[]): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, path, title, '', id, mtime, mtime);
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}

function field(db: Db, nodeId: string, name: string, value: string): void {
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)')
    .run(nodeId, name, value, 'frontmatter');
}

function rel(db: Db, source: string, target: string, type: string, resolved: string | null): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
    .run(source, target, type, null, resolved);
}
