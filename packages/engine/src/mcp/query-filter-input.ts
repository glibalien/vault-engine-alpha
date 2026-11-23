import { classificationOperatorShape } from '../classification/input.js';
import { z } from 'zod';
import { fieldRecordSchema } from './field-record-schema.js';
import { expressionSchema } from '../filters/expression-schema.js';
import type { NodeQueryFilter } from './query-builder.js';
const fieldFilterSchema = z.object({
  ...classificationOperatorShape,
  eq: z.unknown().optional(),
  ne: z.unknown().optional(),
  gt: z.unknown().optional(),
  lt: z.unknown().optional(),
  gte: z.unknown().optional(),
  lte: z.unknown().optional(),
  contains: z.string().optional(),
  includes: z.unknown().optional(),
  one_of: z.array(z.unknown()).min(1).optional(),
  exists: z.boolean().optional(),
}).strict().refine(v => (!v.in_group && !v.is_unclassified) || Object.keys(v).length === 1, 'Group predicates require exactly one field operator');
const referenceSchema = z.object({
  target: z.string(),
  rel_type: z.string().optional(),
  direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
});
const countOperand = z.number().int().min(0).optional();
const countPredicateSchema = z.object({
  eq: countOperand, ne: countOperand, gt: countOperand, gte: countOperand, lt: countOperand, lte: countOperand,
}).strict().refine(p => Object.values(p).some(v => v !== undefined), 'A link-count predicate needs at least one of eq, ne, gt, gte, lt, lte');
const linkCountsSchema = z.object({
  rel_type: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  incoming: countPredicateSchema.optional(),
  outgoing: countPredicateSchema.optional(),
  unresolved: countPredicateSchema.optional(),
}).strict().refine(f => f.incoming !== undefined || f.outgoing !== undefined || f.unresolved !== undefined, 'link_counts needs at least one of incoming, outgoing, unresolved')
  .describe('Filter on how many distinct notes link to a node (incoming), it links to (outgoing), or it links to that do not exist (unresolved). Counts take body links and reference-field links together; rel_type narrows to some. Self-links never count. Operators: eq, ne, gt, gte, lt, lte (non-negative integers).');
const withoutTitleContainsSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('Exclude nodes whose title contains this text, or any of these texts (case-insensitive, literal).');
const targetLeafSchema = z.object({
  node_ids: z.array(z.string()).optional(),
  without_node_ids: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: fieldRecordSchema(fieldFilterSchema).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  without_titles: z.array(z.string()).optional(),
  without_title_contains: withoutTitleContainsSchema.optional(),
  references: referenceSchema.optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  created_since: z.string().optional(),
  // NOT included: join_filters, without_joins (nested joins deferred)
}).strict();
/** The flat filters alone: no `where`, no joins. What a write's scope may use, with every predicate validated. */
export const queryLeafFilterSchema = targetLeafSchema;
export const queryTargetFilterSchema = targetLeafSchema.extend({ where: expressionSchema(targetLeafSchema).optional() });
const joinFilterSchema = z.object({
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  rel_type: z.union([z.string(), z.array(z.string())]).optional(),
  target: queryTargetFilterSchema.optional(),
}).strict().refine((f) => f.rel_type !== undefined || f.target !== undefined, { message: 'INVALID_PARAMS: JoinFilter requires at least one of rel_type or target' });
const queryLeafShape = {
  node_ids: z.array(z.string()).optional(),
  without_node_ids: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: fieldRecordSchema(fieldFilterSchema).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  without_titles: z.array(z.string()).optional(),
  without_title_contains: withoutTitleContainsSchema.optional(),
  full_text: z.string().optional(),
  full_text_words: z.string().optional(),
  references: referenceSchema.optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  created_since: z.string().optional(),
  link_counts: linkCountsSchema.optional(),
  join_filters: z.array(joinFilterSchema).optional(),
  without_joins: z.array(joinFilterSchema).optional(),
};
const queryLeafSchema = z.object(queryLeafShape).strict();
export const queryFilterShape = { ...queryLeafShape, where: expressionSchema(queryLeafSchema).optional().describe('Read-only Boolean expression: all/any groups of 2–8 children, depth 4; strict nonempty filter leaves. Outer flat filters AND with where. Request caps: 64 nodes, 128 predicates, 512 scalar operands, 16 KiB where JSON; shared with join targets. No nested joins in targets.') };
export function pickQueryFilter(args: Record<string, unknown>): NodeQueryFilter {
  return Object.fromEntries(Object.keys(queryFilterShape).filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])) as NodeQueryFilter;
}
