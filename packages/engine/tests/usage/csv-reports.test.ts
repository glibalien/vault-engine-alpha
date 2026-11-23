import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addUsageEvents, upgradeConversationsStore } from '../../src/db/migrate.js';
import { UsageRecorder } from '../../src/usage/recorder.js';
import { startUsageCsvReports, writeUsageCsvReports } from '../../src/usage/csv-reports.js';

let db: Database.Database;
let rec: UsageRecorder;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  addUsageEvents(db);
  upgradeConversationsStore(db); // by-conversation join target (Task 3)
  rec = new UsageRecorder(db);
  dir = mkdtempSync(join(tmpdir(), 'vault-csv-reports-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** File lines without the trailing newline-induced empty element. */
const lines = (name: string): string[] => {
  const text = readFileSync(join(dir, name), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
};

const EVENTS_HEADER =
  'id,ts,provider,model,service,purpose,input_tokens,output_tokens,'
  + 'cache_read_tokens,cache_write_tokens,audio_seconds,cost_usd,cost_basis,pricing_json,'
  + 'conversation_id,run_ref,source_ref,experiment,variant,latency_ms,request_id,metadata_json,'
  + 'confirmation_status,confirmed_cost_usd';

describe('writeUsageCsvReports — usage-events.csv', () => {
  it('writes the full ledger ordered ts ASC, id ASC with an exact header', () => {
    // Inserted out of chronological order on purpose:
    rec.recordOrThrow({ ts: '2026-07-02T10:00:00.000Z', provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 0.007 });
    rec.recordOrThrow({ ts: '2026-07-01T10:00:00.000Z', provider: 'fireworks', service: 'chat-web', purpose: 'conversation', model: 'mystery-model', inputTokens: 100, conversationId: 'conv-A' });

    const stats = writeUsageCsvReports(db, dir);

    expect(stats.files['usage-events.csv']).toBe(2);
    const rows = lines('usage-events.csv');
    expect(rows[0]).toBe(EVENTS_HEADER);
    expect(rows).toHaveLength(3); // header + 2 events
    expect(rows[1]).toContain('2026-07-01T10:00:00.000Z'); // earlier ts first despite later insert
    expect(rows[1]).toContain('conv-A');
    expect(rows[2]).toContain('2026-07-02T10:00:00.000Z');
    expect(rows[2]).toContain('provider-reported');
  });

  it('escapes JSON blob cells RFC-4180 style and round-trips their content', () => {
    rec.recordOrThrow({
      ts: '2026-07-01T10:00:00.000Z', provider: 'fireworks', service: 'chat-web',
      purpose: 'conversation', model: 'mystery-model',
      metadata: { note: 'a,"b"\nc' }, // comma, quotes, and newline in one cell
    });
    writeUsageCsvReports(db, dir);
    const text = readFileSync(join(dir, 'usage-events.csv'), 'utf8');
    // JSON.stringify({note:'a,"b"\nc'}) === '{"note":"a,\"b\"\\nc"}' — every " doubles:
    expect(text).toContain('"{""note"":""a,\\\""b\\\""\\nc""}"');
  });

  it('writes a header-only file for an empty ledger', () => {
    const stats = writeUsageCsvReports(db, dir);
    expect(stats.files['usage-events.csv']).toBe(0);
    expect(lines('usage-events.csv')).toEqual([EVENTS_HEADER]);
  });

  it('creates the reports directory and leaves no .tmp files behind', () => {
    const nested = join(dir, 'sub', 'reports');
    writeUsageCsvReports(db, nested);
    const names = readdirSync(nested);
    expect(names).toContain('usage-events.csv');
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('writeUsageCsvReports — usage-daily.csv / usage-monthly.csv', () => {
  it('buckets by UTC day and orders day ASC then cost DESC within a day', () => {
    // Same UTC day, different costs — cheap first in insert order:
    rec.recordOrThrow({ ts: '2026-07-01T02:00:00.000Z', provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 1 });
    rec.recordOrThrow({ ts: '2026-07-01T23:30:00.000Z', provider: 'anthropic', service: 'curator', purpose: 'wiki-synthesis', model: 'mystery-a', inputTokens: 10 });
    rec.recordOrThrow({ ts: '2026-07-01T03:00:00.000Z', provider: 'exa', service: 'chat-web', purpose: 'web-search', providerCostUsd: 5 });
    // Next UTC day (23:30Z stays on its own day — no local-time shift):
    rec.recordOrThrow({ ts: '2026-07-02T00:10:00.000Z', provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 2 });

    writeUsageCsvReports(db, dir);
    const rows = lines('usage-daily.csv');
    expect(rows[0]).toBe(
      'day,service,provider,model,purpose,events,input_tokens,output_tokens,'
      + 'cache_read_tokens,cache_write_tokens,audio_seconds,cost_usd,unpriced_events,'
      + 'confirmed_usd,confirmed_events,confirmed_ledger_usd');
    // 2026-07-01 first (day ASC), its groups cost DESC: $5 chat-web, $1 engine, $0 unpriced curator.
    expect(rows[1]).toBe('2026-07-01,chat-web,exa,,web-search,1,0,0,0,0,0,5,0,0,0,0');
    expect(rows[2]).toBe('2026-07-01,engine,exa,,web-search,1,0,0,0,0,0,1,0,0,0,0');
    expect(rows[3]).toBe('2026-07-01,curator,anthropic,mystery-a,wiki-synthesis,1,10,0,0,0,0,0,1,0,0,0');
    expect(rows[4]).toBe('2026-07-02,engine,exa,,web-search,1,0,0,0,0,0,2,0,0,0,0');
    expect(rows).toHaveLength(5);
  });

  it('counts unpriced events per group, zero for priced groups', () => {
    rec.recordOrThrow({ ts: '2026-07-01T01:00:00.000Z', provider: 'fireworks', service: 'chat-web', purpose: 'conversation', model: 'mystery-b', inputTokens: 1 });
    rec.recordOrThrow({ ts: '2026-07-01T02:00:00.000Z', provider: 'fireworks', service: 'chat-web', purpose: 'conversation', model: 'mystery-b', inputTokens: 1 });
    writeUsageCsvReports(db, dir);
    const rows = lines('usage-daily.csv');
    expect(rows[1]).toBe('2026-07-01,chat-web,fireworks,mystery-b,conversation,2,2,0,0,0,0,0,2,0,0,0');
  });

  it('buckets months as YYYY-MM ordered month ASC then cost DESC', () => {
    rec.recordOrThrow({ ts: '2026-06-30T23:59:00.000Z', provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 1 });
    rec.recordOrThrow({ ts: '2026-07-01T00:01:00.000Z', provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 2 });
    rec.recordOrThrow({ ts: '2026-07-05T00:00:00.000Z', provider: 'anthropic', service: 'curator', purpose: 'wiki-synthesis', model: 'mystery-c', inputTokens: 7 });
    writeUsageCsvReports(db, dir);
    const rows = lines('usage-monthly.csv');
    expect(rows[0]).toBe(
      'month,provider,events,input_tokens,output_tokens,'
      + 'cache_read_tokens,cache_write_tokens,audio_seconds,cost_usd,unpriced_events,'
      + 'confirmed_usd,confirmed_events,confirmed_ledger_usd');
    expect(rows[1]).toBe('2026-06,exa,1,0,0,0,0,0,1,0,0,0,0');
    expect(rows[2]).toBe('2026-07,exa,1,0,0,0,0,0,2,0,0,0,0');
    expect(rows[3]).toBe('2026-07,anthropic,1,7,0,0,0,0,0,1,0,0,0');
    expect(rows).toHaveLength(4);
  });
});

describe('writeUsageCsvReports — provider confirmations (#329)', () => {
  it('shows a confirmation beside its row and in the daily and monthly summaries', () => {
    rec.recordOrThrow({ ts: '2026-07-01T10:00:00.000Z', provider: 'deepgram', service: 'engine', purpose: 'audio-transcription', model: 'nova-3', audioSeconds: 600, requestId: 'r1' });
    rec.recordOrThrow({ ts: '2026-07-01T11:00:00.000Z', provider: 'deepgram', service: 'engine', purpose: 'audio-transcription', model: 'nova-3', audioSeconds: 600, requestId: 'r2' });
    const [first, second] = (db.prepare('SELECT id, cost_usd FROM usage_events ORDER BY id').all() as Array<{ id: number; cost_usd: number }>);
    db.prepare("INSERT INTO usage_confirmations VALUES (?, 'confirmed', 0.04, 1, '2026-07-02T00:00:00.000Z', NULL)").run(first!.id);
    db.prepare("INSERT INTO usage_confirmations VALUES (?, 'pending', NULL, 1, '2026-07-02T00:00:00.000Z', NULL)").run(second!.id);
    writeUsageCsvReports(db, dir);
    const events = lines('usage-events.csv');
    expect(events[1]!.endsWith(',confirmed,0.04')).toBe(true);
    expect(events[2]!.endsWith(',pending,')).toBe(true);
    expect(lines('usage-daily.csv')[1]!.endsWith(`,0.04,1,${first!.cost_usd}`)).toBe(true);
    expect(lines('usage-monthly.csv')[1]!.endsWith(`,0.04,1,${first!.cost_usd}`)).toBe(true);
    expect(second!.cost_usd).toBe(first!.cost_usd);
  });
});

const insertConversation = (id: string, title: string): void => {
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')",
  ).run(id, title);
};

describe('writeUsageCsvReports — usage-by-conversation.csv', () => {
  it('joins titles, keeps rows for deleted conversations, sorts cost DESC, excludes null ids', () => {
    insertConversation('conv-A', 'Weekly planning');
    // conv-B has no conversations row — simulates a deleted conversation.
    rec.recordOrThrow({ ts: '2026-07-01T10:00:00.000Z', provider: 'exa', service: 'chat-web', purpose: 'web-search', providerCostUsd: 1, conversationId: 'conv-A' });
    rec.recordOrThrow({ ts: '2026-07-01T12:00:00.000Z', provider: 'exa', service: 'chat-web', purpose: 'web-search', providerCostUsd: 2, conversationId: 'conv-A' });
    rec.recordOrThrow({ ts: '2026-07-02T09:00:00.000Z', provider: 'exa', service: 'chat-web', purpose: 'web-search', providerCostUsd: 5, conversationId: 'conv-B' });
    rec.recordOrThrow({ ts: '2026-07-02T10:00:00.000Z', provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 9 }); // no conversation — excluded

    writeUsageCsvReports(db, dir);
    const rows = lines('usage-by-conversation.csv');
    expect(rows[0]).toBe(
      'conversation_id,title,events,first_ts,last_ts,input_tokens,output_tokens,'
      + 'cache_read_tokens,cache_write_tokens,audio_seconds,cost_usd');
    expect(rows[1]).toBe('conv-B,,1,2026-07-02T09:00:00.000Z,2026-07-02T09:00:00.000Z,0,0,0,0,0,5');
    expect(rows[2]).toBe('conv-A,Weekly planning,2,2026-07-01T10:00:00.000Z,2026-07-01T12:00:00.000Z,0,0,0,0,0,3');
    expect(rows).toHaveLength(3);
  });

  it('escapes a title containing comma, quote, and newline', () => {
    insertConversation('conv-C', 'a,"b"\nc');
    rec.recordOrThrow({ ts: '2026-07-01T10:00:00.000Z', provider: 'exa', service: 'chat-web', purpose: 'web-search', providerCostUsd: 1, conversationId: 'conv-C' });
    writeUsageCsvReports(db, dir);
    const text = readFileSync(join(dir, 'usage-by-conversation.csv'), 'utf8');
    expect(text).toContain('conv-C,"a,""b""\nc",1,');
  });
});

describe('writeUsageCsvReports — usage-by-run.csv', () => {
  it('one row per run_ref with sorted distinct purposes, started/ended, cost DESC; null run_ref excluded', () => {
    // Run 1: an org-sweep with two purposes recorded out of alphabetical order.
    rec.recordOrThrow({ ts: '2026-07-01T05:00:00.000Z', provider: 'exa', service: 'curator', purpose: 'web-search', providerCostUsd: 1, runRef: 'run-1', sourceRef: 'Vault Engine' });
    rec.recordOrThrow({ ts: '2026-07-01T05:10:00.000Z', provider: 'exa', service: 'curator', purpose: 'org-sweep', providerCostUsd: 1, runRef: 'run-1', sourceRef: 'Vault Engine' });
    // Run 2: single event, higher total cost — must rank first.
    rec.recordOrThrow({ ts: '2026-07-02T05:00:00.000Z', provider: 'exa', service: 'curator', purpose: 'memory-sweep', providerCostUsd: 7, runRef: 'run-2', sourceRef: 'memory-sweep' });
    // No run_ref — excluded.
    rec.recordOrThrow({ ts: '2026-07-02T06:00:00.000Z', provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 9 });

    writeUsageCsvReports(db, dir);
    const rows = lines('usage-by-run.csv');
    expect(rows[0]).toBe(
      'run_ref,source_ref,purposes,started,ended,events,input_tokens,output_tokens,'
      + 'cache_read_tokens,cache_write_tokens,audio_seconds,cost_usd');
    expect(rows[1]).toBe('run-2,memory-sweep,memory-sweep,2026-07-02T05:00:00.000Z,2026-07-02T05:00:00.000Z,1,0,0,0,0,0,7');
    // purposes sorted alphabetically: org-sweep before web-search; the pair is one quoted cell.
    expect(rows[2]).toBe('run-1,Vault Engine,"org-sweep,web-search",2026-07-01T05:00:00.000Z,2026-07-01T05:10:00.000Z,2,0,0,0,0,0,2');
    expect(rows).toHaveLength(3);
  });
});

describe('startUsageCsvReports', () => {
  const event = {
    provider: 'exa', service: 'engine', purpose: 'web-search', providerCostUsd: 1,
  } as const;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes all reports including the Curator sweep breakdown immediately at boot', () => {
    const handle = startUsageCsvReports({ db, recorder: rec, reportsDir: dir });
    expect(readdirSync(dir).sort()).toEqual([
      'usage-by-conversation.csv', 'usage-by-run.csv', 'usage-curator-sweeps.csv', 'usage-daily.csv',
      'usage-events.csv', 'usage-monthly.csv', 'usage-openrouter-reconciliation.csv',
    ]);
    handle.stop();
  });

  it('rewrites after changed() for ledger changes that bypass the recorder (#329)', () => {
    rec.record(event);
    const handle = startUsageCsvReports({ db, recorder: rec, reportsDir: dir });
    const id = (db.prepare('SELECT id FROM usage_events').get() as { id: number }).id;
    db.prepare("INSERT INTO usage_confirmations VALUES (?, 'confirmed', 0.5, 1, '2026-07-02T00:00:00.000Z', NULL)").run(id);
    handle.changed();
    expect(lines('usage-events.csv')[1]!.endsWith(',confirmed,0.5')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(lines('usage-events.csv')[1]!.endsWith(',confirmed,0.5')).toBe(true);
    handle.stop();
  });

  it('debounces: many events in one window produce one write containing all of them', () => {
    const handle = startUsageCsvReports({ db, recorder: rec, reportsDir: dir });
    for (let i = 0; i < 6; i += 1) rec.record(event);
    // Nothing rewritten yet — still the boot-time header-only file:
    expect(lines('usage-events.csv')).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(lines('usage-events.csv')).toHaveLength(7); // header + all 6 events, one write
    handle.stop();
  });

  it('re-arms after a fired write (an event after the window triggers a fresh one)', () => {
    const handle = startUsageCsvReports({ db, recorder: rec, reportsDir: dir });
    rec.record(event);
    vi.advanceTimersByTime(60_000);
    expect(lines('usage-events.csv')).toHaveLength(2);
    rec.record(event);
    vi.advanceTimersByTime(60_000);
    expect(lines('usage-events.csv')).toHaveLength(3);
    handle.stop();
  });

  it('stop() with a pending timer flushes a final write; idle stop() writes nothing', () => {
    const handle = startUsageCsvReports({ db, recorder: rec, reportsDir: dir });
    rec.record(event);
    handle.stop(); // timer pending → flush now, without advancing time
    expect(lines('usage-events.csv')).toHaveLength(2);

    // Idle stop: fresh instance, no events after boot; delete the dir and
    // verify stop() does not recreate it.
    const dir2 = mkdtempSync(join(tmpdir(), 'vault-csv-reports-'));
    const handle2 = startUsageCsvReports({ db, recorder: rec, reportsDir: dir2 });
    rmSync(dir2, { recursive: true, force: true });
    handle2.stop();
    expect(existsSync(dir2)).toBe(false);
  });

  it('a write failure warns and never throws into the record path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A reportsDir path that collides with an existing FILE makes mkdirSync throw:
    const fileAsDir = join(dir, 'not-a-dir');
    writeFileSync(fileAsDir, 'x');
    const handle = startUsageCsvReports({ db, recorder: rec, reportsDir: fileAsDir });
    expect(warn).toHaveBeenCalled(); // boot write already failed loudly
    expect(() => rec.record(event)).not.toThrow();
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    handle.stop();
    warn.mockRestore();
  });
});
