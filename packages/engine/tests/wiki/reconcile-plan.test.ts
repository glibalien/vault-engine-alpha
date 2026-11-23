// allow: SIZE_OK — one integration-style contract matrix for the complete reconciliation validator.
import { describe, expect, it } from 'vitest';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { validateWikiReconcilePlan } from '../../src/wiki/reconcile-plan.js';
import type {
  ResolvedWikiReconcilePlan,
  WikiReconcileInput,
  WikiReconcileValidationResult,
} from '../../src/wiki/reconcile-types.js';
import { createTestDb } from '../helpers/db.js';

const SCOPE = { v: 1, subject: 'Project', facet: 'Delivery' } satisfies WikiReconcileInput['pages'][number]['scope'];
const SECTIONS = [{ name: 'Summary', mode: 'replace', content: 'Current summary.' }] as const;

describe('validateWikiReconcilePlan', () => {
  it('uses project_id to resolve an ambiguous project title exactly', () => {
    const db = orchardFixture();
    const input = {
      ...reconcileInput([]),
      project: 'Orchard Pilot Project',
      project_id: 'orchard-project',
    } as WikiReconcileInput;

    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    expect(validPlan(result).project).toEqual({
      id: 'orchard-project',
      title: 'Orchard Pilot Project',
      file_path: 'Meetings/Orchard Pilot Project.md',
    });
  });

  it('accepts the public basename-derived title for a null-title stable project_id', () => {
    const db = wikiFixture(false);
    seedNode(db, 'derived-project', 'Projects/Derived Project.md', 'placeholder', 1, ['project']);
    db.prepare('UPDATE nodes SET title = NULL WHERE id = ?').run('derived-project');
    const input = {
      ...reconcileInput([], HOME_WITHOUT_VERSION),
      project: 'Derived Project',
      project_id: 'derived-project',
    } as WikiReconcileInput;

    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    expect(validPlan(result).project).toEqual({
      id: 'derived-project',
      title: 'Derived Project',
      file_path: 'Projects/Derived Project.md',
    });
  });

  it('rejects a project reference that does not denote project_id', () => {
    const db = orchardFixture();
    const input = {
      ...reconcileInput([]),
      project: 'Other',
      project_id: 'orchard-project',
    } as WikiReconcileInput;

    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    expect(issueCodes(result)).toEqual(['PROJECT_ID_MISMATCH']);
  });

  it('rejects an ambiguous title-only project reference', () => {
    const db = orchardFixture();
    const input = { ...reconcileInput([]), project: 'Orchard Pilot Project' };

    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    expect(issueCodes(result)).toEqual(['AMBIGUOUS_PROJECT']);
  });

  it('rejects a new page whose normalized title collides with the root title', () => {
    const db = orchardFixture();
    const input = {
      ...reconcileInput([upsertNew('root-title', 'orchard pilot project')]),
      project: 'Orchard Pilot Project',
      project_id: 'orchard-project',
    } as WikiReconcileInput;

    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    if (result.ok) expect.fail('Expected root-title collision');
    expect(result.issues).toContainEqual({
      code: 'ROOT_TITLE_COLLISION',
      message: 'New wiki page title collides with root: orchard pilot project',
      operation_index: 0,
      title: 'orchard pilot project',
    });
  });

  it('resolves valid existing and new upserts, merge targets, and retire operations', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([
      {
        op: 'upsert',
        target: { mode: 'existing', node_id: 'target-a', expected_version: 2 },
        scope: { v: 1, subject: ' Project ', facet: ' Delivery ' },
        kind: 'workstream',
        origin: 'automatic',
        pinned: false,
      },
      {
        op: 'upsert',
        target: { mode: 'new', plan_key: 'create-a', title: 'Project — New' },
        scope: SCOPE,
        kind: 'timeline',
        origin: 'requested',
        pinned: true,
        sections: SECTIONS,
      },
      {
        op: 'merge',
        target: { mode: 'existing', node_id: 'target-b', expected_version: 3 },
        sources: [{ node_id: 'source-a', expected_version: 4 }],
        scope: SCOPE,
        kind: 'freeform',
        origin: 'automatic',
        pinned: false,
        reason: 'Consolidate overlap.',
        sections: SECTIONS,
      },
      {
        op: 'merge',
        target: { mode: 'new', plan_key: 'merge-new', title: 'Project — Consolidated' },
        sources: [{ node_id: 'source-b', expected_version: 5 }],
        scope: SCOPE,
        kind: 'decision-log',
        origin: 'requested',
        pinned: false,
        reason: 'Create a canonical target.',
        sections: SECTIONS,
      },
      {
        op: 'retire',
        node_id: 'retire-a',
        expected_version: 6,
        scope: SCOPE,
        state: 'dormant',
        reason: 'No current activity.',
      },
    ]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    const plan = validPlan(result);
    expect(plan.project).toEqual({ id: 'p1', title: 'Project', file_path: 'Project.md' });
    expect(plan.home.node_id).toBe('home-1');
    expect(plan.pages).toHaveLength(5);
    expect(plan.pages[0]).toMatchObject({
      op: 'upsert',
      target: { mode: 'existing', node_id: 'target-a', expected_version: 2 },
      scope: '{"v":1,"subject":"Project","facet":"Delivery"}',
    });
    expect(plan.pages[1]).toMatchObject({ target: { mode: 'new', plan_key: 'create-a' } });
    expect(plan.pages[2]).toMatchObject({ op: 'merge', target: { mode: 'existing', node_id: 'target-b' } });
    expect(plan.pages[3]).toMatchObject({ op: 'merge', target: { mode: 'new', plan_key: 'merge-new' } });
    expect(plan.pages[4]).toMatchObject({ op: 'retire', node_id: 'retire-a' });
    expect(plan.plan_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects existing targets and sources that belong to another wiki', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([
      {
        op: 'upsert',
        target: { mode: 'existing', node_id: 'other-a', expected_version: 7 },
        scope: SCOPE,
        kind: 'spotlight',
        origin: 'automatic',
        pinned: false,
      },
      {
        op: 'merge',
        target: { mode: 'new', plan_key: 'new-target', title: 'Project — New Target' },
        sources: [{ node_id: 'other-b', expected_version: 8 }],
        scope: SCOPE,
        kind: 'freeform',
        origin: 'automatic',
        pinned: false,
        reason: 'Invalid cross-wiki merge.',
        sections: SECTIONS,
      },
    ]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(issueCodes(result).filter(code => code === 'NODE_NOT_IN_WIKI')).toHaveLength(2);
  });

  it('collects stale page and home expected versions', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([
      {
        op: 'upsert',
        target: { mode: 'existing', node_id: 'target-a', expected_version: 200 },
        scope: SCOPE,
        kind: 'workstream',
        origin: 'automatic',
        pinned: false,
      },
      {
        op: 'merge',
        target: { mode: 'existing', node_id: 'target-b', expected_version: 300 },
        sources: [{ node_id: 'source-a', expected_version: 400 }],
        scope: SCOPE,
        kind: 'freeform',
        origin: 'automatic',
        pinned: false,
        reason: 'Stale merge.',
        sections: SECTIONS,
      },
    ], { ...HOME, expected_version: 100 });

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(issueCodes(result)).toEqual([
      'EXPECTED_VERSION_MISMATCH',
      'EXPECTED_VERSION_MISMATCH',
      'EXPECTED_VERSION_MISMATCH',
      'HOME_EXPECTED_VERSION_MISMATCH',
    ]);
  });

  it('collects duplicate plan keys, titles, node actions, sources, and source-target conflicts', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([
      upsertExisting('target-a', 2),
      upsertExisting('target-a', 2),
      upsertNew('duplicate-key', 'Project — Duplicate'),
      upsertNew('duplicate-key', 'Project — Duplicate'),
      upsertNew('catalog-title', 'Project — Target A'),
      mergeNew('merge-a', 'Project — Merge A', 'source-a', 4),
      mergeNew('merge-b', 'Project — Merge B', 'source-a', 4),
      mergeNew('merge-c', 'Project — Merge C', 'target-a', 2),
    ]);

    // When
    const first = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);
    const second = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    const codes = issueCodes(first);
    expect(codes).toContain('DUPLICATE_PLAN_KEY');
    expect(codes).toContain('TITLE_COLLISION');
    expect(codes).toContain('DUPLICATE_NODE_PARTICIPATION');
    expect(codes).toContain('SOURCE_TARGET_CONFLICT');
    expect(first).toEqual(second);
    expect(codes).toEqual([...codes].sort());
  });

  it('rejects standalone retirement of a pinned page', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([{
      op: 'retire',
      node_id: 'pinned-a',
      expected_version: 7,
      scope: SCOPE,
      state: 'retired',
      reason: 'Pinned pages must survive.',
    }]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(issueCodes(result)).toContain('PINNED_RETIRE');
  });

  it('allows a pinned page to participate as a merge source', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([mergeNew('pin-target', 'Project — Pin Target', 'pinned-a', 7)]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(validPlan(result).pages[0]).toMatchObject({ op: 'merge', sources: [{ node_id: 'pinned-a' }] });
  });

  it('rejects self and proposed replacement cycles', () => {
    // Given
    const selfDb = wikiFixture();
    const selfInput = reconcileInput([mergeExisting('target-a', 2, 'target-a', 2)]);
    const cycleDb = wikiFixture();
    replacement(cycleDb, 'target-a', 'Project — Source A', 'source-a');
    const cycleInput = reconcileInput([mergeExisting('target-a', 2, 'source-a', 4)]);

    // When
    const selfResult = validateWikiReconcilePlan(selfDb, DEFAULT_WIKI_CONFIG, selfInput);
    const cycleResult = validateWikiReconcilePlan(cycleDb, DEFAULT_WIKI_CONFIG, cycleInput);

    // Then
    expect(issueCodes(selfResult)).toContain('REPLACEMENT_CYCLE');
    expect(issueCodes(cycleResult)).toContain('REPLACEMENT_CYCLE');
  });

  it('rejects pre-existing cyclic and broken replacement chains', () => {
    // Given
    const db = wikiFixture();
    replacement(db, 'target-a', 'Project — Source A', 'source-a');
    replacement(db, 'source-a', 'Project — Target A', 'target-a');
    replacement(db, 'source-b', 'Missing Page', null);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, reconcileInput([]));

    // Then
    expect(issueCodes(result)).toEqual(['BROKEN_REPLACEMENT_CHAIN', 'REPLACEMENT_CYCLE']);
  });

  it('rejects an empty merge source list', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([{
      op: 'merge',
      target: { mode: 'new', plan_key: 'empty-merge', title: 'Project — Empty Merge' },
      sources: [],
      scope: SCOPE,
      kind: 'freeform',
      origin: 'automatic',
      pinned: false,
      reason: 'No sources.',
      sections: SECTIONS,
    }]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(issueCodes(result)).toContain('EMPTY_MERGE_SOURCES');
  });

  it('canonicalizes valid scopes and rejects invalid scopes', () => {
    // Given
    const validDb = wikiFixture();
    const validInput = reconcileInput([{
      ...upsertExisting('target-a', 2),
      scope: { v: 1, subject: ' Project ', facet: ' Delivery  status ', entities: ['Zulu', 'alpha', 'ALPHA'] },
    }]);
    const invalidDb = wikiFixture();
    const invalidInput = reconcileInput([{
      ...upsertExisting('target-a', 2),
      scope: { v: 1, subject: '', facet: 'Delivery' },
    }]);

    // When
    const validResult = validateWikiReconcilePlan(validDb, DEFAULT_WIKI_CONFIG, validInput);
    const invalidResult = validateWikiReconcilePlan(invalidDb, DEFAULT_WIKI_CONFIG, invalidInput);

    // Then
    expect(validPlan(validResult).pages[0]?.scope).toBe(
      '{"v":1,"subject":"Project","facet":"Delivery status","entities":["alpha","Zulu"]}',
    );
    expect(invalidResult).toMatchObject({
      ok: false,
      issues: [{ code: 'INVALID_SCOPE', scope_error: 'MISSING_SUBJECT' }],
    });
  });

  it('requires a home expected version only when the catalog already has a home', () => {
    // Given
    const existingDb = wikiFixture();
    const existingInput = reconcileInput([], HOME_WITHOUT_VERSION);
    const firstHomeDb = wikiFixture(false);
    const firstHomeInput = reconcileInput([upsertNew('first-page', 'Project — First Page')], HOME_WITHOUT_VERSION);

    // When
    const existingResult = validateWikiReconcilePlan(existingDb, DEFAULT_WIKI_CONFIG, existingInput);
    const firstHomeResult = validateWikiReconcilePlan(firstHomeDb, DEFAULT_WIKI_CONFIG, firstHomeInput);

    // Then
    expect(issueCodes(existingResult)).toContain('HOME_EXPECTED_VERSION_REQUIRED');
    expect(validPlan(firstHomeResult).home.node_id).toBeNull();
  });

  it('distinguishes already-satisfied and contradictory source replacements', () => {
    // Given
    const satisfiedDb = wikiFixture();
    replacement(satisfiedDb, 'source-a', 'Project — Target B', 'target-b');
    const satisfiedInput = reconcileInput([mergeExisting('target-b', 3, 'source-a', 4)]);
    const staleDb = wikiFixture();
    replacement(staleDb, 'source-a', 'Project — Target B', 'target-b');
    const staleInput = reconcileInput([mergeExisting('target-a', 2, 'source-a', 4)]);

    // When
    const satisfiedResult = validateWikiReconcilePlan(satisfiedDb, DEFAULT_WIKI_CONFIG, satisfiedInput);
    const staleResult = validateWikiReconcilePlan(staleDb, DEFAULT_WIKI_CONFIG, staleInput);

    // Then
    expect(validPlan(satisfiedResult)).toBeDefined();
    expect(satisfiedResult.markers).toEqual([{
      code: 'REPLACEMENT_ALREADY_SATISFIED',
      operation_index: 0,
      node_id: 'source-a',
      target: 'target-b',
    }]);
    expect(issueCodes(staleResult)).toContain('STALE_REPLACEMENT');
  });

  it('recognizes a same-key different-plan digest collision', () => {
    // Given
    const db = wikiFixture();
    field(db, 'home-1', 'wiki_reconcile_key', '{"v":1,"key":"run-1","plan_digest":"different"}');
    const input = reconcileInput([upsertNew('new-page', 'Project — New Page')]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(issueCodes(result)).toContain('RECONCILE_KEY_COLLISION');
    if (result.ok) expect.fail('Expected reconcile key collision');
    expect(result.plan_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('computes the same digest for semantically identical operation orderings', () => {
    // Given
    const firstDb = wikiFixture();
    const secondDb = wikiFixture();
    const alpha = upsertNew('alpha', 'Project — Alpha');
    const beta = upsertNew('beta', 'Project — Beta');

    // When
    const first = validateWikiReconcilePlan(firstDb, DEFAULT_WIKI_CONFIG, reconcileInput([alpha, beta]));
    const second = validateWikiReconcilePlan(secondDb, DEFAULT_WIKI_CONFIG, reconcileInput([beta, alpha]));

    // Then
    expect(validPlan(first).plan_digest).toBe(validPlan(second).plan_digest);
  });

  it('rejects invalid new titles and title collisions with the existing catalog', () => {
    // Given
    const db = wikiFixture();
    const input = reconcileInput([
      upsertNew('invalid-title', 'Project / Invalid'),
      upsertNew('existing-title', 'Project — Target A'),
    ]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(issueCodes(result)).toEqual(['INVALID_TITLE', 'TITLE_COLLISION']);
  });

  it('performs no database writes while resolving and validating', () => {
    // Given
    const db = wikiFixture();
    const before = databaseSnapshot(db);
    const input = reconcileInput([
      upsertExisting('target-a', 2),
      mergeNew('merge-target', 'Project — Merge Target', 'source-a', 4),
      {
        op: 'retire',
        node_id: 'retire-a',
        expected_version: 6,
        scope: SCOPE,
        state: 'retired',
        reason: 'Complete.',
      },
    ]);

    // When
    const result = validateWikiReconcilePlan(db, DEFAULT_WIKI_CONFIG, input);

    // Then
    expect(validPlan(result)).toBeDefined();
    expect(databaseSnapshot(db)).toEqual(before);
  });
});

const HOME = {
  expected_version: 10,
  sections: [{ name: 'Now', mode: 'replace', content: 'Current state.' }],
  evidence_hash: 'evidence-1',
  curated_at: '2026-08-13T12:00:00.000Z',
  refresh_live: true,
} as const satisfies WikiReconcileInput['home'];

const HOME_WITHOUT_VERSION = {
  sections: HOME.sections,
  evidence_hash: HOME.evidence_hash,
  curated_at: HOME.curated_at,
  refresh_live: true,
} as const satisfies WikiReconcileInput['home'];

function reconcileInput(
  pages: WikiReconcileInput['pages'],
  home: WikiReconcileInput['home'] = HOME,
): WikiReconcileInput {
  return { project: 'Project', reconcile_key: 'run-1', pages, home };
}

function upsertExisting(nodeId: string, expectedVersion: number): WikiReconcileInput['pages'][number] {
  return {
    op: 'upsert',
    target: { mode: 'existing', node_id: nodeId, expected_version: expectedVersion },
    scope: SCOPE,
    kind: 'workstream',
    origin: 'automatic',
    pinned: false,
  };
}

function upsertNew(planKey: string, title: string): WikiReconcileInput['pages'][number] {
  return {
    op: 'upsert',
    target: { mode: 'new', plan_key: planKey, title },
    scope: SCOPE,
    kind: 'workstream',
    origin: 'automatic',
    pinned: false,
    sections: SECTIONS,
  };
}

function mergeNew(
  planKey: string,
  title: string,
  sourceId: string,
  sourceVersion: number,
): WikiReconcileInput['pages'][number] {
  return {
    op: 'merge',
    target: { mode: 'new', plan_key: planKey, title },
    sources: [{ node_id: sourceId, expected_version: sourceVersion }],
    scope: SCOPE,
    kind: 'freeform',
    origin: 'automatic',
    pinned: false,
    reason: 'Consolidate sources.',
    sections: SECTIONS,
  };
}

function mergeExisting(
  targetId: string,
  targetVersion: number,
  sourceId: string,
  sourceVersion: number,
): WikiReconcileInput['pages'][number] {
  return {
    op: 'merge',
    target: { mode: 'existing', node_id: targetId, expected_version: targetVersion },
    sources: [{ node_id: sourceId, expected_version: sourceVersion }],
    scope: SCOPE,
    kind: 'freeform',
    origin: 'automatic',
    pinned: false,
    reason: 'Consolidate sources.',
    sections: SECTIONS,
  };
}

function validPlan(result: WikiReconcileValidationResult): ResolvedWikiReconcilePlan {
  if (!result.ok) expect.fail(`Expected valid plan, got ${JSON.stringify(result.issues)}`);
  return result.plan;
}

function issueCodes(result: WikiReconcileValidationResult): string[] {
  if (result.ok) expect.fail('Expected validation issues');
  return result.issues.map(issue => issue.code);
}

function wikiFixture(withHome = true): ReturnType<typeof createTestDb> {
  const db = createTestDb();
  seedNode(db, 'p1', 'Project.md', 'Project', 1, ['project']);
  seedNode(db, 'p2', 'Other.md', 'Other', 1, ['project']);
  if (withHome) {
    seedNode(db, 'home-1', 'Wikis/Project Wiki.md', 'Project Wiki', 10, ['wiki']);
    rel(db, 'home-1', 'Project', 'wiki_for', 'p1');
    const pages = [
      ['target-a', 'Project — Target A', 2],
      ['target-b', 'Project — Target B', 3],
      ['source-a', 'Project — Source A', 4],
      ['source-b', 'Project — Source B', 5],
      ['retire-a', 'Project — Retire A', 6],
      ['pinned-a', 'Project — Pinned A', 7],
    ] as const;
    for (const [id, title, version] of pages) {
      seedNode(db, id, `Wikis/${title}.md`, title, version, ['wiki']);
      rel(db, id, 'Project', 'wiki_for', 'p1');
      rel(db, id, 'Project Wiki', 'wiki_parent', 'home-1');
    }
    fieldNumber(db, 'pinned-a', 'wiki_pinned', 1);
  }
  seedNode(db, 'home-2', 'Wikis/Other Wiki.md', 'Other Wiki', 5, ['wiki']);
  rel(db, 'home-2', 'Other', 'wiki_for', 'p2');
  seedNode(db, 'other-a', 'Wikis/Other — A.md', 'Other — A', 7, ['wiki']);
  seedNode(db, 'other-b', 'Wikis/Other — B.md', 'Other — B', 8, ['wiki']);
  for (const id of ['other-a', 'other-b']) {
    rel(db, id, 'Other', 'wiki_for', 'p2');
    rel(db, id, 'Other Wiki', 'wiki_parent', 'home-2');
  }
  return db;
}

function orchardFixture(): ReturnType<typeof createTestDb> {
  const db = wikiFixture();
  seedNode(db, 'orchard-page', 'Wikis/Orchard Pilot Project.md', 'Orchard Pilot Project', 2, ['wiki']);
  seedNode(db, 'orchard-project', 'Meetings/Orchard Pilot Project.md', 'Orchard Pilot Project', 1, ['project']);
  seedNode(db, 'orchard-home', 'Wikis/Orchard Pilot Project Wiki.md', 'Orchard Pilot Project Wiki', 10, ['wiki']);
  rel(db, 'orchard-home', 'Meetings/Orchard Pilot Project.md', 'wiki_for', 'orchard-project');
  rel(db, 'orchard-page', 'Meetings/Orchard Pilot Project.md', 'wiki_for', 'orchard-project');
  rel(db, 'orchard-page', 'Orchard Pilot Project Wiki', 'wiki_parent', 'orchard-home');
  return db;
}

function seedNode(
  db: ReturnType<typeof createTestDb>,
  id: string,
  path: string,
  title: string,
  version: number,
  types: readonly string[],
): void {
  db.prepare(`
    INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, path, title, '', id, version, version, version);
  for (const type of types) db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, type);
}

function field(db: ReturnType<typeof createTestDb>, nodeId: string, name: string, value: string): void {
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)')
    .run(nodeId, name, value, 'frontmatter');
}

function fieldNumber(db: ReturnType<typeof createTestDb>, nodeId: string, name: string, value: number): void {
  db.prepare('INSERT INTO node_fields (node_id, field_name, value_number, source) VALUES (?, ?, ?, ?)')
    .run(nodeId, name, value, 'frontmatter');
}

function rel(
  db: ReturnType<typeof createTestDb>,
  source: string,
  target: string,
  type: string,
  resolved: string | null,
): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
    .run(source, target, type, null, resolved);
}

function replacement(
  db: ReturnType<typeof createTestDb>,
  sourceId: string,
  targetTitle: string,
  targetId: string | null,
): void {
  field(db, sourceId, 'wiki_replaced_by', targetTitle);
  rel(db, sourceId, targetTitle, 'wiki_replaced_by', targetId);
}

function databaseSnapshot(db: ReturnType<typeof createTestDb>): object {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  };
  return {
    nodes: count('nodes'),
    fields: count('node_fields'),
    relationships: count('relationships'),
    undo_operations: count('undo_operations'),
    versions: db.prepare('SELECT id, version FROM nodes ORDER BY id').all(),
  };
}
