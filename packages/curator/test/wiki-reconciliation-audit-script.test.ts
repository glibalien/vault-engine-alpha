import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/audit-wiki-reconciliation.mjs', import.meta.url));
const tempDirs: string[] = [];
const scope = (facet: string) => ({ v: 1, subject: 'Orbital Builder Redux', facet });

type AuditPage = {
  id: string;
  title: string;
  file_path: string;
  wiki_state: string;
  wiki_scope: ReturnType<typeof scope>;
  wiki_pinned: boolean;
  content_hash?: string;
  body?: string;
  wiki_replaced_by?: { id: string; title: string };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function artifacts() {
  const beforePages: AuditPage[] = [
    { id: 'canonical', title: 'Operations Timeline', file_path: 'Wikis/Operations Timeline.md', wiki_state: 'active', wiki_scope: scope('operations'), wiki_pinned: false, body: 'PRIVATE BEFORE BODY' },
    { id: 'duplicate', title: 'Campaign Chronology', file_path: 'Wikis/Campaign Chronology.md', wiki_state: 'active', wiki_scope: scope('campaign chronology'), wiki_pinned: true },
    { id: 'stale', title: 'Concluded Thread', file_path: 'Wikis/Concluded Thread.md', wiki_state: 'active', wiki_scope: scope('concluded'), wiki_pinned: false },
  ];
  const actions = [
    { op: 'merge', target: { node_id: 'canonical' }, sources: ['duplicate'], scope: scope('operations'), reason: 'overlap', synthesis_brief: 'merge' },
    { op: 'retire', node_id: 'stale', scope: scope('concluded'), state: 'retired', reason: 'done' },
    { op: 'create', plan_key: 'air', title: 'Air Operations', kind: 'timeline', scope: scope('air operations'), synthesis_brief: 'distinct' },
  ];
  const verdicts = beforePages.map(page => ({
    candidate_plan_key: 'air', compared_to: { node_id: page.id }, relation: 'distinct', confidence: 0.95,
    evidence_ids: ['e1'], reason: 'distinct',
  }));
  const catalog: { home_id: string; home: Record<string, unknown>; topology_hash: string; catalog_valid: boolean; subpages: AuditPage[] } = {
    home_id: 'home',
    home: { id: 'home', version: 2, wiki_topology_hash: 'post-hash', wiki_evidence_hash: 'evidence' },
    topology_hash: 'post-hash',
    catalog_valid: true,
    subpages: [
      { ...beforePages[0]!, wiki_pinned: true, content_hash: 'after-canonical' },
      { ...beforePages[1]!, wiki_state: 'retired', wiki_pinned: false, wiki_scope: scope('operations'), wiki_replaced_by: { id: 'canonical', title: 'Operations Timeline' }, content_hash: 'after-duplicate' },
      { ...beforePages[2]!, wiki_state: 'retired', content_hash: 'after-stale' },
      { id: 'created-air', title: 'Air Operations', file_path: 'Wikis/Air Operations.md', wiki_state: 'active', wiki_scope: scope('air operations'), wiki_pinned: false, content_hash: 'air' },
    ],
  };
  return {
    before: { existing_wiki: { home_id: 'home', home: { id: 'home', version: 1 }, topology_hash: 'before-hash', catalog_valid: true, subpages: beforePages } },
    preview: {
      ok: true, dry_run: true, outcome: 'written', catalog_health: { valid: true, missing_scope_node_ids: [] },
      proposed_reviewed_page_ids: beforePages.map(page => page.id), reviewed_page_ids: beforePages.map(page => page.id), final_actions: actions,
      adjudication_verdicts: verdicts, page_preview: { total: 3, items: [], truncated: false },
      expected_reconcile_key: 'reconcile-1',
    },
    after: {
      catalog,
      reconciliation: {
        ok: true, dry_run: false, outcome: 'written',
        proposed_reviewed_page_ids: beforePages.map(page => page.id), reviewed_page_ids: beforePages.map(page => page.id),
        final_actions: actions.map(action => ({ ...action })), adjudication_verdicts: verdicts, post_topology_hash: 'post-hash',
        expected_reconcile_key: 'reconcile-1', undo_operation_id: 'undo-1', page_preview: { total: 3, items: [], truncated: false },
      },
      source_preservation: [
        { node_id: 'duplicate', preserved_outside_managed_status: true },
        { node_id: 'stale', preserved_outside_managed_status: true },
      ],
      private_body: 'PRIVATE AFTER BODY',
    },
    second: {
      ok: true, dry_run: false, outcome: 'skipped', detail: 'evidence and topology unchanged',
      reviewed_page_ids: [], final_actions: [], adjudication_verdicts: [], page_preview: null,
      usage: null, undo_operation_id: null, post_topology_hash: 'post-hash',
    },
  };
}

function run(values: ReturnType<typeof artifacts>, full = true) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-reconcile-audit-'));
  tempDirs.push(dir);
  const paths: Record<string, string> = Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const path = join(dir, `${key}.json`);
    writeFileSync(path, JSON.stringify(value), 'utf8');
    return [key, path];
  }));
  const args = [SCRIPT, '--before', paths['before']!, '--preview', paths['preview']!];
  if (full) args.push('--after', paths['after']!, '--second-run', paths['second']!);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

