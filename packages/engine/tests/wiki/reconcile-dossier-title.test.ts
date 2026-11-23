import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { fetchExistingWiki } from '../../src/wiki/digest.js';
import { validateWikiReconcilePlan } from '../../src/wiki/reconcile-plan.js';
import { executeWikiReconcile, type WikiReconcileDeps } from '../../src/wiki/reconcile.js';
import type { WikiReconcileInput } from '../../src/wiki/reconcile-types.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { loadWikiNodeFields } from '../../src/wiki/write-helpers.js';
import { wikiReconcileInputShape } from '../../src/mcp/tools/wiki-reconcile.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';

// A dossier (#554) is a wiki home whose root is a person's or a company's note. The Curator asks
// for its name with home.title_suffix; everything else about the home is a wiki home's.

let db: Database.Database;
let vault: ReturnType<typeof createTempVault>;
let writeLock: WriteLockManager;
let personId: string;

beforeEach(() => {
  db = createTestDb();
  vault = createTempVault();
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('person', 'Person', '[]')").run();
  personId = executeMutation(db, writeLock, vault.vaultPath, {
    source: 'tool', node_id: null, file_path: 'People/Dana Whitfield.md', title: 'Dana Whitfield',
    types: ['person'], fields: {}, body: 'Account lead at Northwind.',
  }).node_id;
  ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
});

afterEach(() => {
  db.close();
  vault.cleanup();
});

function deps(): WikiReconcileDeps {
  return { db, config: DEFAULT_WIKI_CONFIG, writeLock, vaultPath: vault.vaultPath };
}

function plan(key: string, home: Partial<WikiReconcileInput['home']> = {}) {
  const existing = fetchExistingWiki(db, personId, DEFAULT_WIKI_CONFIG).home;
  const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, {
    project: personId, project_id: personId, reconcile_key: key, pages: [],
    home: {
      ...(existing ? { expected_version: existing.version } : {}),
      sections: [{ name: 'At a glance', mode: 'replace', content: '## Who\n\n- Account lead at Northwind.' }],
      evidence_hash: 'evidence-1', curated_at: '2026-11-20T12:00:00.000Z', refresh_live: true, ...home,
    },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

describe('wiki-reconcile home.title_suffix (#554)', () => {
  it('names a new home "<root> Dossier", in a preview and in the write', async () => {
    const preview = await executeWikiReconcile(deps(), plan('dossier-1', { title_suffix: 'Dossier' }), { dryRun: true });
    expect(preview.home).toMatchObject({ title: 'Dana Whitfield Dossier', file_path: 'Wikis/Dana Whitfield Dossier.md', created: true });

    const written = await executeWikiReconcile(deps(), plan('dossier-1', { title_suffix: 'Dossier' }), { dryRun: false });
    expect(written.home).toMatchObject({ title: 'Dana Whitfield Dossier', file_path: 'Wikis/Dana Whitfield Dossier.md', created: true });
    const home = written.home.node_id!;
    expect(db.prepare('SELECT title FROM nodes WHERE id = ?').get(home)).toEqual({ title: 'Dana Whitfield Dossier' });
    expect(loadWikiNodeFields(db, home).wiki_for).toBe('People/Dana Whitfield.md');
    // The home is found again by its root, as any wiki home is.
    expect(fetchExistingWiki(db, personId, DEFAULT_WIKI_CONFIG).home_id).toBe(home);
  });

  it('keeps an existing home\'s title and path on a rebuild, with or without the option', async () => {
    const first = await executeWikiReconcile(deps(), plan('dossier-1', { title_suffix: 'Dossier' }), { dryRun: false });
    const again = await executeWikiReconcile(deps(), plan('dossier-2', { title_suffix: 'Dossier' }), { dryRun: false });
    expect(again.home).toMatchObject({ node_id: first.home.node_id, title: 'Dana Whitfield Dossier', created: false });
    const plain = await executeWikiReconcile(deps(), plan('dossier-3'), { dryRun: false });
    expect(plain.home).toMatchObject({ node_id: first.home.node_id, title: 'Dana Whitfield Dossier',
      file_path: 'Wikis/Dana Whitfield Dossier.md', created: false });
  });

  it('still names a new home "<root> Wiki" without it', async () => {
    const written = await executeWikiReconcile(deps(), plan('wiki-1'), { dryRun: false });
    expect(written.home).toMatchObject({ title: 'Dana Whitfield Wiki', file_path: 'Wikis/Dana Whitfield Wiki.md' });
  });

  it('is part of the plan digest only when set', () => {
    const without = plan('same-key');
    expect(plan('same-key').plan.plan_digest).toBe(without.plan.plan_digest);
    expect(plan('same-key', { title_suffix: 'Dossier' }).plan.plan_digest).not.toBe(without.plan.plan_digest);
  });

  it('accepts only "Dossier" over MCP', () => {
    const schema = z.object(wikiReconcileInputShape);
    const input = (home: Record<string, unknown>) => ({ project: 'Dana Whitfield', reconcile_key: 'k', pages: [],
      home: { sections: [], evidence_hash: 'h', curated_at: '2026-11-20T12:00:00.000Z', refresh_live: true, ...home } });
    expect(schema.safeParse(input({ title_suffix: 'Dossier' })).success).toBe(true);
    expect(schema.safeParse(input({})).success).toBe(true);
    expect(schema.safeParse(input({ title_suffix: 'Notes' })).success).toBe(false);
  });
});
