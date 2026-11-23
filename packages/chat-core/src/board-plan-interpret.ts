import type { LanguageModel } from 'ai';
import { currentDateLine } from './compose.js';
import { interpretToolArgs, type ToolArgsOutcome } from './interpret-core.js';
import { sanitizeVizInput, sanitizeQueryArgs, type VizSpec } from './viz-emit.js';
import { vizSpecRules } from './viz-interpret.js';
import { renderVocabulary, type VizVocabulary } from './viz-vocab.js';

/** A compact view of one existing board card, serialized into the prompt so
 *  replace_viz/remove can reference real ids. `spec` present for viz kinds only. */
export interface BoardContextCard { card_id: string; kind: string; title: string; spec?: Record<string, unknown> }

export type TemplateCard =
  | { kind: 'node' }
  | { kind: 'stats'; title?: string }
  | { kind: 'viz'; spec: VizSpec };

export type BoardPlanOp =
  | { op: 'add_viz'; spec: VizSpec }
  | { op: 'add_stats'; title: string }
  | { op: 'add_from_query'; kind: 'node'; query: Record<string, unknown>; cap?: number }
  | { op: 'replace_viz'; card_id: string; spec: VizSpec }
  | { op: 'remove'; card_id: string }
  | { op: 'create_board'; target?: string; name?: string; cards: TemplateCard[] };

export interface BoardPlanResult { summary: string; ops: BoardPlanOp[] }

export const MAX_PLAN_OPS = 8;
export const MAX_TEMPLATE_CARDS = 4;
const MAX_SUMMARY = 60;
const MAX_PER_OP_CAP = 12;
const OPS = ['add_viz', 'add_stats', 'add_from_query', 'replace_viz', 'remove', 'create_board'] as const;

export const BOARD_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'ops'],
  properties: {
    summary: { type: 'string', description: 'Short human label for this whole change, 60 chars max.' },
    ops: {
      type: 'array', minItems: 1, maxItems: MAX_PLAN_OPS,
      items: {
        type: 'object', additionalProperties: false, required: ['op'],
        properties: {
          op: { type: 'string', enum: [...OPS], description: 'REQUIRED on every item: which operation this is.' },
          spec: { type: 'object', description: 'add_viz / replace_viz: the full viz spec object, per the Spec rules.' },
          title: { type: 'string', description: 'add_stats: the card title.' },
          kind: { type: 'string', enum: ['node'], description: 'add_from_query: "node", one pinned note card per matched node.' },
          query: { type: 'object', description: 'add_from_query: query-nodes args selecting nodes. Emit the QUERY, never a list of nodes.' },
          cap: { type: 'number', description: 'add_from_query: max cards to create (12 max).' },
          card_id: { type: 'string', description: 'replace_viz / remove: an existing card id from the board context.' },
          target: { type: 'string', description: 'create_board: words naming the ONE note the board is for (resolved by search). Omit for a stand-alone board.' },
          name: { type: 'string', description: 'create_board: board name; may use {{title}} when target is given (default "{{title}}"); REQUIRED without target.' },
          cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
            kind: { type: 'string', enum: ['node', 'stats', 'viz'] },
            title: { type: 'string', description: 'kind "stats" only: the card title.' },
            spec: { type: 'object', description: 'kind "viz" only: the template viz spec per the Spec rules; {{title}}/{{id}} allowed in any string when target is given.' },
          } }, description: 'create_board: 1-4 template cards for the new board.' },
        },
      },
    },
  },
} as const;

const OP_NAMES = new Set<string>(OPS);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

const hasPlaceholders = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('{{title}}') || value.includes('{{id}}');
  if (Array.isArray(value)) return value.some(hasPlaceholders);
  if (isObj(value)) return Object.values(value).some(hasPlaceholders);
  return false;
};

/** Accept the natural-JSON shapes prompt-advisory models actually emit (both captured live,
 *  2026-07-27 repro): an ops item whose ONLY key is a known op name mapped to an object, and a
 *  plan carrying a single known op name as a top-level key instead of an ops array. Anything
 *  else still fails validation — this rewrites only the two unambiguous malformations.
 *  A body that carries its OWN op key is contradictory, not malformed-but-unambiguous — it falls through to validation and errors. */