describe('audit-wiki-reconciliation', () => {
  it('documents its read-only CLI and accepts preview-only audits', () => {
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--before FILE --preview FILE');

    const preview = run(artifacts(), false);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true, mode: 'preview' });
  });

  it('passes a preserved, pinned, hash-consistent, converged full audit without echoing bodies', () => {
    const result = run(artifacts());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true, mode: 'post-run',
      summary: { before_pages: 3, reviewed_pages: 3, planned_creates: 1, planned_merges: 1, planned_retires: 1, after_pages: 4 },
    });
    expect(result.stdout).not.toContain('PRIVATE BEFORE BODY');
    expect(result.stdout).not.toContain('PRIVATE AFTER BODY');
  });

  it.each([
    ['MISSING_PROPOSED_REVIEWED_ID', (value: ReturnType<typeof artifacts>) => { value.preview.proposed_reviewed_page_ids = ['canonical', 'stale']; }],
    ['MISSING_REVIEWED_ID', (value: ReturnType<typeof artifacts>) => { value.preview.reviewed_page_ids = ['canonical', 'stale']; }],
    ['MISSING_PREEXISTING_PAGE', (value: ReturnType<typeof artifacts>) => { value.after.catalog.subpages = value.after.catalog.subpages.filter(page => page.id !== 'duplicate'); }],
    ['ACTIVE_DUPLICATE_SCOPE', (value: ReturnType<typeof artifacts>) => {
      const duplicate = value.after.catalog.subpages.find(page => page.id === 'duplicate');
      if (duplicate !== undefined) { duplicate.wiki_state = 'active'; duplicate.wiki_replaced_by = undefined; }
    }],
    ['BROKEN_REPLACEMENT', (value: ReturnType<typeof artifacts>) => {
      const duplicate = value.after.catalog.subpages.find(page => page.id === 'duplicate');
      if (duplicate !== undefined) duplicate.wiki_replaced_by = { id: 'missing', title: 'Missing' };
    }],
    ['SOURCE_PRESERVATION_UNPROVEN', (value: ReturnType<typeof artifacts>) => {
      value.after.source_preservation[0]!.preserved_outside_managed_status = false;
    }],
    ['PIN_NOT_TRANSFERRED', (value: ReturnType<typeof artifacts>) => {
      const canonical = value.after.catalog.subpages.find(page => page.id === 'canonical');
      if (canonical !== undefined) canonical.wiki_pinned = false;
    }],
    ['TOPOLOGY_HASH_MISMATCH', (value: ReturnType<typeof artifacts>) => { value.after.catalog.home['wiki_topology_hash'] = 'wrong'; }],
    ['UNEXPECTED_CREATE', (value: ReturnType<typeof artifacts>) => {
      value.after.catalog.subpages.push({ id: 'surprise', title: 'Surprise', file_path: 'Wikis/Surprise.md', wiki_state: 'active', wiki_scope: scope('surprise'), wiki_pinned: false, content_hash: 'surprise' });
    }],
    ['RECONCILE_KEY_CHANGED', (value: ReturnType<typeof artifacts>) => { value.after.reconciliation.expected_reconcile_key = 'reconcile-2'; }],
    ['APPROVED_PLAN_CHANGED', (value: ReturnType<typeof artifacts>) => {
      const first = value.after.reconciliation.final_actions[0];
      if (first !== undefined && 'reason' in first) first.reason = 'changed after approval';
    }],
    ['NON_CONVERGED_SECOND_RUN', (value: ReturnType<typeof artifacts>) => { value.second.outcome = 'written'; }],
    ['SECOND_RUN_HASH_MISMATCH', (value: ReturnType<typeof artifacts>) => { value.second.post_topology_hash = 'different'; }],
  ])('exits nonzero for %s', (code, mutate) => {
    const value = artifacts();
    mutate(value);

    const result = run(value);
    const report = JSON.parse(result.stdout) as { ok: boolean; issues: Array<{ code: string }> };

    expect(result.status).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.issues.map(issue => issue.code)).toContain(code);
  });
});
