import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { registerWikiRoot, getWikiRoot, wikiRootExists, topicWikiRoots, deleteWikiRoot } from '../src/db/wiki-roots.js';

function db() { const d = new Database(':memory:'); runMigrations(d); return d; }
const row = (over: Record<string, unknown> = {}) => ({
  root_title: 'The 2026 Metro Owls', root_node_id: 'n1', kind: 'topic', source: 'vault',
  cadence: null, brief: 'the topic this season', created_at: '2026-06-26T00:00:00Z', created_by: 'tester', ...over,
});

describe('wiki_roots registry', () => {
  it('registers, reads, and lists topic roots', () => {
    const d = db();
    expect(wikiRootExists(d, 'The 2026 Metro Owls')).toBe(false);
    registerWikiRoot(d, row());
    expect(wikiRootExists(d, 'The 2026 Metro Owls')).toBe(true);
    const got = getWikiRoot(d, 'The 2026 Metro Owls');
    expect(got).toMatchObject({ root_node_id: 'n1', kind: 'topic', source: 'vault', brief: 'the topic this season' });
    expect(topicWikiRoots(d).map(r => r.root_title)).toEqual(['The 2026 Metro Owls']);
    d.close();
  });

  it('re-register is idempotent (upsert root_node_id + brief, no duplicate)', () => {
    const d = db();
    registerWikiRoot(d, row({ root_node_id: null, brief: null }));
    registerWikiRoot(d, row({ root_node_id: 'n2', brief: 'updated' }));
    expect(topicWikiRoots(d)).toHaveLength(1);
    expect(getWikiRoot(d, 'The 2026 Metro Owls')).toMatchObject({ root_node_id: 'n2', brief: 'updated' });
    d.close();
  });

  it('topicWikiRoots returns only kind=topic', () => {
    const d = db();
    registerWikiRoot(d, row());
    registerWikiRoot(d, row({ root_title: 'Some Project', kind: 'project' }));
    expect(topicWikiRoots(d).map(r => r.root_title)).toEqual(['The 2026 Metro Owls']);
    d.close();
  });

  it('deleteWikiRoot deregisters the root and reports whether a row went away', () => {
    const d = db();
    registerWikiRoot(d, row());
    registerWikiRoot(d, row({ root_title: 'Keep Me' }));
    expect(deleteWikiRoot(d, 'The 2026 Metro Owls')).toBe(true);
    expect(wikiRootExists(d, 'The 2026 Metro Owls')).toBe(false);
    expect(topicWikiRoots(d).map(r => r.root_title)).toEqual(['Keep Me']);
    expect(deleteWikiRoot(d, 'The 2026 Metro Owls')).toBe(false);   // already gone
    expect(deleteWikiRoot(d, 'Never Registered')).toBe(false);
    d.close();
  });

  it('round-trips cadence and upserts source + cadence', () => {
    const d = db();
    registerWikiRoot(d, row({ source: 'vault+web', cadence: '24h' }));
    expect(getWikiRoot(d, 'The 2026 Metro Owls')).toMatchObject({ source: 'vault+web', cadence: '24h' });
    registerWikiRoot(d, row({ source: 'vault', cadence: null }));     // re-register downgrades
    expect(getWikiRoot(d, 'The 2026 Metro Owls')).toMatchObject({ source: 'vault', cadence: null });
    d.close();
  });
});
