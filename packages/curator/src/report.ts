import { addUsage, ZERO_USAGE } from './pricing.js';
import type { FieldGuessSweepResult } from './field-guess/types.js';
import type { CurateResult, TokenUsage, TopologyResult, WikiSections } from './types.js';
import type { TopicRefreshAdmissionWarning, TopicRefreshTrigger } from './topic-refresh-admission.js';
import type { TopicWebMaterialityAssessment } from './topic-refresh-assessment.js';

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Render field guessing separately from the public/project CurateResult report. */
export function formatFieldGuessReport(result: FieldGuessSweepResult): string[] {
  const prefix = `field guessing${result.dryRun ? ' (dry-run)' : ''}`;
  const summary = result.ran
    ? `${prefix}: ${[
        countLabel(result.scannedNodes, 'scanned', 'scanned'),
        countLabel(result.modelCalls, 'model call'),
        countLabel(result.fieldsSet, 'field set', 'fields set'),
        countLabel(result.abstentions, 'abstention'),
        countLabel(result.ledgerSkips, 'ledger skip'),
        countLabel(result.missingHashSkips, 'missing-hash skip'),
        countLabel(result.staleNodes, 'stale', 'stale'),
        countLabel(result.deferredNodes, 'deferred', 'deferred'),
        countLabel(result.errors, 'error'),
      ].join(', ')}`
    : `${prefix}: skipped (${result.skipReason ?? 'unknown'})`;
  return [
    summary,
    ...result.actions.map(action => `field guess action: ${action}`),
    ...result.warnings.map(warning => `field guess warning: ${warning}`),
  ];
}

/** Closed, count-only projection for unattended scheduled/catch-up logging. */
export function formatFieldGuessOperationalWarnings(result: FieldGuessSweepResult): string[] {
  if (!result.ran) {
    switch (result.skipReason) {
      case 'disabled': return [];
      case 'model_unresolved':
        return ['field guessing: skipped because the configured model is unresolved'];
      case 'database_unavailable':
        return ['field guessing: skipped because the Curator database is unavailable'];
      case 'presence_backfill_pending':
        return ['field guessing: skipped while field-presence backfill is pending'];
      default:
        return ['field guessing: skipped for an unknown operational reason'];
    }
  }

  const lines: string[] = [];
  const pushCount = (count: number, label: string): void => {
    if (count > 0) lines.push(`field guessing: ${count} ${label}${count === 1 ? '' : 's'}`);
  };
  pushCount(result.providerErrors, 'provider error');
  pushCount(result.referenceErrors, 'reference error');
  pushCount(result.mutationErrors, 'mutation error');
  pushCount(Math.max(0, result.errors - result.providerErrors - result.referenceErrors - result.mutationErrors), 'other operational error');
  pushCount(result.warnings.length, 'operational warning');
  return lines;
}

/** One project's curation outcome, projected for the curate-project-wiki response. */
export interface CurateResultView {
  project: string;
  outcome: CurateResult['outcome'];
  detail: string | null;
  evidence_hash: string | null;
  dry_run: boolean;
  usage: TokenUsage | null;
  cost_usd: number | null;
  /** A forced dry run only: nothing has changed since the last build. */
  evidence_unchanged?: boolean;
  /** Compatibility projection for legacy themed-page consumers. */
  themed?: Array<{ kind: string; title: string; action: string; state?: string }>;
  topology?: TopologyResult[];
  /** The would-write narrative sections — present only under dry_run. */
  sections?: WikiSections;
  refresh_trigger?: TopicRefreshTrigger;
  changed_source_node_ids?: string[];
  web_assessment?: {
    verdict: TopicWebMaterialityAssessment['verdict'];
    reason_code: TopicWebMaterialityAssessment['reasonCode'];
    changed_urls: string[];
  };
  refresh_warnings?: TopicRefreshAdmissionWarning[];
}

export interface CurateSummary {
  total: number;
  written: number;
  skipped: number;
  /** Dry-run results that found work to do; no model calls were made. */
  would_curate: number;
  /** Task-only changes handled by re-rendering live sections; no model calls were made. */
  refreshed_live: number;
  errors: number;
  /** Token usage summed across every result that reported it. */
  usage: TokenUsage;
  /** Estimated USD summed across every result that reported it. */
  cost_usd: number;
}

export interface CurateReport {
  mode: 'project' | 'sweep';
  dry_run: boolean;
  results: CurateResultView[];
  summary: CurateSummary;
}

/**
 * Project a list of CurateResults into the curate-project-wiki response. Pure:
 * no I/O, no mutation of the inputs. `evidence_hash` is surfaced per project
 * (the field the caller-parity task exists to expose); `sections` (the dry-run
 * preview) and `themed` are attached only when meaningful, to keep committed
 * responses lean.
 */
