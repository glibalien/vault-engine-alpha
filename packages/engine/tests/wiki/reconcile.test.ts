// allow: SIZE_OK — integration contract matrix for the atomic reconciliation state machine.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { fetchExistingWiki } from '../../src/wiki/digest.js';
import { validateWikiReconcilePlan } from '../../src/wiki/reconcile-plan.js';
import type {
  WikiReconcileInput,
  WikiReconcileValidationResult,
} from '../../src/wiki/reconcile-types.js';
import {
  executeWikiReconcile,
  WikiReconcileRollbackIncompleteError,
  type WikiReconcileDeps,
} from '../../src/wiki/reconcile.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { projectEvidenceHash } from '../../src/wiki/evidence.js';
import { setWikiHomeStatus } from '../../src/wiki/status.js';
import { loadNodeState } from '../../src/pipeline/node-state.js';
import { mergeManagedSections, extractManagedSection } from '../../src/wiki/sections.js';
import { loadWikiNodeFields } from '../../src/wiki/write-helpers.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { createTestDb } from '../helpers/db.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { createTempVault } from '../helpers/vault.js';

const SCOPE = { v: 1, subject: 'Project', facet: 'Delivery' } as const;
const CURATED_AT = '2026-08-13T12:00:00.000Z';

let fixture: ReconcileFixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.db.close();
  fixture.cleanup();
});

