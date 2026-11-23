import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import {
  setPaused, isPaused, pausedWikis,
  addCorrection, activeCorrections, allActiveCorrections, resolveCorrection, controlState,
} from '../src/db/control.js';

function db() { const d = new Database(':memory:'); runMigrations(d); return d; }

describe('wiki_control — pause', () => {
  it('round-trips paused state and upserts on toggle', () => {
    const d = db();
    expect(isPaused(d, 'A')).toBe(false);
    setPaused(d, 'A', true, 'tester', '2026-06-26T00:00:00Z');
    expect(isPaused(d, 'A')).toBe(true);
    expect(pausedWikis(d).map(r => r.project_title)).toEqual(['A']);
    setPaused(d, 'A', false, 'tester', '2026-06-26T01:00:00Z');
    expect(isPaused(d, 'A')).toBe(false);
    expect(pausedWikis(d)).toEqual([]);
    d.close();
  });
});

describe('wiki_corrections — standing notes', () => {
  it('adds, lists active in id order, and resolves', () => {
    const d = db();
    const id1 = addCorrection(d, { project_title: 'A', note: 'stop tracking X', created_by: 'tester', created_at: '2026-06-26T00:00:00Z' });
    addCorrection(d, { project_title: 'A', note: 'lodging is booked', created_by: null, created_at: '2026-06-26T00:01:00Z' });
    addCorrection(d, { project_title: 'B', note: 'other wiki', created_by: null, created_at: '2026-06-26T00:02:00Z' });
    expect(activeCorrections(d, 'A').map(c => c.note)).toEqual(['stop tracking X', 'lodging is booked']);
    expect(allActiveCorrections(d)).toHaveLength(3);

    expect(resolveCorrection(d, id1, '2026-06-26T02:00:00Z')).toBe(true);
    expect(resolveCorrection(d, id1, '2026-06-26T02:00:00Z')).toBe(false); // already resolved
    expect(resolveCorrection(d, 9999, '2026-06-26T02:00:00Z')).toBe(false); // unknown id
    expect(activeCorrections(d, 'A').map(c => c.note)).toEqual(['lodging is booked']);
    d.close();
  });

  it('controlState reflects paused + active corrections', () => {
    const d = db();
    setPaused(d, 'A', true, 'tester', '2026-06-26T00:00:00Z');
    const cid = addCorrection(d, { project_title: 'A', note: 'note', created_by: null, created_at: '2026-06-26T00:00:00Z' });
    const state = controlState(d, 'A');
    expect(state).toEqual({
      project: 'A', paused: true,
      corrections: [{ id: cid, note: 'note', created_at: '2026-06-26T00:00:00Z' }],
    });
    d.close();
  });
});
