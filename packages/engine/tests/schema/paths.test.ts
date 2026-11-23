import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { evaluateTemplate, resolveDirectory, resolveFilename } from '../../src/schema/paths.js';
import { setStoredSettings } from '../../src/settings/store.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'task', field_claims: [], default_directory: 'TaskNotes/Tasks' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => db.close());

describe('resolveDirectory', () => {
  it('explicit directory with no schema default → explicit', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: 'Inbox', override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'Inbox', source: 'explicit' });
  });

  it('no directory + schema default → schema_default (uses first type)', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'Notes', source: 'schema_default' });
  });

  it('multi-typed: first type wins', () => {
    const r = resolveDirectory(db, { types: ['task', 'note'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'TaskNotes/Tasks', source: 'schema_default' });
  });

  it('no directory + no schema default → root', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });

  it('empty types + no directory → root', () => {
    const r = resolveDirectory(db, { types: [], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });

  it('explicit directory with schema default + no override → INVALID_PARAMS', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: 'Somewhere', override_default_directory: false });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; code: string }).code).toBe('INVALID_PARAMS');
    expect((r as { ok: false; message: string }).message).toMatch(/routes to "Notes\/"/);
  });

  it('explicit directory with schema default + override_default_directory=true → explicit', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: 'Somewhere', override_default_directory: true });
    expect(r).toEqual({ ok: true, directory: 'Somewhere', source: 'explicit' });
  });

  it('directory ending with .md → INVALID_PARAMS (folder only)', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: 'x.md', override_default_directory: false });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; code: string }).code).toBe('INVALID_PARAMS');
    expect((r as { ok: false; message: string }).message).toMatch(/must be a folder path/);
  });

  it('type without schema → treated as no default (root)', () => {
    const r = resolveDirectory(db, { types: ['nosuch'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });
});

describe('resolveFilename {date} in the configured time zone (#497)', () => {
  const savedTz = process.env.TZ;

  beforeEach(() => {
    createSchemaDefinition(db, { name: 'dated', filename_template: '{date} - {title}.md', field_claims: [] });
    createSchemaDefinition(db, { name: 'plain', filename_template: '{title}.md', field_claims: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  });

  /** Freeze Date.now() at `iso` for the code under test. */
  function pinClock(iso: string): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  function fileName(types: string[] = ['dated']): string {
    const r = resolveFilename(db, { types, title: 'Standup', fields: {} });
    if (!r.ok) throw new Error(r.message);
    return r.fileName;
  }

  it('takes the date in the tz setting late in the evening west of UTC', () => {
    // 23:30 on 9 March in New York is already 10 March in UTC.
    setStoredSettings(db, 'curator', { tz: 'America/New_York' });
    pinClock('2026-03-10T03:30:00Z');
    expect(fileName()).toBe('2026-03-09 - Standup.md');
  });

  it('takes the date in the tz setting early in the morning east of UTC', () => {
    // 05:30 on 10 March in Tokyo is still 9 March in UTC.
    setStoredSettings(db, 'curator', { tz: 'Asia/Tokyo' });
    pinClock('2026-03-09T20:30:00Z');
    expect(fileName()).toBe('2026-03-10 - Standup.md');
  });

  it('keeps the UTC date when the zone is UTC', () => {
    setStoredSettings(db, 'curator', { tz: 'UTC' });
    pinClock('2026-03-10T03:30:00Z');
    expect(fileName()).toBe('2026-03-10 - Standup.md');
  });

  it('follows a tz change on the next call', () => {
    pinClock('2026-03-10T03:30:00Z');
    setStoredSettings(db, 'curator', { tz: 'America/New_York' });
    expect(fileName()).toBe('2026-03-09 - Standup.md');
    setStoredSettings(db, 'curator', { tz: 'Europe/Berlin' });
    expect(fileName()).toBe('2026-03-10 - Standup.md');
  });

  it('leaves a template without {date} alone', () => {
    setStoredSettings(db, 'curator', { tz: 'America/New_York' });
    pinClock('2026-03-10T03:30:00Z');
    expect(fileName(['plain'])).toBe('Standup.md');
    expect(fileName(['bare'])).toBe('Standup.md');
  });

  it('on the installation shape (tz stored empty, host in US Eastern) changes only the evening date', () => {
    process.env.TZ = 'America/New_York';
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
    setStoredSettings(db, 'curator', {
      activeStatuses: ['open', 'in-progress', 'next'], wikiReconciliationMode: 'live', tz: '', topicDir: null,
      memorySweepTypes: ['meeting', 'daily-note', 'note'], orgTypeExclude: ['wiki', 'transcript'],
    });
    const legacy = (): string => `${new Date().toISOString().split('T')[0]} - Standup.md`;

    // Daytime and the small hours: byte-identical to the old UTC expression.
    for (const iso of [
      '2026-11-10T05:00:00Z', // 00:00 EST
      '2026-11-10T15:00:00Z', // 10:00 EST
      '2026-11-10T23:59:59Z', // 18:59 EST, the last unchanged second in winter
      '2026-07-01T12:00:00Z', // 08:00 EDT
      '2026-07-01T23:59:59Z', // 19:59 EDT, the last unchanged second in summer
      '2026-12-31T23:30:00Z', // 18:30 EST on New Year's Eve
    ]) {
      pinClock(iso);
      expect(fileName(), iso).toBe(legacy());
    }

    // From 19:00 EST / 20:00 EDT to midnight: today's local date, not tomorrow's UTC date.
    const evening: Array<[string, string, string]> = [
      ['2026-11-11T00:00:00Z', '2026-11-10', '2026-11-11'], // 19:00 EST
      ['2026-11-11T04:59:59Z', '2026-11-10', '2026-11-11'], // 23:59 EST
      ['2026-07-02T00:00:00Z', '2026-07-01', '2026-07-02'], // 20:00 EDT
      ['2027-01-01T01:30:00Z', '2026-12-31', '2027-01-01'], // 20:30 EST on New Year's Eve: year differs
    ];
    for (const [iso, local, utc] of evening) {
      pinClock(iso);
      expect(fileName(), iso).toBe(`${local} - Standup.md`);
      expect(legacy(), iso).toBe(`${utc} - Standup.md`);
    }
  });
});

describe('evaluateTemplate', () => {
  afterEach(() => vi.useRealTimers());

  it('expands {date} to the date it is given', () => {
    expect(evaluateTemplate('{date} - {title}.md', 'Standup', {}, '2026-03-09')).toBe('2026-03-09 - Standup.md');
  });

  it('defaults {date} to today in the host zone', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T03:30:00Z'));
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: host, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date());
    expect(evaluateTemplate('{date}.md', 'Standup', {})).toBe(`${today}.md`);
  });
});