describe('executeWikiReconcile page semantics', () => {
  it('rebinds legacy wiki_for to the canonical root path when writing a merge source', async () => {
    fixture.dispose();
    fixture = createOrchardFixture();
    const target = fixture.createPage('Orchard Pilot Project — Canonical', 'Target prose.');
    const source = fixture.createPage('Orchard Pilot Project — Source', sourceBody('Source prose.'));
    storeLegacyWikiFor(fixture.db, source.id, 'Orchard Pilot Project');
    const validated = fixture.validate([mergeExisting(target, source)]);

    await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    expectCanonicalOrchardRoot(fixture, source.id);
  });

  it('rebinds legacy wiki_for to the canonical root path when writing a replacement ancestor', async () => {
    fixture.dispose();
    fixture = createOrchardFixture();
    const target = fixture.createPage('Orchard Pilot Project — Canonical', 'Target prose.');
    const source = fixture.createPage('Orchard Pilot Project — Source', sourceBody('Source prose.'));
    const ancestor = fixture.createPage('Orchard Pilot Project — Ancestor', 'Ancestor prose.', {
      wiki_replaced_by: source.title,
    });
    storeLegacyWikiFor(fixture.db, ancestor.id, 'Orchard Pilot Project');
    const validated = fixture.validate([mergeExisting(target, source)]);

    await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    expectCanonicalOrchardRoot(fixture, ancestor.id);
  });

  it('rebinds legacy wiki_for to the canonical root path when writing a standalone retirement', async () => {
    fixture.dispose();
    fixture = createOrchardFixture();
    const page = fixture.createPage('Orchard Pilot Project — Retiring', 'Retiring prose.');
    storeLegacyWikiFor(fixture.db, page.id, 'Orchard Pilot Project');
    const validated = fixture.validate([retire(page, 'retired')]);

    await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    expectCanonicalOrchardRoot(fixture, page.id);
  });

  it('adopts a legacy page without rewriting its prose', async () => {
    // Given
    const legacy = fixture.createPage('Project — Legacy', 'Human prose only.', {
      wiki_state: 'active',
    });
    const validated = fixture.validate([upsertExisting(legacy)]);

    // When
    const result = await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    // Then
    expect(nodeBody(fixture.db, legacy.id)).toBe('Human prose only.');
    expect(loadWikiNodeFields(fixture.db, legacy.id)).toMatchObject({
      wiki_scope: JSON.stringify(SCOPE),
      wiki_kind: 'workstream',
      wiki_origin: 'automatic',
      wiki_pinned: false,
      wiki_state: 'active',
    });
    expect(result.updated.map(node => node.node_id)).toContain(legacy.id);
  });

  it('creates two distinct pages of the same kind in one batch', async () => {
    // Given
    const validated = fixture.validate([
      upsertNew('alpha', 'Project — Alpha'),
      upsertNew('beta', 'Project — Beta'),
    ]);

    // When
    const result = await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    // Then
    expect(result.created).toHaveLength(2);
    expect(new Set(result.created.map(node => node.node_id)).size).toBe(2);
    expect(result.created.map(node => node.title).sort()).toEqual(['Project — Alpha', 'Project — Beta']);
    expect(result).not.toHaveProperty('resolvedPageTargets');
    expect(result).not.toHaveProperty('provenance_receipts');
  });

  it('refreshes and reactivates an existing page while clearing its replacement', async () => {
    // Given
    const successor = fixture.createPage('Project — Successor', 'Successor body.');
    const current = fixture.createPage(
      'Project — Current',
      mergeManagedSections('Human intro.', {
        live: {},
        managed: [{ name: 'Summary', mode: 'replace', content: 'Old summary.' }],
      }).body,
      {
        wiki_state: 'dormant',
        wiki_replaced_by: successor.title,
      },
    );
    const validated = fixture.validate([{
      ...upsertExisting(current),
      sections: [{ name: 'Summary', mode: 'replace', content: 'Fresh summary.' }],
    }]);

    // When
    await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    // Then
    const fields = loadWikiNodeFields(fixture.db, current.id);
    expect(fields.wiki_state).toBe('active');
    expect(fields).not.toHaveProperty('wiki_replaced_by');
    expect(nodeBody(fixture.db, current.id)).toContain('Human intro.');
    expect(extractManagedSection(nodeBody(fixture.db, current.id), 'Summary', 500)).toBe('Fresh summary.');
  });

  it('standalone retirement preserves everything outside managed Status', async () => {
    // Given
    const original = mergeManagedSections('Human before.\n\nHuman after.', {
      live: {},
      managed: [
        { name: 'Summary', mode: 'replace', content: 'Keep this summary.' },
        { name: 'Status', mode: 'replace', content: 'Old status.' },
      ],
    }).body;
    const page = fixture.createPage('Project — Paused', original);
    const validated = fixture.validate([retire(page, 'dormant')]);

    // When
    await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    // Then
    const body = nodeBody(fixture.db, page.id);
    expect(body).toContain('Human before.');
    expect(body).toContain('Human after.');
    expect(extractManagedSection(body, 'Summary', 500)).toBe('Keep this summary.');
    expect(extractManagedSection(body, 'Status', 500)).toContain('run-1');
    expect(loadWikiNodeFields(fixture.db, page.id).wiki_state).toBe('dormant');
  });

  it('dates a retired page\'s Status with the build\'s day in the configured zone (#459)', async () => {
    // The build ran at 12:00 UTC on 13 August, already 14 August in Kiritimati (UTC+14).
    setStoredSettings(fixture.db, 'curator', { tz: 'Pacific/Kiritimati' });
    const page = fixture.createPage('Project — Paused', mergeManagedSections('Human prose.', {
      live: {}, managed: [{ name: 'Status', mode: 'replace', content: 'Old status.' }],
    }).body);
    const validated = fixture.validate([retire(page, 'dormant')]);

    await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    expect(extractManagedSection(nodeBody(fixture.db, page.id), 'Status', 500))
      .toBe('Dormant 2026-08-14 by reconciliation `run-1`: No longer current.');
  });

  it('merges into existing and new targets without losing source or target prose', async () => {
    // Given
    const target = fixture.createPage('Project — Existing Target', 'Target human prose.');
    const sourceA = fixture.createPage('Project — Source A', sourceBody('Source A human prose.'));
    const sourceB = fixture.createPage('Project — Source B', sourceBody('Source B human prose.'));
    const validated = fixture.validate([
      mergeExisting(target, sourceA),
      mergeNew('new-target', 'Project — New Target', sourceB),
    ]);

    // When
    const result = await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    // Then
    expect(nodeBody(fixture.db, target.id)).toContain('Target human prose.');
    expect(extractManagedSection(nodeBody(fixture.db, target.id), 'Summary', 500)).toBe('Consolidated summary.');
    for (const [source, human] of [
      [sourceA, 'Source A human prose.'],
      [sourceB, 'Source B human prose.'],
    ] as const) {
      const body = nodeBody(fixture.db, source.id);
      expect(body).toContain(human);
      expect(extractManagedSection(body, 'Summary', 500)).toBe('Original summary.');
      expect(extractManagedSection(body, 'Status', 500)).toContain('run-1');
    }
    expect(result.mappings).toHaveLength(2);
    expect(result.created.map(node => node.title)).toContain('Project — New Target');
  });

  it('transfers pin and requested origin across ancestors and path-compresses once', async () => {
    // Given
    const target = fixture.createPage('Project — Canonical', 'Canonical human prose.');
    const source = fixture.createPage('Project — Source', sourceBody('Source human prose.'));
    const ancestor = fixture.createPage('Project — Ancestor', 'Ancestor body.', {
      wiki_state: 'active',
      wiki_origin: 'requested',
      wiki_pinned: true,
      wiki_replaced_by: source.title,
    });
    const validated = fixture.validate([mergeExisting(target, source)]);

    // When
    const result = await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    // Then
    expect(loadWikiNodeFields(fixture.db, target.id)).toMatchObject({
      wiki_origin: 'requested',
      wiki_pinned: true,
    });
    expect(loadWikiNodeFields(fixture.db, ancestor.id)).toMatchObject({
      wiki_replaced_by: target.title,
      wiki_pinned: false,
      wiki_state: 'active',
    });
    expect(nodeBody(fixture.db, ancestor.id)).toBe('Ancestor body.');
    expect(extractManagedSection(nodeBody(fixture.db, target.id), 'Log', 2000)?.match(/run-1/g)).toHaveLength(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'STALE_ACTIVE_REPLACEMENT',
      node_id: ancestor.id,
    }));
  });
});

