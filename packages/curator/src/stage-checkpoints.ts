import { createHash } from 'node:crypto';
import type { Engine } from './engine.js';
import { canonical } from './provenance-evidence.js';
import type { Json } from './provenance-types.js';
import type { PlanningResult } from './reconciliation-planning.js';
import { ZERO_USAGE } from './pricing.js';
import type { NodeRef, PageSynthesisResult } from './types.js';

/**
 * Paid stage results of a wiki run that failed after them, kept so the next attempt on the same
 * inputs resumes at the first missing stage. Publication stays all-or-nothing: nothing reaches
 * the vault until a run writes the whole wiki.
 */
export type StageCheckpointPage = {
  readonly result: PageSynthesisResult;
  /** The page's provenance attempt; its staged derivation is what a later run binds. */
  readonly attemptKey?: string;
};

export type StageCheckpoint = {
  readonly planning: PlanningResult;
  readonly pages: readonly StageCheckpointPage[];
  readonly createdAt: string;
};

/** One wiki root's checkpoint. Implementations are best-effort: failures only cost reuse. */
export interface StageCheckpointStore {
  /** The checkpoint for exactly these inputs, or null. */
  load(fingerprint: string): StageCheckpoint | null;
  /** Starts a checkpoint with a completed planning stage. */
  savePlanning(fingerprint: string, planning: PlanningResult): boolean;
  /** Adds a completed page; false unless a checkpoint for these inputs exists. */
  savePage(fingerprint: string, page: StageCheckpointPage): boolean;
  clear(): void;
}

/** Project wiki runs only: a topic run records its evidence selections per stage call, which
 *  reuse would skip. Dry runs and previews never checkpoint. */
export function checkpointStoreFor(store: StageCheckpointStore | undefined,
  run: { readonly dryRun: boolean; readonly topic: boolean }): StageCheckpointStore | undefined {
  return run.dryRun || run.topic ? undefined : store;
}

/** Matches Engine's default provenance lease, the window a staged page stays bindable. */
export const STAGE_CHECKPOINT_MAX_AGE_MS = 24 * 3_600_000;
/** A reused page must stay bindable through the rest of the run. */
const LEASE_MARGIN_MS = 15 * 60_000;

export type StageFingerprintInput = {
  readonly wikiRootId: string;
  readonly rootTitle: string;
  readonly evidenceHash: string;
  readonly evidenceText: string;
  readonly evidenceNodes: unknown;
  readonly existingWiki: unknown;
  readonly planningPolicy: unknown;
  readonly pagePolicy: unknown;
  readonly prompts: Readonly<Record<string, string | undefined>>;
  readonly pageLimits: unknown;
  readonly bodyCharCap: number | null | undefined;
  readonly provenance: boolean;
  /** The build's memories in full, with ids: the planner marks rules by id, and the rendered
   *  evidence cuts a long memory (#474 idea 4). Absent when the build has none. */
  readonly memories?: unknown;
};

/** Everything the planner and page writer see; any difference means the stages must run again.
 *  Provenance observations are stamped with their read time, which is left out: their digests
 *  already identify the observed content. */
export function stageFingerprint(input: StageFingerprintInput): string {
  const normalized = JSON.parse(JSON.stringify({ v: 1, ...input },
    (key, value: unknown) => key === 'observed_at' ? undefined : value)) as Json;
  return createHash('sha256').update(canonical(normalized)).digest('hex');
}

export function targetKey(target: NodeRef): string {
  return 'node_id' in target ? `node:${target.node_id}` : `plan:${target.plan_key}`;
}

/** A checkpointed planning result reused by a later run; its usage was already counted. */
export function reusedPlanning(planning: PlanningResult): PlanningResult {
  return { ...planning, plannerUsage: ZERO_USAGE, adjudicatorUsage: ZERO_USAGE };
}

/**
 * Checkpointed pages a run may reuse, by target. With provenance, only pages whose staged
 * derivation is still retained, staged and leased past the margin; without it, only pages that
 * carry no binding. Reused pages count no usage.
 */
export async function reusablePages(engine: Pick<Engine, 'inspectProvenance'>, pages: readonly StageCheckpointPage[],
  captured: boolean, now: Date = new Date()): Promise<Map<string, PageSynthesisResult>> {
  const reusable = new Map<string, PageSynthesisResult>();
  for (const page of pages) {
    const binding = page.result.provenance;
    if (captured) {
      if (!binding || !page.attemptKey) continue;
      try {
        const current = await engine.inspectProvenance({ select: 'attempt', attempt_key: page.attemptKey, flow: 'project-subpage-v1' });
        const attempt = current.select === 'attempt' ? current.attempt : null;
        if (!attempt || attempt.availability !== 'retained' || attempt.state !== 'result_staged'
          || attempt.derivation_id !== binding.derivation_id || attempt.bundle_digest !== binding.bundle_digest
          || Date.parse(attempt.lease_expires_at) - now.getTime() <= LEASE_MARGIN_MS) continue;
      } catch {
        continue;
      }
    } else if (binding) {
      continue;
    }
    reusable.set(targetKey(page.result.target), { ...page.result, usage: ZERO_USAGE });
  }
  return reusable;
}

/** Parses stored JSON; null when it does not have the expected shape. */
export function parseStageCheckpoint(planningJson: string, pagesJson: string, createdAt: string): StageCheckpoint | null {
  try {
    const planning = JSON.parse(planningJson) as PlanningResult;
    const pages = JSON.parse(pagesJson) as StageCheckpointPage[];
    if (!planning || !Array.isArray(planning.plan?.actions) || !Array.isArray(planning.plan?.reviewed_page_ids)
      || !Array.isArray(planning.proposedPlan?.actions) || !Array.isArray(planning.attempts)
      || !Array.isArray(planning.droppedCreates) || !Array.isArray(planning.validationIssueCodes)
      || typeof planning.adjudication !== 'object' || planning.adjudication === null) return null;
    if (!Array.isArray(pages) || !pages.every(page => typeof page?.result?.body === 'string'
      && typeof page.result.target === 'object' && page.result.target !== null)) return null;
    // Checkpoints written before #323 carry no defaulted keeps, and those before #633 no kept long briefs.
    const keptByDefault = Array.isArray(planning.keptByDefault) ? planning.keptByDefault : [];
    const longBriefs = Array.isArray(planning.longBriefs) ? planning.longBriefs : [];
    return { planning: { ...planning, keptByDefault, longBriefs }, pages, createdAt };
  } catch {
    return null;
  }
}
