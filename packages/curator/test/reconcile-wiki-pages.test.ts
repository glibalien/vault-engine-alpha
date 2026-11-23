import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CurationQueue } from '../src/queue.js';
import { runMigrations } from '../src/db/migrate.js';
import { registerWikiRoot } from '../src/db/wiki-roots.js';
import { makeReconcileWikiPagesHandler } from '../src/tools/reconcile-wiki-pages.js';
import type { CoreDeps } from '../src/core.js';

function setup(projects: readonly string[] = ['Project']): { readonly db: Database.Database; readonly deps: CoreDeps } {
  const db = new Database(':memory:'); runMigrations(db);
  const engine = { listActiveProjects: vi.fn(async () => projects.map((title, index) => ({ id: `p${index}`, title, file_path: '', status: 'open' }))) };
  return { db, deps: { engine, llm: {}, config: { activeStatuses: ['open'] }, queue: new CurationQueue(), db } as never };
}

describe('reconcile-wiki-pages', () => {
  it('defaults to audit-first dry-run and forwards force', async () => {
    // Given
    const { db, deps } = setup();
    const reconcile = vi.fn(async () => ({ ok: true as const, wiki: 'Project', kind: 'project' as const, dry_run: true, result: { project: 'Project', outcome: 'written' as const, dryRun: true } }));
    const handler = makeReconcileWikiPagesHandler(deps, reconcile);

    // When
    await handler({ wiki: 'Project', dry_run: true, force: true }, { authInfo: { scopes: ['curate:trigger'] } });

    // Then
    expect(reconcile).toHaveBeenCalledWith(deps, { wiki: 'Project', dryRun: true, preview: false, force: true });
    db.close();
  });

  it('surfaces the final reviewed-page set for external completeness audits', async () => {
    const { db, deps } = setup();
    const reconcile = vi.fn(async () => ({
      ok: true as const,
      wiki: 'Project',
      kind: 'project' as const,
      dry_run: true,
      result: {
        project: 'Project', outcome: 'written' as const, dryRun: true,
        topologyAudit: {
          catalog: { valid: true, missing_scope_node_ids: [] },
          proposedReviewedPageIds: ['page-a'], finalReviewedPageIds: ['page-a', 'page-b'],
          proposedActions: [], finalActions: [], adjudicationVerdicts: [], validationIssueCodes: [], warnings: [],
        },
      },
    }));
    const handler = makeReconcileWikiPagesHandler(deps, reconcile);

    const result = await handler(
      { wiki: 'Project', dry_run: true, force: true },
      { authInfo: { scopes: ['curate:trigger'] } },
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

    expect(payload['proposed_reviewed_page_ids']).toEqual(['page-a']);
    expect(payload['reviewed_page_ids']).toEqual(['page-a', 'page-b']);
    db.close();
  });

  it('resolves registered topics and forwards real mode', async () => {
    // Given
    const { db, deps } = setup([]);
    registerWikiRoot(db, { root_title: 'Topic', root_node_id: 't1', kind: 'topic', source: 'vault', cadence: null, brief: null, created_at: '2026-08-14T00:00:00Z', created_by: null });
    const handler = makeReconcileWikiPagesHandler(deps);

    // When
    const result = await handler({ wiki: 'Topic', dry_run: false, force: false }, { authInfo: { scopes: ['curate:trigger'] } });

    // Then
    expect(result.content[0]?.text).not.toContain('UNKNOWN_WIKI');
    db.close();
  });

  it('returns exact available names for unknown and rejects ambiguous project/topic titles', async () => {
    // Given
    const { db, deps } = setup(['Same', 'Project']);
    registerWikiRoot(db, { root_title: 'Same', root_node_id: 't1', kind: 'topic', source: 'vault', cadence: null, brief: null, created_at: '2026-08-14T00:00:00Z', created_by: null });
    registerWikiRoot(db, { root_title: 'Topic', root_node_id: 't2', kind: 'topic', source: 'vault', cadence: null, brief: null, created_at: '2026-08-14T00:00:00Z', created_by: null });
    const handler = makeReconcileWikiPagesHandler(deps);

    // When
    const unknown = await handler({ wiki: 'Missing', dry_run: true, force: false }, { authInfo: { scopes: ['curate:trigger'] } });
    const ambiguous = await handler({ wiki: 'Same', dry_run: true, force: false }, { authInfo: { scopes: ['curate:trigger'] } });

    // Then
    expect(unknown.content[0]?.text).toContain('UNKNOWN_WIKI');
    expect(unknown.content[0]?.text).toContain('Project');
    expect(unknown.content[0]?.text).toContain('Topic');
    expect(ambiguous.content[0]?.text).toContain('AMBIGUOUS_WIKI');
    db.close();
  });
});