describe('executeWikiReconcile atomicity and convergence', () => {
  it('writes the canonical root path for new pages and home when the root title is duplicated', async () => {
    fixture.dispose();
    fixture = createFixture({
      projectTitle: 'Orchard Pilot Project',
      projectFilePath: 'Meetings/Orchard Pilot Project.md',
      duplicateProjectTitlePath: 'Wikis/Orchard Pilot Project.md',
    });
    const validated = fixture.validate([upsertNew('delivery', 'Orchard Pilot Project — Delivery')]);

    const result = await executeWikiReconcile(fixture.deps(), validated, { dryRun: false });

    const createdId = result.created[0]?.node_id;
    if (createdId === undefined) expect.fail('Expected a created reconciliation page');
    const homeId = result.home.node_id;
    if (homeId === null) expect.fail('Expected a reconciled home node');
    for (const nodeId of [createdId, homeId]) {
      expect(loadWikiNodeFields(fixture.db, nodeId).wiki_for).toBe('Meetings/Orchard Pilot Project.md');
      expect(fixture.db.prepare(`
        SELECT target, resolved_target_id FROM relationships
        WHERE source_id = ? AND rel_type = 'wiki_for'
      `).get(nodeId)).toEqual({
        target: 'Meetings/Orchard Pilot Project.md',
        resolved_target_id: fixture.project.id,
      });
    }
  });

  it('writes home last with the final catalog and stamps the actual topology hash', async () => {
    // Given
    const calls: Array<{ readonly title: string; readonly body: string }> = [];
    const mutate: NonNullable<WikiReconcileDeps['mutate']> = (...args) => {
      calls.push({ title: args[3].title, body: args[3].body });
      return executeMutation(...args);
    };
    const validated = fixture.validate([
      upsertNew('alpha', 'Project — Alpha'),
      upsertNew('beta', 'Project — Beta'),
    ]);

    // When
    const result = await executeWikiReconcile(fixture.deps({ mutate }), validated, { dryRun: false });

    // Then
    expect(calls.at(-1)?.title).toBe('Project Wiki');
    expect(calls.at(-1)?.body).toContain('Project — Alpha');
    expect(calls.at(-1)?.body).toContain('Project — Beta');
    const catalog = fetchExistingWiki(fixture.db, fixture.project.id, DEFAULT_WIKI_CONFIG);
    expect(result.topology_hash).toBe(catalog.topology_hash);
    expect(loadWikiNodeFields(fixture.db, fixture.home.id).wiki_topology_hash).toBe(catalog.topology_hash);
  });

  it('stamps wiki_status with the build and keeps the fingerprints out of the home file (#547)', async () => {
    const liveHash = projectEvidenceHash(fixture.db, { project: fixture.project.id, meeting_recent_limit: 10 });
    await executeWikiReconcile(fixture.deps(), validateHome({ evidence_hash: liveHash }), { dryRun: false });

    const fields = loadWikiNodeFields(fixture.db, fixture.home.id);
    expect(fields.wiki_status).toBe('current');
    expect(fields.wiki_evidence_hash).toBe(liveHash);
    const file = readFileSync(join(fixture.vaultPath, 'Wikis/Project Wiki.md'), 'utf-8');
    expect(file).toMatch(/^wiki_status: current$/mu);
    expect(file).not.toMatch(/wiki_evidence_hash|wiki_topology_hash|wiki_reconcile_key/);
  });

  it('stamps behind when the notes changed while the build ran (#547)', async () => {
    await executeWikiReconcile(fixture.deps(), validateHome({ evidence_hash: 'read-before-an-edit' }), { dryRun: false });

    expect(loadWikiNodeFields(fixture.db, fixture.home.id).wiki_status).toBe('behind');
  });

  it('stamps the status the Curator sends for a paused wiki\'s build (#547)', async () => {
    const liveHash = projectEvidenceHash(fixture.db, { project: fixture.project.id, meeting_recent_limit: 10 });
    await executeWikiReconcile(fixture.deps(), validateHome({ evidence_hash: liveHash, status: 'paused' }), { dryRun: false });
    expect(loadWikiNodeFields(fixture.db, fixture.home.id).wiki_status).toBe('paused');

    await executeWikiReconcile(fixture.deps(), validateHome({ evidence_hash: 'stale', status: 'paused' }, 'run-2'), { dryRun: false });
    expect(loadWikiNodeFields(fixture.db, fixture.home.id).wiki_status).toBe('paused-behind');
  });

  it('accepts a plan read before a status write, and refuses one read before an edit (#547)', async () => {
    const readAt = nodeVersion(fixture.db, fixture.home.id);
    setWikiHomeStatus({ db: fixture.db, writeLock: fixture.writeLock, vaultPath: fixture.vaultPath }, fixture.home.id, 'behind');
    expect(nodeVersion(fixture.db, fixture.home.id)).toBe(readAt + 1);

    await executeWikiReconcile(fixture.deps(), validateHome({ expected_version: readAt }), { dryRun: false });

    const afterBuild = nodeVersion(fixture.db, fixture.home.id);
    const state = loadNodeState(fixture.db, fixture.home.id)!;
    executeMutation(fixture.db, fixture.writeLock, fixture.vaultPath, {
      source: 'tool', node_id: fixture.home.id, file_path: state.file_path, title: state.title, types: state.types,
      fields: state.currentFields, body: `${state.body}\nA line typed by hand.\n`, canonicalizeLinks: false,
    });
    const refused = validateWikiReconcilePlan(fixture.db, DEFAULT_WIKI_CONFIG, {
      project: fixture.project.id, reconcile_key: 'run-after-edit', pages: [],
      home: { expected_version: afterBuild, sections: [], evidence_hash: 'e', curated_at: CURATED_AT, refresh_live: true },
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.issues.map(issue => issue.code)).toContain('HOME_EXPECTED_VERSION_MISMATCH');
  });

  it.each([0, 1, 2, 3])('restores DB and file bytes when mutation %i fails', async (failureIndex) => {
    // Given
    fixture.dispose();
    fixture = createFixture();
    const source = fixture.createPage('Project — Failure Source', sourceBody('Failure Source human prose.'));
    const retiring = fixture.createPage('Project — Failure Retire', 'Retire human prose.');
    const validated = fixture.validate([
      mergeNew('failure-target', 'Project — Failure Target', source),
      retire(retiring, 'retired'),
    ]);
    const beforeDb = databaseSnapshot(fixture.db);
    const beforeFiles = fileSnapshot(fixture.vaultPath);
    let mutationIndex = 0;
    const mutate: NonNullable<WikiReconcileDeps['mutate']> = (...args) => {
      if (mutationIndex++ === failureIndex) throw new InjectedMutationError(failureIndex);
      return executeMutation(...args);
    };

    // When
    const run = executeWikiReconcile(fixture.deps({ mutate }), validated, { dryRun: false });

    // Then
    await expect(run).rejects.toBeInstanceOf(InjectedMutationError);
    expect(databaseSnapshot(fixture.db)).toEqual(beforeDb);
    expect(fileSnapshot(fixture.vaultPath)).toEqual(beforeFiles);
  });

  it('throws rollback-incomplete with the operation ID when guarded restore is unsafe', async () => {
    // Given
    const source = fixture.createPage('Project — Rollback Source', sourceBody('Rollback Source human prose.'));
    const validated = fixture.validate([mergeNew('rollback-target', 'Project — Rollback Target', source)]);
    let mutationIndex = 0;
    let firstPath: string | null = null;
    const mutate: NonNullable<WikiReconcileDeps['mutate']> = (...args) => {
      if (mutationIndex++ === 1) {
        if (firstPath === null) throw new TestSetupError('first mutation path was not captured');
        writeFileSync(join(fixture.vaultPath, firstPath), 'external concurrent edit', 'utf8');
        throw new InjectedMutationError(1);
      }
      const result = executeMutation(...args);
      firstPath = result.file_path;
      return result;
    };

    // When
    let caught: unknown;
    try {
      await executeWikiReconcile(fixture.deps({ mutate }), validated, { dryRun: false });
    } catch (error) {
      caught = error;
    }

    // Then
    expect(caught).toBeInstanceOf(WikiReconcileRollbackIncompleteError);
    if (!(caught instanceof WikiReconcileRollbackIncompleteError)) expect.fail('Expected rollback-incomplete error');
    expect(caught.operationId).not.toBe('');
    expect(fixture.db.prepare('SELECT operation_id FROM undo_operations WHERE operation_id = ?').get(caught.operationId)).toBeDefined();
  });

  it('dry-run simulates the full plan with a bounded preview and no side effects', async () => {
    // Given
    const pages = Array.from({ length: 55 }, (_, index) => upsertNew(`page-${index}`, `Project — Preview ${index}`));
    const validated = fixture.validate(pages);
    const beforeDb = databaseSnapshot(fixture.db);
    const beforeFiles = fileSnapshot(fixture.vaultPath);
    let mutationCalls = 0;
    const mutate: NonNullable<WikiReconcileDeps['mutate']> = (...args) => {
      mutationCalls++;
      return executeMutation(...args);
    };

    // When
    const result = await executeWikiReconcile(fixture.deps({ mutate }), validated, { dryRun: true });

    // Then
    expect(result.dry_run).toBe(true);
    expect(result.operation_id).toBeNull();
    expect(result.preview.items).toHaveLength(50);
    expect(result.preview).toMatchObject({ total: 55, truncated: true });
    expect(mutationCalls).toBe(0);
    expect(fixture.embedded).toEqual([]);
    expect(databaseSnapshot(fixture.db)).toEqual(beforeDb);
    expect(fileSnapshot(fixture.vaultPath)).toEqual(beforeFiles);
  });

  it('same-key retry is byte- and version-identical and does not append logs', async () => {
    // Given
    const target = fixture.createPage('Project — Retry Target', 'Target prose.');
    const source = fixture.createPage('Project — Retry Source', sourceBody('Retry Source human prose.'));
    const firstValidation = fixture.validate([mergeExisting(target, source)]);
    await executeWikiReconcile(fixture.deps(), firstValidation, { dryRun: false });
    const catalog = fetchExistingWiki(fixture.db, fixture.project.id, DEFAULT_WIKI_CONFIG);
    const currentTarget = requiredPage(catalog.subpages, target.id);
    const currentSource = requiredPage(catalog.subpages, source.id);
    const retryValidation = fixture.validate([mergeExisting(currentTarget, currentSource)]);
    const beforeDb = databaseSnapshot(fixture.db);
    const beforeFiles = fileSnapshot(fixture.vaultPath);

    // When
    const result = await executeWikiReconcile(fixture.deps(), retryValidation, { dryRun: false });

    // Then
    expect(result.reused).toBe(true);
    expect(result.operation_id).toBeNull();
    expect(databaseSnapshot(fixture.db)).toEqual(beforeDb);
    expect(fileSnapshot(fixture.vaultPath)).toEqual(beforeFiles);
  });

  it('contains no node/file deletion path in reconciliation source', () => {
    // Given
    const source = readFileSync(new URL('../../src/wiki/reconcile.ts', import.meta.url), 'utf8');

    // When
    const forbidden = source.match(/delete-node|executeDeletion|deleteNode|\brm(?:Sync)?\b|\bunlink(?:Sync)?\b/u);

    // Then
    expect(forbidden).toBeNull();
  });
});

type NodeRef = {
  readonly id: string;
  readonly title: string;
  readonly version: number;
};

type ReconcileFixture = {
  readonly db: Database.Database;
  readonly vaultPath: string;
  readonly cleanup: () => void;
  readonly writeLock: WriteLockManager;
  readonly syncLogger: SyncLogger;
  readonly embedded: string[];
  readonly project: NodeRef;
  readonly home: NodeRef;
  readonly createPage: (
    title: string,
    body: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => NodeRef;
  readonly validate: (pages: WikiReconcileInput['pages']) => ValidatedPlan;
  readonly deps: (overrides?: Partial<WikiReconcileDeps>) => WikiReconcileDeps;
  readonly dispose: () => void;
};

type ValidatedPlan = Extract<WikiReconcileValidationResult, { readonly ok: true }>;

type FixtureOptions = {
  readonly projectTitle?: string;
  readonly projectFilePath?: string;
  readonly duplicateProjectTitlePath?: string;
};

function createFixture(options: FixtureOptions = {}): ReconcileFixture {
  const db = createTestDb();
  const vault = createTempVault();
  const writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  const syncLogger = new SyncLogger(db);
  const embedded: string[] = [];
  db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('project', 'Project', '[]')").run();
  const projectTitle = options.projectTitle ?? 'Project';
  const projectFilePath = options.projectFilePath ?? 'Project.md';
  const project = createNode(db, writeLock, vault.vaultPath, projectTitle, projectFilePath, ['project'], {}, 'Project body.');
  ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
  if (options.duplicateProjectTitlePath !== undefined) {
    createNode(
      db,
      writeLock,
      vault.vaultPath,
      projectTitle,
      options.duplicateProjectTitlePath,
      ['wiki'],
      {},
      'Unrelated duplicate-title page.',
    );
  }
  const projectTarget = options.projectFilePath === undefined ? project.title : projectFilePath;
  const homeTitle = `${project.title} Wiki`;
  const home = createNode(
    db,
    writeLock,
    vault.vaultPath,
    homeTitle,
    `Wikis/${homeTitle}.md`,
    ['wiki'],
    { wiki_for: projectTarget },
    'Home human prose.',
  );
  const createPage = (
    title: string,
    body: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): NodeRef => {
    const node = createNode(
      db,
      writeLock,
      vault.vaultPath,
      title,
      `Wikis/${title}.md`,
      ['wiki'],
      {
        wiki_for: projectTarget,
        wiki_parent: home.title,
        wiki_state: 'active',
        wiki_origin: 'automatic',
        wiki_pinned: false,
        wiki_kind: 'workstream',
        wiki_scope: JSON.stringify(SCOPE),
        ...fields,
      },
      body,
    );
    if (fields.wiki_pinned === true) {
      db.prepare(`
        UPDATE node_fields SET value_number = 1, value_json = NULL
        WHERE node_id = ? AND field_name = 'wiki_pinned'
      `).run(node.id);
    }
    return node;
  };
  const inputHome = (): WikiReconcileInput['home'] => ({
    expected_version: nodeVersion(db, home.id),
    sections: [{ name: 'Now', mode: 'replace', content: 'Current home state.' }],
    evidence_hash: 'evidence-1',
    curated_at: CURATED_AT,
    refresh_live: true,
  });
  const validate = (pages: WikiReconcileInput['pages']): ValidatedPlan => {
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, {
      project: project.id,
      reconcile_key: 'run-1',
      pages,
      home: inputHome(),
    });
    if (!result.ok) throw new TestSetupError(JSON.stringify(result.issues));
    return result;
  };
  const baseDeps: WikiReconcileDeps = {
    db,
    config: DEFAULT_WIKI_CONFIG,
    writeLock,
    vaultPath: vault.vaultPath,
    syncLogger,
    embeddingIndexer: {
      enqueue: item => embedded.push(item.node_id),
    },
  };
  return {
    db,
    vaultPath: vault.vaultPath,
    cleanup: vault.cleanup,
    writeLock,
    syncLogger,
    embedded,
    project,
    home,
    createPage,
    validate,
    deps: overrides => ({ ...baseDeps, ...overrides }),
    dispose: () => {
      db.close();
      vault.cleanup();
    },
  };
}

function createOrchardFixture(): ReconcileFixture {
  return createFixture({
    projectTitle: 'Orchard Pilot Project',
    projectFilePath: 'Meetings/Orchard Pilot Project.md',
    duplicateProjectTitlePath: 'Wikis/Orchard Pilot Project.md',
  });
}

/** A home-only plan for the current fixture (#547). */
function validateHome(home: Partial<WikiReconcileInput['home']>, reconcileKey = 'run-status'): ValidatedPlan {
  const result = validateWikiReconcilePlan(fixture.db, DEFAULT_WIKI_CONFIG, {
    project: fixture.project.id,
    reconcile_key: reconcileKey,
    pages: [],
    home: {
      expected_version: nodeVersion(fixture.db, fixture.home.id),
      sections: [{ name: 'Now', mode: 'replace', content: 'Current home state.' }],
      evidence_hash: 'evidence-1',
      curated_at: CURATED_AT,
      refresh_live: true,
      ...home,
    },
  });
  if (!result.ok) throw new TestSetupError(JSON.stringify(result.issues));
  return result;
}

function storeLegacyWikiFor(db: Database.Database, nodeId: string, title: string): void {
  const result = db.prepare(`
    UPDATE node_fields
    SET value_text = ?, value_number = NULL, value_date = NULL, value_json = NULL
    WHERE node_id = ? AND field_name = 'wiki_for'
  `).run(title, nodeId);
  if (result.changes !== 1) throw new TestSetupError(`Missing wiki_for field for ${nodeId}`);
}

function expectCanonicalOrchardRoot(reconcileFixture: ReconcileFixture, nodeId: string): void {
  expect(loadWikiNodeFields(reconcileFixture.db, nodeId).wiki_for).toBe('Meetings/Orchard Pilot Project.md');
  expect(reconcileFixture.db.prepare(`
    SELECT target, resolved_target_id FROM relationships
    WHERE source_id = ? AND rel_type = 'wiki_for'
  `).get(nodeId)).toEqual({
    target: 'Meetings/Orchard Pilot Project.md',
    resolved_target_id: reconcileFixture.project.id,
  });
}

function createNode(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  title: string,
  filePath: string,
  types: string[],
  fields: Record<string, unknown>,
  body: string,
): NodeRef {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: filePath,
    title,
    types,
    fields,
    body,
  });
  return { id: result.node_id, title, version: nodeVersion(db, result.node_id) };
}

