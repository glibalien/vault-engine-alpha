import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Engine, type EngineClientFactory, type WikiReconcileInput } from '../src/engine.js';
import type { Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { unjournaledEvents } from '../src/db/journal.js';
import { ActionRecorder } from '../src/journal/recorder.js';

const config = {
  engineUrl: 'http://localhost:3334', engineToken: 't',
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
} as Config;

function factoryReturning(data: unknown): EngineClientFactory {
  return () => ({
    transport: { close: async () => {} },
    client: {
      connect: async () => {},
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] }),
    },
  });
}

function setup(data: unknown) {
  const db = new Database(':memory:');
  runMigrations(db);
  const recorder = new ActionRecorder(db);
  recorder.setContext({ runRef: 'r1', trigger: 'scheduled', fn: 'wiki-curation' });
  const engine = new Engine(config, factoryReturning(data));
  engine.setRecorder(recorder);
  return { db, engine, recorder };
}

describe('Engine → journal recording', () => {
  it('wikiWrite records a wiki-written action with the dry-run flag', async () => {
    const { db, engine } = setup({ node_id: 'w1', created: false });
    await engine.wikiWrite('Proj', { now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l' } as never, true);
    const [row] = unjournaledEvents(db).concat(
      db.prepare('SELECT * FROM journal_events WHERE dry_run = 1').all() as never[],
    );
    expect(row).toMatchObject({ action: 'wiki-written', target: 'Proj', node_id: 'w1', dry_run: 1 });
  });

  it('addTypeToNode records `typed` with the human title when given', async () => {
    const { db, engine } = setup({});
    await engine.addTypeToNode('n9', 'recipe', 3, 'Miso Glazed Salmon');
    expect(unjournaledEvents(db)[0]).toMatchObject({
      action: 'typed', node_id: 'n9', target: 'Miso Glazed Salmon',
      detail: 'typed "Miso Glazed Salmon" → recipe',
    });
  });

  it('moveNode records `moved`', async () => {
    const { db, engine } = setup({});
    await engine.moveNode('n2', 'Kettlebell Log', 'Fitness', 4);
    expect(unjournaledEvents(db)[0]).toMatchObject({
      action: 'moved', detail: 'moved "Kettlebell Log" → Fitness/',
    });
  });

  it('updateNodeFields is silent for pure wiki-stamp patches, records otherwise', async () => {
    const { db, engine } = setup({});
    await engine.updateNodeFields('n3', {
      wiki_state: 'active', wiki_kind: 'theme', wiki_origin: 'automatic', wiki_scope: '{}',
      wiki_replaced_by: 'Target', wiki_pinned: false, wiki_evidence_hash: 'evidence',
      wiki_curated_at: '2026-08-14T12:00:00.000Z', wiki_topology_hash: 'topology',
      wiki_reconcile_key: 'reconcile',
    });
    expect(unjournaledEvents(db)).toHaveLength(0);
    await engine.updateNodeFields('n3', { status: 'backlog' }, 'Old Project');
    expect(unjournaledEvents(db)[0]).toMatchObject({
      action: 'fields-updated', target: 'Old Project', detail: 'set status=backlog on "Old Project"',
    });
  });

  it('createMemory, createNode, and retireThemedPage each record', async () => {
    const { db, engine } = setup({ id: 1, node_id: 'x', file_path: 'p', created: true });
    await engine.createMemory({ source: 'curator', scope: 'vault', content: 'Avery prefers tea over coffee.' });
    await engine.createNode({ title: 'T', types: ['note'] });
    await engine.retireThemedPage('Proj', 'Proj — Old Theme', 'retired', 'stale', false);
    expect(unjournaledEvents(db).map(r => r.action)).toEqual(
      ['memory-created', 'node-created', 'page-retired'],
    );
  });

  it('records nothing when no recorder is set (and does not throw)', async () => {
    const engine = new Engine(config, factoryReturning({}));
    await expect(engine.addTypeToNode('n1', 'note')).resolves.toBeUndefined();
  });

  it('records one bounded reconciliation summary and leaves topology details to core', async () => {
    const { db, engine } = setup({
      operation_id: 'operation-1', reconcile_key: 'key-1', plan_digest: 'digest-1', reused: false, dry_run: false,
      created: [{ node_id: 'new', title: 'New', file_path: 'Wikis/New.md', version: 1 }],
      updated: [{ node_id: 'target', title: 'Target', file_path: 'Wikis/Target.md', version: 2 }],
      mappings: [{ source_node_id: 'source', target_node_id: 'target', target_title: 'Target' }],
      home: { node_id: 'home', title: 'Demo Wiki', file_path: 'Wikis/Demo Wiki.md', version: 2, created: false },
      topology_hash: 'topology-2', warnings: [], preview: { total: 2, items: [], truncated: false },
    });
    const request: WikiReconcileInput = {
      project: 'Demo', reconcile_key: 'key-1', dry_run: false,
      pages: [{ op: 'retire', node_id: 'old', expected_version: 3, scope: { v: 1, subject: 'Demo', facet: 'old' }, state: 'retired', reason: 'Concluded.' }],
      home: { sections: [], evidence_hash: 'evidence', curated_at: '2026-08-14T12:00:00.000Z', refresh_live: true },
    };

    await engine.wikiReconcile(request);

    const events = unjournaledEvents(db);
    expect(events.map(event => event.action)).toEqual(['wiki-reconciled']);
    expect(events[0]?.detail).toContain('key=key-1: 1 created, 1 updated, 1 merged, 1 retired');
    expect(events.map(event => event.detail).join('\n')).not.toContain('delet');
  });
});
