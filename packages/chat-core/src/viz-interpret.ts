import type { LanguageModel, LanguageModelUsage } from 'ai';
import { interpretToolArgs, DEFAULT_INTERPRET_TIMEOUT_MS } from './interpret-core.js';
import type { CallBilling } from './usage.js';
import { sanitizeVizInput, presentVizSchema, type VizSpec } from './viz-emit.js';
import { currentDateLine } from './compose.js';
import { renderVocabulary, vizExampleNames, type VizVaultNames, type VizVocabulary } from './viz-vocab.js';

export { DEFAULT_INTERPRET_TIMEOUT_MS };

export type InterpretOutcome =
  | { ok: true; spec: VizSpec; usage: LanguageModelUsage; billing: CallBilling }
  | { ok: false; error: string };

/** The present-viz schema minus `pin` — the interpreter never pins; the board hosts the card. */
export function interpretSchema(vault?: VizVaultNames) {
  const schema = presentVizSchema(vault);
  const { pin: _pin, ...properties } = schema.properties;
  return { ...schema, properties };
}

/** The interpreter's schema with the vault map at its defaults. */
export const INTERPRET_SCHEMA = interpretSchema();

/** Substituted for an empty renderVocabulary() output so the prompt never carries a blank line there. */
const NO_VOCAB_LINE = '(no schema vocabulary available — use your judgment for type and field names)';

/** The VizSpec rules block, shared verbatim by the phase-1 viz interpreter and the
 *  phase-3 board-plan interpreter. Its examples are built from the vault map's names (`vault`);
 *  with the map at its defaults the block is the text from before the map, which the prompt tests
 *  pin byte-identical. An example whose name the vault has none of is left neutral. */
export function vizSpecRules(vault?: VizVaultNames): string {
  const n = vizExampleNames(vault);
  const title = n.tasks !== null && n.status !== null ? `'${n.tasks} · ${n.status} != ${n.done}'` : `'<type> · <field> != <value>'`;
  const filter = n.status !== null ? `{${JSON.stringify(n.status)}:{"eq":${JSON.stringify(n.open)}}}` : '{"<field>":{"eq":"<value>"}}';
  const groupBy = n.status !== null ? `kanban defaults to ${n.status}` : 'set it for kanban';
  return `- kind: table (compare fields in columns), kanban (cards grouped by a field), list (simple checkbox view), calendar (month grid plotted by a date field). Default to table; use kanban when the request implies grouping, calendar when it centers on dates.
- title: short human label for the card header, e.g. ${title}.
- query: query-nodes arguments. types (array) scopes to node types; fields holds per-field operator filters (${filter} — operators: eq, ne, one_of, exists, contains, gt, gte, lt, lte, includes); query is free-text hybrid search — topical text ONLY, never a substitute for a field filter; also available: path_prefix, title_contains, sort_by (title|file_mtime|indexed_at), sort_order, limit.
- Dates are ISO YYYY-MM-DD strings; resolve relative phrases ("this week", "overdue") into gte/lte bounds using today's date below.
- display_fields: the 2-4 fields that matter for this view (8 max).
- group_by: the field rows are grouped by: a kanban's columns (${groupBy}), or a table's or list's sections, one per value (only when asked for; omit it for no sections). date_field: the calendar's date field — required for kind calendar. end_date_field: optional, for items that run from one date to another (a start and an end): the date field where each item ends; the item then shows on every day between.
- Filter only on fields the chosen type actually has (vocabulary below), and use exact enum spellings.`;
}

/** The rules block with the vault map at its defaults. */
export const VIZ_SPEC_RULES = vizSpecRules();

/** Stable-prefix system prompt: role + spec rules + vocabulary, date line LAST (bc6a7061). */
export function buildInterpretSystem(vocab: VizVocabulary, now?: Date): string {
  const rendered = renderVocabulary(vocab);
  return `You translate one plain-language request into a viz spec — a JSON object that renders a live query card on a board. Output ONLY the JSON object.

Spec rules:
${vizSpecRules(vocab.vault)}

Vault vocabulary — type (node count): field: kind · …
${rendered === '' ? NO_VOCAB_LINE : rendered}

${currentDateLine(now)}`;
}

export function buildInterpretPrompt(text: string, current?: VizSpec): string {
  if (!current) return `Create a card: ${text}`;
  return `Current spec:\n${JSON.stringify(current)}\n\nApply ONLY this change and keep everything else exactly as-is: ${text}\nReturn the FULL updated spec.`;
}

export async function interpretVizSpec(o: {
  text: string; current?: VizSpec; vocab: VizVocabulary; model: LanguageModel; timeoutMs?: number;
}): Promise<InterpretOutcome> {
  const result = await interpretToolArgs<VizSpec>({
    text: o.text, current: o.current, model: o.model, timeoutMs: o.timeoutMs,
    config: {
      schema: interpretSchema(o.vocab.vault) as Record<string, unknown>,
      system: (now) => buildInterpretSystem(o.vocab, now),
      prompt: (text, current) => buildInterpretPrompt(text, current as VizSpec | undefined),
      sanitize: (raw) => {
        const s = sanitizeVizInput(raw);
        return 'error' in s ? { error: s.error } : { value: s.spec };
      },
      // Pre-refactor wording said "full spec", not "full object" — interpret-core's generic
      // default reads oddly for a viz spec, so restore the original phrasing here.
      correction: (e) => `Your previous output was invalid: ${e}. Return a corrected full spec.`,
    },
  });
  return result.ok ? { ok: true, spec: result.value, usage: result.usage, billing: result.billing } : result;
}
