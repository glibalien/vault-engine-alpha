import { z } from 'zod';
import type { AdjudicationPair } from '../adjudicate-matrix.js';
import type { JsonSchema } from '../llm/types.js';
import { NODE_REF_SCHEMA } from './topology.js';

const REASON_MAX_CHARS = 500;
const nonEmptyString = z.string().min(1);

export const ADJUDICATION_VERDICT_SCHEMA = z.strictObject({
  pair_id: nonEmptyString,
  candidate_plan_key: nonEmptyString,
  compared_to: NODE_REF_SCHEMA,
  relation: z.enum(['same-scope', 'substantial-overlap', 'containment', 'distinct']),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(nonEmptyString),
  reason: nonEmptyString.max(REASON_MAX_CHARS),
  narrower: z.enum(['candidate', 'compared-to', 'none']),
});

export const ADJUDICATION_RESPONSE_SCHEMA = z.strictObject({
  verdicts: z.array(ADJUDICATION_VERDICT_SCHEMA),
});

export const ADJUDICATION_SYSTEM_PROMPT = `You check whether new wiki pages proposed by a planning step would duplicate a page the wiki already has, or another proposed page.

The input is a JSON object:
- evidence: the material the plan was made from.
- comparisons: one entry per pair to judge. Each has a pair_id, the proposed page (candidate_plan_key, candidate_title, candidate_kind, candidate_scope, candidate_synthesis_brief) and the page it is compared with: compared_to, comparison_kind (an existing page, another proposed page, or a planned merge target), compared_title, and its scope, state, kind, summary or brief when known.

Return exactly one verdict for every pair_id in the input, and none for any other. Each verdict copies pair_id, candidate_plan_key and compared_to from its pair, and gives:
- relation: "same-scope" when both pages cover the same subject within the same bounds; "substantial-overlap" when keeping both would largely repeat the same content; "containment" when one page's subject is a narrower part of the other's; "distinct" when both can exist without repeating each other.
- narrower: for "containment", the narrower page, "candidate" or "compared-to". Otherwise "none".
- confidence: from 0 to 1.
- evidence_ids: short ids from the evidence that support the verdict, exactly as they appear there.
- reason: a short explanation.

Judge each page by what it covers, its scope, never by its title or kind: a different title or kind doesn't make a page distinct. Compare against every page given, whatever its state; dormant and retired pages count. When unsure, don't answer "distinct": an unclear case must never lead to a new page.`;

export const ADJUDICATION_TOOL = {
  name: 'emit_scope_adjudication',
  description: 'Return one verdict for every comparison: would the proposed page duplicate the page it is compared with?',
  schema: z.toJSONSchema(ADJUDICATION_RESPONSE_SCHEMA) satisfies JsonSchema,
} as const;

export function buildAdjudicationPromptPayload(
  evidence: string,
  comparisons: readonly AdjudicationPair[],
): string {
  return JSON.stringify({ evidence, comparisons });
}
