import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { unjournaledEvents } from '../src/db/journal.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { renderBody } from '../src/journal/render.js';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, recorder: new ActionRecorder(db) };
}

describe('ActionRecorder', () => {
  it('stamps the run context onto recorded actions', () => {
    const { db, recorder } = setup();
    recorder.setContext({ runRef: 'r1', trigger: 'scheduled', fn: 'org-sweep' });
    recorder.record({ action: 'typed', nodeId: 'n1', target: 'X', detail: 'typed "X" → recipe' });
    recorder.setContext(null);
    const [row] = unjournaledEvents(db);
    expect(row).toMatchObject({
      run_ref: 'r1', trigger: 'scheduled', function: 'org-sweep',
      kind: 'action', action: 'typed', node_id: 'n1', target: 'X', dry_run: 0,
    });
  });

  it('persists a null-context action AND warns (never a silent drop)', () => {
    const { db, recorder } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recorder.record({ action: 'fields-updated', detail: 'set status=backlog' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no run context'));
    warn.mockRestore();
    const [row] = unjournaledEvents(db);
    expect(row).toMatchObject({ run_ref: null, trigger: null, function: 'unknown' });
  });

  it('summary rows carry {line, stats} JSON in detail', () => {
    const { db, recorder } = setup();
    recorder.setContext({ runRef: 'r2', trigger: 'cli', fn: 'memory-sweep' });
    recorder.summary('memory-sweep', '3 written, 1 duplicate', { written: 3, errors: 0 }, false);
    const [row] = unjournaledEvents(db);
    expect(row).toMatchObject({ kind: 'summary', action: null, function: 'memory-sweep', run_ref: 'r2' });
    expect(JSON.parse(row!.detail)).toEqual({ line: '3 written, 1 duplicate', stats: { written: 3, errors: 0 } });
  });

  it('suspend() disables recording for the wrapped work, then restores it', async () => {
    const { db, recorder } = setup();
    recorder.setContext({ runRef: 'r3', trigger: 'scheduled', fn: 'wiki-curation' });
    await recorder.suspend(async () => {
      recorder.record({ action: 'node-created', detail: 'created journal note' });
    });
    recorder.record({ action: 'wiki-written', detail: 'updated wiki home' });
    expect(unjournaledEvents(db).map(r => r.action)).toEqual(['wiki-written']);
  });

  it('a DB insert failure warns and never throws', () => {
    const { db, recorder } = setup();
    db.close(); // force the insert to fail
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => recorder.record({ action: 'typed', detail: 'x' })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps journal insertion warnings static when SQLite returns sensitive text', () => {
    const marker = 'SECRET-JOURNAL-TRIGGER-DETAIL';
    const { db, recorder } = setup();
    db.exec(`
      CREATE TRIGGER reject_sensitive_journal BEFORE INSERT ON journal_events
      BEGIN SELECT RAISE(ABORT, '${marker}'); END;
    `);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => recorder.summary('field-guess-sweep', 'bounded', { errors: 1 }, false)).not.toThrow();

    expect(warn).toHaveBeenCalledWith('[curator] journal event not recorded');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
  });

  it('records and renders the dedicated field-guess sweep function label', () => {
    const { db, recorder } = setup();
    recorder.setContext({
      runRef: 'field-run',
      trigger: 'scheduled',
      fn: 'field-guess-sweep',
      project: 'Project One',
    });
    recorder.record({ action: 'field-guessed', detail: 'guessed status=active on "Project One"' });

    expect(renderBody(unjournaledEvents(db)).body).toBe(
      '**Field guessing**\n- guessed status=active on "Project One"',
    );
  });
});