export function buildCurateReport(
  results: CurateResult[],
  opts: { mode: 'project' | 'sweep'; dryRun: boolean },
): CurateReport {
  const views: CurateResultView[] = results.map((r) => {
    const view: CurateResultView = {
      project: r.project,
      outcome: r.outcome,
      detail: r.detail ?? null,
      evidence_hash: r.evidenceHash ?? null,
      dry_run: r.dryRun,
      usage: r.usage ?? null,
      cost_usd: r.costUsd ?? null,
      ...(r.evidenceUnchanged === undefined ? {} : { evidence_unchanged: r.evidenceUnchanged }),
    };
    if (r.themed && r.themed.length > 0) {
      view.themed = r.themed.map((t) => ({
        kind: t.kind,
        title: t.title,
        action: t.action,
        ...(t.state !== undefined ? { state: t.state } : {}),
      }));
    }
    if (r.topology && r.topology.length > 0) view.topology = r.topology;
    if (opts.dryRun && r.sections) {
      view.sections = r.sections;
    }
    if (r.refreshTrigger !== undefined) view.refresh_trigger = r.refreshTrigger;
    if (r.changedSourceNodeIds !== undefined) view.changed_source_node_ids = r.changedSourceNodeIds.slice(0, 70);
    if (r.webAssessment !== undefined) {
      view.web_assessment = {
        verdict: r.webAssessment.verdict,
        reason_code: r.webAssessment.reasonCode,
        changed_urls: r.webAssessment.changedUrls.slice(0, 20),
      };
    }
    if (r.refreshWarnings !== undefined) view.refresh_warnings = r.refreshWarnings.slice(0, 8);
    return view;
  });

  const summary: CurateSummary = {
    total: results.length,
    written: results.filter((r) => r.outcome === 'written').length,
    skipped: results.filter((r) =>
      r.outcome === 'skipped'
      || r.outcome === 'skipped_cadence_not_due'
      || r.outcome === 'skipped_mode_disabled'
      || r.outcome === 'skipped_failure_hold'
      || r.outcome === 'skipped_budget'
    ).length,
    would_curate: results.filter((r) => r.outcome === 'would_curate').length,
    refreshed_live: results.filter((r) => r.outcome === 'refreshed_live').length,
    errors: results.filter((r) => r.outcome === 'error').length,
    usage: results.reduce<TokenUsage>((acc, r) => (r.usage ? addUsage(acc, r.usage) : acc), ZERO_USAGE),
    cost_usd: results.reduce((acc, r) => acc + (r.costUsd ?? 0), 0),
  };

  return { mode: opts.mode, dry_run: opts.dryRun, results: views, summary };
}

/** One concise, content-free explanation for topic refresh observability. */
export function formatTopicRefreshResult(result: CurateResult): string | null {
  if (result.refreshTrigger === undefined
    && result.changedSourceNodeIds === undefined
    && result.webAssessment === undefined
    && result.refreshWarnings === undefined) {
    return null;
  }
  if (result.detail === 'early refresh disabled') return 'early refresh disabled';
  const warnings = result.refreshWarnings ?? [];
  if (warnings.includes('assessment_cap_exhausted')) return 'web assessment cap exhausted';
  if (warnings.includes('web_probe_unavailable')) return 'web probe unavailable';
  if (warnings.includes('web_probe_overflow')) return 'web probe overflow';
  if (warnings.includes('assessment_failed')) return 'web assessment unavailable';
  if (warnings.includes('source_baseline_not_ready')) return 'source baseline not ready';
  if (warnings.includes('web_baseline_not_ready')) return 'web baseline not ready';
  if (result.refreshTrigger === 'vault_source_changed') {
    const count = result.changedSourceNodeIds?.length ?? 0;
    return `source change detected (${count} source${count === 1 ? '' : 's'})`;
  }
  if (result.webAssessment !== undefined) {
    return `web change assessed ${result.webAssessment.verdict} (${assessmentReasonLabel(result.webAssessment.reasonCode)})`;
  }
  if (result.detail === 'web probe unchanged') return 'web probe unchanged';
  if (result.outcome === 'skipped_cadence_not_due') return 'cadence not due';
  switch (result.refreshTrigger) {
    case 'not_due': return 'cadence not due';
    case 'cadence_due': return 'cadence due';
    case 'baseline_retry': return 'baseline commit retry pending';
    case 'manual_request': return 'manual refresh requested';
    case 'manual_force': return 'manual refresh forced';
    case 'web_material_change': return 'web material change detected';
    case undefined: return null;
    default: {
      const exhaustive: never = result.refreshTrigger;
      return exhaustive;
    }
  }
}

function assessmentReasonLabel(reason: TopicWebMaterialityAssessment['reasonCode']): string {
  switch (reason) {
    case 'new_development': return 'new development';
    case 'changed_fact': return 'changed fact';
    case 'time_sensitive_update': return 'time-sensitive update';
    case 'restatement': return 'restatement';
    case 'ranking_or_source_churn': return 'ranking or source churn';
    case 'insufficient_evidence': return 'insufficient evidence';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
