import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import {
  insertJournalEvent, unjournaledEvents, eventsForRunRefs, stampJournaled,
  type JournalEventInsert,
} from '../src/db/journal.js';

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d);
  return d;
}

function event(overrides: Partial<JournalEventInsert> = {}): JournalEventInsert {
  return {
    ts: '2026-07-13T05:00:00.000Z', run_ref: 'r1', trigger: 'scheduled',
    function: 'org-sweep', kind: 'action', action: 'typed',
    node_id: 'n1', target: 'Some Note', detail: 'typed "Some Note" → recipe', dry_run: 0,
    ...overrides,
  };
}

describe('journal_events (migration #7)', () => {
  it('creates the table and round-trips one event', () => {
    const d = db();
    expect(d.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(7);
    insertJournalEvent(d, event());
    const rows = unjournaledEvents(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_ref: 'r1', action: 'typed', journaled_at: null });
    expect(rows[0]!.id).toBeGreaterThan(0);
  });

  it('unjournaledEvents excludes dry-run and already-journaled rows, ordered by id', () => {
    const d = db();
    insertJournalEvent(d, event({ detail: 'first' }));
    insertJournalEvent(d, event({ detail: 'dry', dry_run: 1 }));
    insertJournalEvent(d, event({ detail: 'second' }));
    stampJournaled(d, [1], '2026-07-13T05:01:00.000Z');
    const rows = unjournaledEvents(d);
    expect(rows.map(r => r.detail)).toEqual(['second']);
  });

  it('eventsForRunRefs selects only the named refs (still excluding dry-run/journaled)', () => {
    const d = db();
    insertJournalEvent(d, event({ run_ref: 'a', detail: 'a1' }));
    insertJournalEvent(d, event({ run_ref: 'b', detail: 'b1' }));
    insertJournalEvent(d, event({ run_ref: null, detail: 'orphan' }));
    expect(eventsForRunRefs(d, ['a']).map(r => r.detail)).toEqual(['a1']);
    expect(eventsForRunRefs(d, [])).toEqual([]);
  });

  it('stampJournaled sets journaled_at on exactly the given ids', () => {
    const d = db();
    insertJournalEvent(d, event({ detail: 'x' }));
    insertJournalEvent(d, event({ detail: 'y' }));
    stampJournaled(d, [2], '2026-07-13T06:00:00.000Z');
    expect(unjournaledEvents(d).map(r => r.detail)).toEqual(['x']);
  });
});
