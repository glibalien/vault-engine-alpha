import { randomUUID } from 'node:crypto';
import { EngineError, type Engine } from './engine.js';
import type { PreparedCapture } from './llm/types.js';
import { capturedBundle, jsonDigest, HOME_BUDGET_ASSEMBLY, type CaptureTransformLabels, type EvidenceCollector } from './provenance-evidence.js';
import type { Contribution, Json, PreparedReceipt, ProvenanceBinding, StageRequest } from './provenance-types.js';
import { homeSections } from './reconcile-write-plan.js';
import { localDate } from './date-line.js';
import type { WikiSections } from './types.js';

/** One local attempt, with frozen timestamps. Restart may abandon it and gather
 * again; this is not a durable checkpoint for page synthesis or model replay. */
export class HomeCapture {
  readonly attemptKey: string;
  private receipt: PreparedReceipt | null = null;
  private previewed = false;
  private expectedPreparedDigest: string | null = null;
  failureReason: string | null = null;
  constructor(readonly engine: Pick<Engine, 'prepareProvenance' | 'stageProvenanceResult' | 'transitionProvenance' | 'inspectProvenance'>,
    readonly projectId: string, readonly runRef: string, readonly dryRun: boolean,
    readonly collector: EvidenceCollector, readonly generatedAt = new Date(),
    readonly assembly = 'project-home-evidence-v1',
    readonly checkpoints: { attemptKey?: string; predecessorAttemptId?: string;
      recoverTransportErrors?: boolean;
      beforeDispatch?: (receipt: PreparedReceipt) => Promise<void>; beforeStage?: (request: StageRequest) => Promise<void> } = {},
    /** The zone of the Log stamp this capture records (`Config.curatorTz`); the host's when absent (#459). */
    readonly timeZone?: string,
    /** Prompt, schema and output labels; a project home's when absent. A dossier names its own (#554). */
    readonly transform?: CaptureTransformLabels) {
    this.attemptKey = checkpoints.attemptKey ?? randomUUID();
  }

  async preflight(capture: PreparedCapture): Promise<void> {
    try {
      const result = await this.engine.prepareProvenance({ attempt_key: this.attemptKey, run_ref: this.runRef,
        project_id: this.projectId, bundle: capturedBundle(capture, this.collector, this.assembly, this.transform), dry_run: true });
      if (!('dry_run' in result) || !result.dry_run || !result.bundle_digest) throw new Error('PROVENANCE_PREVIEW_INVALID');
      this.expectedPreparedDigest = jsonDigest(capture as unknown as Json);
    } catch (error) {
      if (this.checkpoints.recoverTransportErrors && !(error instanceof EngineError)) throw new Error('CAPTURE_CONNECTION_UNAVAILABLE');
      throw new Error(closedCaptureReason(error));
    }
  }

  readonly onPrepared = async (capture: PreparedCapture): Promise<void> => {
    try {
      if (this.assembly === HOME_BUDGET_ASSEMBLY && !this.expectedPreparedDigest) throw new Error('PROVENANCE_PREVIEW_REQUIRED');
      if (this.expectedPreparedDigest && jsonDigest(capture as unknown as Json) !== this.expectedPreparedDigest) throw new Error('PROVENANCE_PREVIEW_MISMATCH');
      await this.prepare(capture);
    } catch (error) {
      this.failureReason = closedCaptureReason(error);
      throw new Error(this.failureReason);
    }
  };

  private async prepare(capture: PreparedCapture): Promise<void> {
    const result = await this.engine.prepareProvenance({ attempt_key: this.attemptKey, run_ref: this.runRef,
      project_id: this.projectId, bundle: capturedBundle(capture, this.collector, this.assembly, this.transform), dry_run: this.dryRun,
      ...(this.checkpoints.predecessorAttemptId ? { predecessor_attempt_id: this.checkpoints.predecessorAttemptId } : {}) });
    if (this.dryRun) {
      if (!('dry_run' in result) || !result.dry_run) throw new Error('PROVENANCE_PREVIEW_INVALID');
      this.previewed = true; return;
    }
    if ('dry_run' in result || result.state !== 'prepared' || result.availability !== 'retained' || !result.bundle_digest) {
      throw new Error('PROVENANCE_UNAVAILABLE');
    }
    this.receipt = result;
    await this.checkpoints.beforeDispatch?.(result);
    await this.engine.transitionProvenance({ derivation_id: result.derivation_id, action: 'mark-sent', expected_state: 'prepared' });
  }

