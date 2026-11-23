import { z } from 'zod';
import { reconcileWikiPages, type CoreDeps, type ReconcileWikiPagesArgs, type ReconcileWikiPagesResponse } from '../core.js';
import { withScope, type ToolHandler } from '../auth/with-scope.js';

export const reconcileWikiPagesInput = {
  wiki: z.string().min(1).describe('Exact active-project or registered-topic title'),
  dry_run: z.boolean().default(true).describe('Report whether the wiki would be reconciled, with no model calls or writes; defaults true'),
  preview: z.boolean().default(false).describe('With dry_run, run the paid model calls and return the proposed reconciliation without writing'),
  force: z.boolean().default(false).describe('Run even when evidence and topology are unchanged'),
};

type Args = { readonly wiki: string; readonly dry_run: boolean; readonly preview?: boolean; readonly force: boolean };
type Reconcile = (deps: CoreDeps, args: ReconcileWikiPagesArgs) => Promise<ReconcileWikiPagesResponse>;

export function makeReconcileWikiPagesHandler(
  deps: CoreDeps,
  reconcile: Reconcile = reconcileWikiPages,
): ToolHandler<Args> {
  return withScope<Args>('curate:trigger', async args => {
    const response = await reconcile(deps, { wiki: args.wiki, dryRun: args.dry_run, preview: args.dry_run && (args.preview ?? false), force: args.force });
    if (!response.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify(response) }] };
    const { result } = response;
    const audit = result.topologyAudit;
    const ambiguitySkips = (result.topology ?? []).filter(item => item.action === 'ambiguous-create-skipped');
    const payload = {
      ok: true,
      wiki: response.wiki,
      kind: response.kind,
      dry_run: response.dry_run,
      outcome: result.outcome,
      detail: result.detail ?? null,
      catalog_health: audit?.catalog ?? null,
      proposed_reviewed_page_ids: audit?.proposedReviewedPageIds ?? [],
      reviewed_page_ids: audit?.finalReviewedPageIds ?? [],
      proposed_actions: audit?.proposedActions ?? [],
      final_actions: audit?.finalActions ?? [],
      topology: result.topology ?? [],
      adjudication_verdicts: audit?.adjudicationVerdicts ?? [],
      ambiguity_skips: ambiguitySkips,
      validation_issue_codes: audit?.validationIssueCodes ?? [],
      page_preview: audit?.enginePreview ?? null,
      home_preview: audit?.homePreview ?? null,
      usage: result.usage ?? null,
      cost_usd: result.costUsd ?? null,
      expected_reconcile_key: audit?.reconcileKey ?? null,
      post_topology_hash: response.dry_run ? null : (result.topologyHash ?? null),
      node_mappings: response.dry_run ? [] : (audit?.mappings ?? []),
      warnings: audit?.warnings ?? [],
      undo_operation_id: response.dry_run ? null : (audit?.operationId ?? null),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    };
  });
}