export function normalizeBoardPlanShape(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  let r = raw;
  if (!Array.isArray(r.ops)) {
    const topOps = Object.keys(r).filter((k) => OP_NAMES.has(k) && isObj(r[k]));
    if (topOps.length === 1) {
      const body = r[topOps[0]] as Record<string, unknown>;
      if (!('op' in body)) {
        const k = topOps[0];
        const { [k]: _omit, ...rest } = r;
        const summary = typeof r.summary === 'string' && r.summary.trim() !== '' ? r.summary : k;
        r = { ...rest, summary, ops: [{ op: k, ...body }] };
      }
    }
  }
  if (Array.isArray(r.ops)) {
    r = { ...r, ops: (r.ops as unknown[]).map((item) => {
      if (!isObj(item) || typeof item.op === 'string') return item;
      const keys = Object.keys(item);
      if (keys.length === 1 && OP_NAMES.has(keys[0]) && isObj(item[keys[0]]) && !('op' in (item[keys[0]] as Record<string, unknown>))) {
        return { op: keys[0], ...(item[keys[0]] as Record<string, unknown>) };
      }
      return item;
    }) };
  }
  return r;
}

export function serializeBoardContext(cards: BoardContextCard[]): string {
  if (cards.length === 0) return '(the board is empty)';
  return cards
    .map((c) => `${c.card_id} · ${c.kind} · "${c.title}"${c.spec ? ` · ${JSON.stringify(c.spec)}` : ''}`)
    .join('\n');
}

export function sanitizeBoardPlan(raw: unknown, cards: BoardContextCard[]): { value: BoardPlanResult } | { error: string } {
  const normalized = normalizeBoardPlanShape(raw);
  if (typeof normalized !== 'object' || normalized === null) return { error: 'plan must be an object' };
  const r = normalized as Record<string, unknown>;
  if (typeof r.summary !== 'string' || r.summary.trim() === '') return { error: 'summary is required' };
  if (!Array.isArray(r.ops) || r.ops.length === 0) return { error: 'ops must be a non-empty array' };
  if (r.ops.length > MAX_PLAN_OPS) return { error: `at most ${MAX_PLAN_OPS} ops per plan` };
  const validIds = cards.map((c) => c.card_id);
  const requireCardId = (v: unknown): string | { error: string } =>
    typeof v === 'string' && validIds.includes(v)
      ? v
      : { error: `card_id "${String(v)}" is not on this board — valid ids: ${validIds.join(', ') || '(none)'}` };

  const ops: BoardPlanOp[] = [];
  for (const rawOp of r.ops as unknown[]) {
    if (typeof rawOp !== 'object' || rawOp === null) return { error: 'each op must be an object' };
    const o = rawOp as Record<string, unknown>;
    switch (o.op) {
      case 'add_viz': case 'replace_viz': {
        const s = sanitizeVizInput(o.spec);
        if ('error' in s) return { error: `${o.op}: ${s.error}` };
        if (o.op === 'replace_viz') {
          const id = requireCardId(o.card_id);
          if (typeof id !== 'string') return id;
          ops.push({ op: 'replace_viz', card_id: id, spec: s.spec });
        } else {
          ops.push({ op: 'add_viz', spec: s.spec });
        }
        break;
      }
      case 'add_stats': {
        if (typeof o.title !== 'string' || o.title.trim() === '') return { error: 'add_stats: title is required' };
        ops.push({ op: 'add_stats', title: o.title.trim() });
        break;
      }
      case 'add_from_query': {
        if (o.kind !== 'node') return { error: 'add_from_query: kind must be "node"' };
        const q = sanitizeQueryArgs(o.query);
        if ('error' in q) return { error: `add_from_query: ${q.error}` };
        const cap = typeof o.cap === 'number' && Number.isFinite(o.cap)
          ? Math.max(1, Math.min(Math.floor(o.cap), MAX_PER_OP_CAP))
          : undefined;
        ops.push({ op: 'add_from_query', kind: o.kind, query: q.query, ...(cap !== undefined ? { cap } : {}) });
        break;
      }
      case 'remove': {
        const id = requireCardId(o.card_id);
        if (typeof id !== 'string') return id;
        ops.push({ op: 'remove', card_id: id });
        break;
      }
      case 'create_board': {
        if (o.target !== undefined && (typeof o.target !== 'string' || o.target.trim() === '')) return { error: 'create_board: target must be non-empty text naming one note' };
        const target = typeof o.target === 'string' ? o.target.trim() : undefined;
        if (o.name !== undefined && (typeof o.name !== 'string' || o.name.trim() === '')) return { error: 'create_board: name must be a non-empty string' };
        const name = typeof o.name === 'string' ? o.name.trim() : undefined;
        if (target === undefined && name === undefined) return { error: 'create_board: name is required when no target is given' };
        if (!Array.isArray(o.cards) || o.cards.length === 0 || o.cards.length > MAX_TEMPLATE_CARDS) {
          return { error: `create_board: cards must be 1-${MAX_TEMPLATE_CARDS} template cards` };
        }
        const cards: TemplateCard[] = [];
        for (const rawCard of o.cards as unknown[]) {
          const c = (typeof rawCard === 'object' && rawCard !== null ? rawCard : {}) as Record<string, unknown>;
          if (c.kind === 'node') {
            if (target === undefined) return { error: 'create_board: node template cards need a target note' };
            cards.push({ kind: 'node' });
          } else if (c.kind === 'stats') {
            cards.push({ kind: 'stats', ...(typeof c.title === 'string' && c.title.trim() !== '' ? { title: c.title.trim() } : {}) });
          } else if (c.kind === 'viz') {
            const s = sanitizeVizInput(c.spec);
            if ('error' in s) return { error: `create_board template: ${s.error}` };
            cards.push({ kind: 'viz', spec: s.spec });
          } else return { error: 'create_board: template card kind must be "node", "stats", or "viz"' };
        }
        if (target === undefined && hasPlaceholders({ name, cards })) {
          return { error: 'create_board: {{title}}/{{id}} placeholders need a target note' };
        }
        ops.push({ op: 'create_board', cards, ...(target !== undefined ? { target } : {}), ...(name !== undefined ? { name } : {}) });
        break;
      }
      default:
        return { error: `unknown op "${String(o.op)}" — ops: ${OPS.join(', ')}` };
    }
  }
  const boardLevel = ops.filter((o) => o.op === 'create_board').length;
  if (boardLevel > 0 && ops.length > 1) {
    return { error: 'a plan contains either card-level ops or exactly ONE create_board — never both' };
  }
  return { value: { summary: r.summary.trim().slice(0, MAX_SUMMARY), ops } };
}

