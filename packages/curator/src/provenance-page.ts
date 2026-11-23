import { randomUUID } from 'node:crypto';
import type { Engine } from './engine.js';
import type { LlmClient, PreparedCapture } from './llm/types.js';
import { closedCaptureReason } from './provenance-home.js';
import { capturedPageBundle, type PageCaptureContext } from './provenance-page-evidence.js';
import type { PreparedReceipt, ProvenanceBinding, StageRequest } from './provenance-types.js';
import { synthesisSections } from './reconcile-write-plan.js';
import { localDate } from './date-line.js';
import type { PageSynthesisResult } from './types.js';

/** One page attempt. Durable request recovery is owned by the caller's optional
 * checkpoints; scheduled curation retains its existing run-level retry boundary. */
export class PageCapture {
  readonly attemptKey: string;
  private readonly context: PageCaptureContext;
  private receipt: PreparedReceipt | null = null;
  private previewed = false;
  get generatedAt(): Date { return new Date(this.context.generatedAt); }

  constructor(readonly engine: Pick<Engine, 'prepareProvenance' | 'stageProvenanceResult' | 'transitionProvenance' | 'inspectProvenance'>,
    context: PageCaptureContext,
    readonly checkpoints: { attemptKey?: string; beforeDispatch?: (receipt: PreparedReceipt) => Promise<void>;
      beforeStage?: (request: StageRequest) => Promise<void> } = {}) {
    this.attemptKey = checkpoints.attemptKey ?? randomUUID();
    this.context = structuredClone(context);
  }

  readonly onPrepared = async (capture: PreparedCapture): Promise<void> => {
    try {
      const result = await this.engine.prepareProvenance({ flow: 'project-subpage-v1', attempt_key: this.attemptKey,
        run_ref: this.context.runRef, project_id: this.context.projectId, dry_run: this.context.dryRun,
        bundle: capturedPageBundle(capture, this.context) });
      if (this.context.dryRun) {
        if (!('dry_run' in result) || !result.dry_run || !result.bundle_digest) throw new Error('PROVENANCE_PREVIEW_INVALID');
        this.previewed = true;
        return;
      }
      if ('dry_run' in result || result.state !== 'prepared' || result.availability !== 'retained' || !result.bundle_digest) throw new Error('PROVENANCE_UNAVAILABLE');
      this.receipt = result;
      await this.checkpoints.beforeDispatch?.(result);
      await this.engine.transitionProvenance({ derivation_id: result.derivation_id, action: 'mark-sent', expected_state: 'prepared' });
    } catch (error) { throw new Error(closedCaptureReason(error)); }
  };

  /** Restore only after recovery has checked the retained Engine attempt. */
  async restore(receipt: PreparedReceipt): Promise<void> {
    const current = await this.engine.inspectProvenance({ select: 'attempt', attempt_key: this.attemptKey, flow: 'project-subpage-v1' });
    if (current.select !== 'attempt' || !current.attempt || current.attempt.availability !== 'retained'
      || !['prepared', 'result_staged'].includes(current.attempt.state)
      || current.attempt.derivation_id !== receipt.derivation_id || current.attempt.bundle_digest !== receipt.bundle_digest
      || Date.parse(current.attempt.lease_expires_at) <= Date.now()) throw new Error('PROVENANCE_UNAVAILABLE');
    this.receipt = current.attempt;
  }

  async stage(result: PageSynthesisResult): Promise<ProvenanceBinding | null> {
    if (this.context.dryRun && this.previewed) return null;
    if (!this.receipt?.bundle_digest) throw new Error('PROVENANCE_UNAVAILABLE');
    const request: StageRequest = { derivation_id: this.receipt.derivation_id, bundle_digest: this.receipt.bundle_digest,
      validated_sections: { body: result.body, ...(result.log_note === undefined ? {} : { log_note: result.log_note }) },
      contribution: synthesisSections(result), generated_at: this.generatedAt.toISOString(), log_stamp: localDate(this.generatedAt, this.context.timeZone) };
    await this.checkpoints.beforeStage?.(request);
    return this.engine.stageProvenanceResult(request);
  }

  async fail(): Promise<void> {
    if (this.context.dryRun || !this.receipt) return;
    try {
      const current = await this.engine.inspectProvenance({ select: 'attempt', flow: 'project-subpage-v1', attempt_key: this.attemptKey });
      if (current.select !== 'attempt' || !current.attempt || current.attempt.availability !== 'retained') return;
      const state = current.attempt.state;
      if (state === 'prepared' || state === 'result_staged') await this.engine.transitionProvenance({ derivation_id: this.receipt.derivation_id, action: 'fail', expected_state: state });
    } catch { /* Primary failure wins; unavailable cleanup falls back to the lease. */ }
  }
}

/** Fail closed before any paid project planner work when batch capture is unavailable. */
export async function assertProjectSubpageCapture(engine: Pick<Engine, 'inspectProvenance'>, llm: LlmClient): Promise<void> {
  if (!llm.supportsPreparedCapture || !llm.previewStructuredCall) throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
  try {
    const status = await engine.inspectProvenance({ select: 'status' });
    if (status.select !== 'status' || status.capability_version !== 1
      || !status.capture_features?.includes('project-subpage-v1')
      || !status.capture_features.includes('multi-output-reconcile-v1')) throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
  } catch { throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED'); }
}
