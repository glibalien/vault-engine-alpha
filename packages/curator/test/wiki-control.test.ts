import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { addCorrection, isPaused, activeCorrections } from '../src/db/control.js';
import {
  makeSetWikiPausedHandler, makeAddWikiCorrectionHandler, makeResolveWikiCorrectionHandler,
} from '../src/tools/wiki-control.js';

const trig = { authInfo: { scopes: ['curate:trigger'], clientId: 'tester' } };
function deps(db: Database.Database) {
  return { engine: {} as never, llm: {} as never, config: {} as never, queue: {} as never, db } as never;
}

describe('set-wiki-paused', () => {
  it('pauses then resumes, returning the control state, and enforces scope', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const h = makeSetWikiPausedHandler(deps(db));
    const res = await h({ project: 'Demo', paused: true }, trig);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.ok).toBe(true);
    expect(body.paused).toBe(true);
    expect(isPaused(db, 'Demo')).toBe(true);

    await h({ project: 'Demo', paused: false }, trig);
    expect(isPaused(db, 'Demo')).toBe(false);

    const denied = await h({ project: 'Demo', paused: true }, { authInfo: { scopes: [] } });
    expect(denied.isError).toBe(true);
    expect(isPaused(db, 'Demo')).toBe(false); // scope guard ran before the write
    db.close();
  });
});

describe('set-wiki-paused and the home status (#547)', () => {
  it('writes paused to the wiki home and returns the status it now has', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const writes: Array<{ root: string; status?: string }> = [];
    let status = 'current';
    const engine = {
      wikiStatus: async (root: string, next?: string) => {
        writes.push({ root, ...(next === undefined ? {} : { status: next }) });
        if (next !== undefined) status = next;
        return { root_id: root, home_node_id: 'home', status, version: 1, written: next !== undefined };
      },
    };
    const h = makeSetWikiPausedHandler({ engine, llm: {}, config: {}, queue: {}, db } as never);

    const body = JSON.parse((await h({ project: 'Demo', paused: true }, trig)).content[0]!.text);

    expect(body).toMatchObject({ ok: true, paused: true, wiki_status: 'paused' });
    expect(writes).toEqual([{ root: 'Demo' }, { root: 'Demo', status: 'paused' }]);
    db.close();
  });
});

describe('add + resolve correction', () => {
  it('adds a correction and returns it with an id', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const res = await makeAddWikiCorrectionHandler(deps(db))({ project: 'Demo', note: 'stop tracking X' }, trig);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.ok).toBe(true);
    expect(body.corrections).toHaveLength(1);
    expect(body.corrections[0].note).toBe('stop tracking X');
    expect(typeof body.corrections[0].id).toBe('number');
    db.close();
  });

  it('resolves a correction and drops it from active', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const id = addCorrection(db, { project_title: 'Demo', note: 'x', created_by: null, created_at: '2026-06-26T00:00:00Z' });
    const res = await makeResolveWikiCorrectionHandler(deps(db))({ project: 'Demo', correction_id: id }, trig);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.ok).toBe(true);
    expect(body.corrections).toHaveLength(0);
    expect(activeCorrections(db, 'Demo')).toHaveLength(0);
    db.close();
  });

  it('returns NOT_FOUND on an unknown correction id', async () => {
    const db = new Database(':memory:'); runMigrations(db);
    const res = await makeResolveWikiCorrectionHandler(deps(db))({ project: 'Demo', correction_id: 999 }, trig);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('NOT_FOUND');
    db.close();
  });
});