/** Substituted for an empty renderVocabulary() output (same wording as viz-interpret). */
const NO_VOCAB_LINE = '(no schema vocabulary available — use your judgment for type and field names)';

/** Stable-prefix system prompt: role + op rules + shared viz rules + vocabulary + board context, date line LAST (bc6a7061). */
export function buildBoardPlanSystem(vocab: VizVocabulary, cards: BoardContextCard[], now?: Date): string {
  const rendered = renderVocabulary(vocab);
  return `You translate one plain-language board request into a JSON operations plan {summary, ops} applied to the current board. Output ONLY the JSON object.

Op rules:
- add_viz {spec}: add one live query card; the spec follows the Spec rules below.
- add_stats {title}: add a vault-stats card.
- add_from_query {kind:"node", query, cap?}: create one pinned note card per node the query matches. Emit the QUERY, never a list of nodes; cap limits how many cards (12 max).
- replace_viz {card_id, spec}: replace an existing query card's spec (retarget, split, merge). card_id must be one listed under Current board cards.
- remove {card_id}: remove an existing card. A split is replace_viz + add_viz; a merge is replace_viz + remove.
- create_board {target?, name?, cards}: create ONE new board. target = a few words naming the ONE note the board is for (it is resolved by search; never emit a query or a list of notes). name may use {{title}} when target is given (default "{{title}}"); without target, name is REQUIRED and placeholders are not allowed. cards = 1-4 template cards — {kind:"node"}, {kind:"stats", title?}, or {kind:"viz", spec} where any string may use {{title}}/{{id}} when target is given, e.g. query {"references":{"target":"{{title}}","rel_type":"project"}}.
- A plan contains EITHER card-level ops OR exactly one create_board — never both.
- Creating a board is heavier than adding cards — use create_board only when the request clearly asks for a NEW board.
- summary: 60 chars max, a human label for the whole change.
- Usage and cost views cannot be created here — they are added from the board's + menu.

Spec rules (for add_viz / replace_viz specs):
${vizSpecRules(vocab.vault)}

Vault vocabulary — type (node count): field: kind · …
${rendered === '' ? NO_VOCAB_LINE : rendered}

Current board cards (card_id · kind · "title" · spec):
${serializeBoardContext(cards)}

${currentDateLine(now)}`;
}

export function interpretBoardPlan(o: {
  text: string; cards: BoardContextCard[]; vocab: VizVocabulary; model: LanguageModel; timeoutMs?: number;
}): Promise<ToolArgsOutcome<BoardPlanResult>> {
  return interpretToolArgs<BoardPlanResult>({
    text: o.text, model: o.model, timeoutMs: o.timeoutMs,
    config: {
      schema: BOARD_PLAN_SCHEMA as unknown as Record<string, unknown>,
      system: (now) => buildBoardPlanSystem(o.vocab, o.cards, now),
      prompt: (text) => `Board request: ${text}`,
      sanitize: (raw) => sanitizeBoardPlan(raw, o.cards),
      correction: (e) => `Your previous output was invalid: ${e}. Return a corrected full plan — a JSON object {"summary": string, "ops": [{"op": <one of ${OPS.join('|')}>, ...op fields}]}. Every ops[] item MUST carry an "op" string field.`,
    },
  });
}
