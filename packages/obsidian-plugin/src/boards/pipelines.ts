import {
  interpretBoardPlan, usageEventArgs, parseEnvelope,
  type BoardContextCard, type BoardPlanOp, type VizVocabulary,
} from '@vault/chat-core';
import type { BoardCardSpec, NodeCardSpec, VizSpec } from '@vault/viz-ui';
import type { ResolvedOp } from './board-ops.js';
import { makeBoardInterpreter, makeVocabFetcher, resolveVizModel, type BoardInterpreterDeps } from './interpreter.js';
import type { BoardInterpret, ComposerTool } from './BoardComposer.js';
import { instantiateTemplateCards, substitute } from './board-level.js';

interface SearchHit { id: string; title: string }

const MAX_PLAN_ADDS = 12;

/** Top hit of a hybrid search, or null. Envelope errors throw (caught by the pipeline's outer catch). */
async function topHit(deps: BoardInterpreterDeps, args: Record<string, unknown>): Promise<SearchHit | null> {
  const envl = parseEnvelope(await deps.engineCall('query-nodes', args)) as {
    ok?: boolean; data?: { nodes?: Array<{ id?: unknown; title?: unknown }> }; error?: { message?: string };
  };
  if (!envl.ok) throw new Error(envl.error?.message ?? 'search failed');
  const n = envl.data?.nodes?.[0];
  return n && typeof n.id === 'string' && typeof n.title === 'string' ? { id: n.id, title: n.title } : null;
}

/** All hits of a hybrid search (bounded by args.limit). Envelope errors throw (outer catch). */
async function allHits(deps: BoardInterpreterDeps, args: Record<string, unknown>): Promise<SearchHit[]> {
  const envl = parseEnvelope(await deps.engineCall('query-nodes', args)) as {
    ok?: boolean; data?: { nodes?: Array<{ id?: unknown; title?: unknown }> }; error?: { message?: string };
  };
  if (!envl.ok) throw new Error(envl.error?.message ?? 'search failed');
  return (envl.data?.nodes ?? []).filter((n): n is { id: string; title: string } =>
    typeof n.id === 'string' && typeof n.title === 'string');
}

/** Expand plan ops into concrete ResolvedOps — every engine call happens HERE,
 *  before anything touches the board; a failure aborts the whole submit. */
async function expandPlanOps(deps: BoardInterpreterDeps, ops: BoardPlanOp[]): Promise<{ ops: ResolvedOp[]; capped: boolean }> {
  const out: ResolvedOp[] = [];
  let adds = 0;
  let capped = false;
  const pushAdd = (spec: BoardCardSpec): void => {
    if (adds >= MAX_PLAN_ADDS) { capped = true; return; }
    adds++; out.push({ op: 'add', spec });
  };
  for (const op of ops) {
    if (op.op === 'add_viz') pushAdd(op.spec as unknown as BoardCardSpec);
    else if (op.op === 'add_stats') pushAdd({ kind: 'stats', title: op.title });
    else if (op.op === 'replace_viz') out.push({ op: 'replace', card_id: op.card_id, spec: op.spec as unknown as VizSpec });
    else if (op.op === 'remove') out.push({ op: 'remove', card_id: op.card_id });
    else if (op.op === 'add_from_query') {
      if (adds >= MAX_PLAN_ADDS) { capped = true; continue; }   // cap already filled — don't issue the query
      const args: Record<string, unknown> = { ...op.query, limit: Math.min(op.cap ?? MAX_PLAN_ADDS, MAX_PLAN_ADDS) };
      for (const h of await allHits(deps, args)) pushAdd({ kind: 'node', title: h.title, node_id: h.id });
    } else {
      throw new Error(`board-level op ${op.op} reached card-level expansion — mixing-rule violation`);
    }
  }
  return { ops: out, capped };
}

/**
 * The composer's per-tool dispatch. Only query-nodes and board touch the LLM;
 * get-node rides the search stack's top hit; vault-stats is
 * instant. query-nodes delegates to the phase-1 viz interpreter unchanged.
 * Never rejects — every failure is a visible {ok:false}.
 */
export function makeBoardPipelines(deps: BoardInterpreterDeps): BoardInterpret {
  const getVocab = makeVocabFetcher(deps);
  const vizInterpret = makeBoardInterpreter(deps, getVocab);

  return async (tool: ComposerTool, text: string, current?: BoardCardSpec, boardCards?: BoardContextCard[]) => {
    try {
      switch (tool) {
        case 'query-nodes':
          return await vizInterpret(text, current as never);

        case 'get-node': {
          const hit = await topHit(deps, { query: text, limit: 1 });
          if (!hit) return { ok: false as const, error: 'no note matched — try different words' };
          const expanded = current?.kind === 'node' && current.expanded === true ? { expanded: true as const } : {};
          return { ok: true as const, spec: { kind: 'node', title: hit.title, node_id: hit.id, ...expanded } satisfies NodeCardSpec };
        }

        case 'vault-stats':
          return { ok: true as const, spec: { kind: 'stats', title: text.trim() || 'Vault stats' } };

        case 'board': {
          const resolved = await resolveVizModel(deps);
          if (!resolved.ok) return resolved;
          let vocab: VizVocabulary;
          try { vocab = await getVocab(); }
          catch (err) { return { ok: false as const, error: `could not load the vault vocabulary: ${err instanceof Error ? err.message : String(err)}` }; }
          const start = Date.now();
          const result = await interpretBoardPlan({ text, cards: boardCards ?? [], vocab, model: deps.makeModel(resolved.entry) });
          const latencyMs = Date.now() - start;
          if (!result.ok) return result;
          try {
            const args = usageEventArgs({
              model: resolved.entry.model, provider: resolved.entry.provider, service: 'chat-plugin',
              purpose: 'viz-interpret', totalUsage: result.usage, latencyMs, billing: result.billing,
            });
            if (args) deps.recordUsage(args);
          } catch (err) {
            deps.log(`viz-interpret usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
          }
          const first = result.value.ops[0];
          if (first.op === 'create_board') {
            let hit: SearchHit | undefined;
            if (first.target !== undefined) {
              const found = await topHit(deps, { query: first.target, limit: 1 });
              if (!found) return { ok: false as const, error: 'no note matched — try different words' };
              hit = found;
            }
            const name = hit ? (substitute(first.name ?? '{{title}}', hit) as string) : (first.name ?? 'New board');
            return {
              ok: true as const,
              boardPlan: {
                kind: 'create' as const,
                name,
                cards: instantiateTemplateCards(first.cards, hit),
                ...(hit !== undefined ? { linkNodeId: hit.id } : {}),
                summary: result.value.summary,
              },
            };
          }
          const expanded = await expandPlanOps(deps, result.value.ops);
          if (expanded.ops.length === 0) return { ok: false as const, error: 'matched nothing — nothing applied' };
          return { ok: true as const, ops: expanded.ops, summary: result.value.summary, capped: expanded.capped };
        }
      }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  };
}
