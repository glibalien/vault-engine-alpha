import { describe, expect, it } from 'vitest';
import { defaultsFor, SEED_MODELS } from '@vault/settings-registry';
import type { CuratorSettings } from '@vault/settings-registry';
import { currentDateLine, localDate, stampLog } from '../src/date-line.js';
import { sweepSystem, EXTRACT_SYSTEM_PROMPT, buildExtractionUser } from '../src/memory-sweep.js';
import { conversationSystem } from '../src/conversation-sweep.js';
import { buildRuntimeConfig } from '../src/settings.js';
import type { BootstrapConfig } from '../src/config.js';

const HOST = Intl.DateTimeFormat().resolvedOptions().timeZone;
// 22:30 on Monday 9 March in New York, already Tuesday 10 March in UTC.
const NY_EVENING = new Date('2026-03-10T03:30:00Z');
// 05:30 on Tuesday 10 March in Tokyo, still Monday 9 March in UTC and in New York.
const TOKYO_MORNING = new Date('2026-03-09T20:30:00Z');

/** The line and stamp as the code before #459 wrote them: the host's zone, and UTC for the stamp. */
function legacyDateLine(now: Date): string {
  return `Today is ${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${now.toLocaleDateString('en-CA')} (${HOST}).`;
}

describe('currentDateLine', () => {
  it('formats weekday, local ISO date, and timezone', () => {
    expect(currentDateLine(new Date(2026, 6, 10))).toMatch(/^Today is Friday, 2026-07-10 \(.+\)\.$/);
  });
  it('defaults to now', () => {
    expect(currentDateLine()).toMatch(/^Today is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
  });
  it('takes the date and weekday in the configured zone, not the host\'s or UTC (#459)', () => {
    expect(currentDateLine(NY_EVENING, 'America/New_York')).toBe('Today is Monday, 2026-03-09 (America/New_York).');
    expect(currentDateLine(NY_EVENING, 'UTC')).toBe('Today is Tuesday, 2026-03-10 (UTC).');
    expect(currentDateLine(TOKYO_MORNING, 'Asia/Tokyo')).toBe('Today is Tuesday, 2026-03-10 (Asia/Tokyo).');
  });
  it('uses the host zone for an absent, empty or unknown zone, as the Engine does', () => {
    for (const zone of [undefined, '', '  ', 'Mars/Olympus_Mons']) {
      expect(currentDateLine(NY_EVENING, zone)).toBe(legacyDateLine(NY_EVENING));
    }
  });
});

describe('localDate and stampLog', () => {
  it('give the calendar date in the configured zone', () => {
    expect(localDate(NY_EVENING, 'America/New_York')).toBe('2026-03-09');
    expect(localDate(NY_EVENING.getTime(), 'UTC')).toBe('2026-03-10');
    expect(localDate(TOKYO_MORNING, 'Asia/Tokyo')).toBe('2026-03-10');
    expect(stampLog('did a thing', NY_EVENING, 'America/New_York')).toBe('**2026-03-09** — did a thing');
    expect(stampLog('did a thing', TOKYO_MORNING, 'Asia/Tokyo')).toBe('**2026-03-10** — did a thing');
  });
  it('stamp the host\'s date without a zone', () => {
    expect(stampLog('x', NY_EVENING)).toBe(`**${NY_EVENING.toLocaleDateString('en-CA')}** — x`);
  });
});

describe('sweepSystem', () => {
  it('is the extraction prompt plus the date line', () => {
    const out = sweepSystem(new Date(2026, 6, 10));
    expect(out.startsWith(EXTRACT_SYSTEM_PROMPT)).toBe(true);
    expect(out).toMatch(/\n\nToday is Friday, 2026-07-10 \(.+\)\.$/);
  });
  it('writes the date line in the configured zone', () => {
    expect(sweepSystem(TOKYO_MORNING, EXTRACT_SYSTEM_PROMPT, 'Asia/Tokyo')).toMatch(/\n\nToday is Tuesday, 2026-03-10 \(Asia\/Tokyo\)\.$/);
    expect(conversationSystem(TOKYO_MORNING, undefined, 'Asia/Tokyo')).toMatch(/\n\nToday is Tuesday, 2026-03-10 \(Asia\/Tokyo\)\.$/);
  });
  it('counts a note\'s age from today in the configured zone', () => {
    const note = { title: 'Note', file_path: 'Note.md', body: 'Body.', date: '2025-12-31' };
    // 22:00 on 31 December in New York: a year to the day, not yet "a year before today".
    const newYearsEve = new Date('2027-01-01T03:00:00Z');
    expect(buildExtractionUser(note, [], 3, null, [], newYearsEve, 'America/New_York')).toContain('NOTE DATE: 2025-12-31\n');
    expect(buildExtractionUser(note, [], 3, null, [], newYearsEve, 'UTC')).toContain('NOTE DATE: 2025-12-31 (about 1 year before today)');
  });
});

describe('an existing installation (tz stored empty) after #459', () => {
  const bootstrap: BootstrapConfig = {
    engineUrl: 'http://e', engineToken: 't', experiment: null, variant: null,
    llmKeys: { keys: { anthropic: 'ak' }, baseURLs: {} },
    oauthOwnerPassword: undefined, oauthIssuerUrl: undefined,
    curatorPort: 3335, curatorDbPath: ':memory:', memorySweepSince: null, conversationSweepSince: null,
  };
  const installed: CuratorSettings = {
    ...(defaultsFor('curator') as unknown as CuratorSettings),
    wikiReconciliationMode: 'live', tz: '', memorySweepEnabled: true, memorySweepTypes: ['meeting', 'daily-note', 'note'],
    orgSweepEnabled: true, orgTypeExclude: ['wiki', 'transcript'], journalEnabled: true,
  };
  const config = buildRuntimeConfig(bootstrap, installed, [...SEED_MODELS], { settingsDir: 'Settings' });
  const instants = [NY_EVENING, TOKYO_MORNING, new Date('2026-07-01T12:00:00Z'), new Date('2026-11-01T05:30:00Z')];

  it('writes the same "Today is" line as before, byte for byte', () => {
    expect(config.curatorTz).toBe(HOST);
    for (const now of instants) expect(currentDateLine(now, config.curatorTz)).toBe(legacyDateLine(now));
  });

  it('stamps the Log with the host\'s local date, where it used the UTC date', () => {
    for (const now of instants) expect(stampLog('x', now, config.curatorTz)).toBe(`**${now.toLocaleDateString('en-CA')}** — x`);
  });
});
