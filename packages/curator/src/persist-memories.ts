import { Engine, EngineError } from './engine.js';
import type { MemoryProposal, MemoryWriteResult } from './types.js';

export interface PersistMemoriesOpts {
  /** config.memoryWriteEnabled — the master kill switch. */
  enabled: boolean;
  /** config.memoryWriteCap — max writes per run. */
  cap: number;
  dryRun: boolean;
  /** Curation-run provenance (Memories v3 §3): the journal runRef + the run's evidence hash. */
  evidence: { runRef: string; hash: string };
  /** Spend-ledger source for the Engine's consolidation calls (the usage context's project). */
  sourceRef?: string;
}

/** One create-memory attempt → classified MemoryWriteResult. Never throws:
 *  DUPLICATE_MEMORY is non-fatal ('duplicate'); a consolidation noop wrote nothing
 *  ('noop'); anything else is 'error'. Exported for the conversation sweep. */
export async function applyCreate(
  engine: Engine,
  args: Parameters<Engine['createMemory']>[0],
  dryRun: boolean,
  label = 'memory',
): Promise<MemoryWriteResult> {
  if (dryRun) return { content: args.content, action: 'preview' };
  try {
    const { operation, consolidationFailure } = await engine.createMemory(args);
    return {
      content: args.content, action: operation === 'noop' ? 'noop' : 'created',
      ...(consolidationFailure !== undefined ? { consolidationFailure } : {}),
    };
  } catch (err) {
    if (err instanceof EngineError && err.code === 'DUPLICATE_MEMORY') {
      return { content: args.content, action: 'duplicate' };
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[curator] ${label} write failed: ${detail}`);
    return { content: args.content, action: 'error', detail };
  }
}

/**
 * Apply LLM-proposed memories as node-scoped curator memories, best-effort.
 * Node-scoped to `homeId` (the wiki being curated); skips entirely when disabled,
 * when there is no home node to scope to, or when there is nothing to write.
 * Never throws — a create failure is captured as an `error` result and logged, so
 * it can never block the home write or the evidence-hash stamp. Caps at `opts.cap`
 * (the apply-step cap).
 */
export async function persistMemories(
  engine: Engine,
  homeId: string | null,
  proposals: readonly MemoryProposal[],
  opts: PersistMemoriesOpts,
): Promise<MemoryWriteResult[]> {
  if (!opts.enabled || !homeId || proposals.length === 0) return [];
  const results: MemoryWriteResult[] = [];
  for (const p of proposals.slice(0, opts.cap)) {
    results.push(await applyCreate(engine, {
      source: 'curator', scope: 'node', node_id: homeId,
      content: p.content, category: p.category,
      evidence: { kind: 'curation-run', ref: opts.evidence.runRef, node_id: homeId, hash: opts.evidence.hash },
      usage: { runRef: opts.evidence.runRef, ...(opts.sourceRef !== undefined ? { sourceRef: opts.sourceRef } : {}) },
    }, opts.dryRun));
  }
  return results;
}

export interface PersistSweepOpts {
  dryRun: boolean;
  /** First-class note provenance: the swept note and its content_hash at extraction time. */
  evidence: { node_id: string; hash: string };
  /** The sweep's run: the Engine's consolidation calls are spent under it (#298). */
  runRef?: string;
}

/**
 * Apply sweep-extracted facts as VAULT-scoped curator memories, best-effort.
 * No cap here — the sweep enforces its run cap at note granularity upstream.
 * `source` stays 'curator' so the engine's same-source dedup + v2 consolidation
 * apply by construction (the reason the sweep lives in the curator at all).
 */
export async function persistSweepMemories(
  engine: Engine,
  proposals: readonly MemoryProposal[],
  opts: PersistSweepOpts,
): Promise<MemoryWriteResult[]> {
  const results: MemoryWriteResult[] = [];
  for (const p of proposals) {
    results.push(await applyCreate(engine, {
      source: 'curator', scope: 'vault',
      content: p.content, category: p.category,
      ...(p.subjects && p.subjects.length > 0 ? { subjects: p.subjects } : {}),
      evidence: { kind: 'note', node_id: opts.evidence.node_id, hash: opts.evidence.hash },
      ...(opts.runRef !== undefined ? { usage: { runRef: opts.runRef, sourceRef: 'memory-sweep' } } : {}),
    }, opts.dryRun));
  }
  return results;
}