  /** Restore only after recovery has checked the retained Engine attempt. */
  async restore(receipt: PreparedReceipt): Promise<void> {
    const current = await this.engine.inspectProvenance({ select: 'attempt', attempt_key: this.attemptKey, flow: 'project-home-v1' });
    if (current.select !== 'attempt' || !current.attempt || current.attempt.availability !== 'retained'
      || !['prepared', 'result_staged'].includes(current.attempt.state)
      || current.attempt.derivation_id !== receipt.derivation_id || current.attempt.bundle_digest !== receipt.bundle_digest
      || Date.parse(current.attempt.lease_expires_at) <= Date.now()) throw new Error('PROVENANCE_UNAVAILABLE');
    this.receipt = current.attempt;
  }

  async stage(sections: WikiSections, validatedSections: WikiSections = sections): Promise<ProvenanceBinding | null> {
    return this.stageContribution(homeSections(sections), validatedSections);
  }

  /** Stage the given home sections as they are. A project home stages all of its sections through
   *  `stage`; a dossier writes only At a glance and Log (#554), which the Engine's home flow allows. */
  async stageContribution(contribution: Contribution, validatedSections: object): Promise<ProvenanceBinding | null> {
    if (this.dryRun && this.previewed) return null;
    if (!this.receipt?.bundle_digest) throw new Error('PROVENANCE_UNAVAILABLE');
    const validated_sections = Object.fromEntries(Object.entries(validatedSections).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const request: StageRequest = { derivation_id: this.receipt.derivation_id, bundle_digest: this.receipt.bundle_digest,
      validated_sections, contribution, generated_at: this.generatedAt.toISOString(),
      log_stamp: localDate(this.generatedAt, this.timeZone) };
    await this.checkpoints.beforeStage?.(request);
    return this.engine.stageProvenanceResult(request);
  }

  async fail(): Promise<void> {
    if (this.dryRun || !this.receipt) return;
    try {
      const current = await this.engine.inspectProvenance({ select: 'attempt', attempt_key: this.attemptKey });
      if (current.select !== 'attempt' || !current.attempt || current.attempt.availability !== 'retained') return;
      const state = current.attempt.state;
      if (state === 'prepared' || state === 'result_staged') await this.engine.transitionProvenance({ derivation_id: this.receipt.derivation_id, action: 'fail', expected_state: state });
    } catch {
      // The primary operation already failed; an unreachable Engine leaves the
      // lease to recover. Never overwrite a possibly committed receipt.
    }
  }
}

const CAPTURE_REASONS = new Set([
  'PROVENANCE_LIMIT', 'PROVENANCE_CAPACITY', 'PROVENANCE_OBSERVATION_CHANGED',
  'PROVENANCE_KEY_CONFLICT', 'PROVENANCE_UNAVAILABLE', 'PROVENANCE_REVOKED',
  'PROVENANCE_LEASE_EXPIRED', 'PROVENANCE_CAPTURE_UNSUPPORTED',
  'PROVENANCE_PREVIEW_REQUIRED', 'PROVENANCE_PREVIEW_MISMATCH', 'PROVENANCE_PREVIEW_INVALID',
]);

/** Allowlisted protocol/local reasons only, never raw Engine or transport errors. */
export function closedCaptureReason(error: unknown): string {
  const details = error instanceof EngineError ? error.details : undefined;
  const reason = details && typeof details === 'object' && 'reason' in details ? details.reason
    : error instanceof Error ? error.message : undefined;
  return typeof reason === 'string' && CAPTURE_REASONS.has(reason) ? reason : 'PROVENANCE_UNAVAILABLE';
}