function upsertExisting(
  node: NodeRef,
): Extract<WikiReconcileInput['pages'][number], { readonly op: 'upsert' }> {
  return {
    op: 'upsert',
    target: { mode: 'existing', node_id: node.id, expected_version: nodeVersion(fixture.db, node.id) },
    scope: SCOPE,
    kind: 'workstream',
    origin: 'automatic',
    pinned: false,
  };
}

function upsertNew(
  planKey: string,
  title: string,
): Extract<WikiReconcileInput['pages'][number], { readonly op: 'upsert' }> {
  return {
    op: 'upsert',
    target: { mode: 'new', plan_key: planKey, title },
    scope: SCOPE,
    kind: 'workstream',
    origin: 'automatic',
    pinned: false,
    sections: [{ name: 'Summary', mode: 'replace', content: `${title} summary.` }],
  };
}

function retire(
  node: NodeRef,
  state: 'dormant' | 'retired',
): Extract<WikiReconcileInput['pages'][number], { readonly op: 'retire' }> {
  return {
    op: 'retire',
    node_id: node.id,
    expected_version: nodeVersion(fixture.db, node.id),
    scope: SCOPE,
    state,
    reason: 'No longer current.',
  };
}

function mergeExisting(
  target: NodeRef,
  source: NodeRef,
): Extract<WikiReconcileInput['pages'][number], { readonly op: 'merge' }> {
  return {
    op: 'merge',
    target: {
      mode: 'existing',
      node_id: target.id,
      expected_version: nodeVersion(fixture.db, target.id),
    },
    sources: [{ node_id: source.id, expected_version: nodeVersion(fixture.db, source.id) }],
    scope: SCOPE,
    kind: 'workstream',
    origin: 'automatic',
    pinned: false,
    reason: 'Consolidate overlap.',
    sections: [{ name: 'Summary', mode: 'replace', content: 'Consolidated summary.' }],
  };
}

function mergeNew(
  planKey: string,
  title: string,
  source: NodeRef,
): Extract<WikiReconcileInput['pages'][number], { readonly op: 'merge' }> {
  return {
    op: 'merge',
    target: { mode: 'new', plan_key: planKey, title },
    sources: [{ node_id: source.id, expected_version: nodeVersion(fixture.db, source.id) }],
    scope: SCOPE,
    kind: 'workstream',
    origin: 'automatic',
    pinned: false,
    reason: 'Consolidate overlap.',
    sections: [{ name: 'Summary', mode: 'replace', content: 'Consolidated summary.' }],
  };
}

function sourceBody(human: string): string {
  return mergeManagedSections(human, {
    live: {},
    managed: [{ name: 'Summary', mode: 'replace', content: 'Original summary.' }],
  }).body;
}

function nodeBody(db: Database.Database, nodeId: string): string {
  const row = db.prepare('SELECT body FROM nodes WHERE id = ?').get(nodeId) as { body: string } | undefined;
  if (row === undefined) throw new TestSetupError(`Missing node ${nodeId}`);
  return row.body;
}

function nodeVersion(db: Database.Database, nodeId: string): number {
  const row = db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined;
  if (row === undefined) throw new TestSetupError(`Missing node ${nodeId}`);
  return row.version;
}

function requiredPage(pages: readonly NodeRef[], nodeId: string): NodeRef {
  const page = pages.find(candidate => candidate.id === nodeId);
  if (page === undefined) throw new TestSetupError(`Missing catalog page ${nodeId}`);
  return page;
}

function databaseSnapshot(db: Database.Database): Readonly<Record<string, readonly unknown[]>> {
  const tables = [
    'nodes',
    'node_types',
    'node_fields',
    'relationships',
    'undo_operations',
    'undo_snapshots',
    'sync_log',
    'edits_log',
  ] as const;
  return Object.fromEntries(tables.map(table => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function fileSnapshot(root: string, relative = ''): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(files, fileSnapshot(root, child));
    } else {
      files[child] = readFileSync(join(root, child), 'utf8');
    }
  }
  return files;
}

class InjectedMutationError extends Error {
  readonly name = 'InjectedMutationError';

  constructor(readonly mutationIndex: number) {
    super(`Injected mutation failure at ${mutationIndex}`);
  }
}

class TestSetupError extends Error {
  readonly name = 'TestSetupError';
}
