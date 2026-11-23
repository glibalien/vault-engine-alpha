import { z } from 'zod';
import type { FilterExpression } from './expression.js';
/** Finite depth; no recursive $ref or unbounded lazy parser is advertised. */
export function expressionSchema<L>(leaf: z.ZodType<L>): z.ZodType<FilterExpression<L>> {
  const nonempty = leaf.refine(value => value !== null && typeof value === 'object' && Object.values(value).some(v => v !== undefined && (Array.isArray(v) ? v.length > 0 : typeof v === 'object' && v !== null ? Object.keys(v).length > 0 : true)), 'Expression leaves require a predicate');
  let schema: z.ZodType<FilterExpression<L>> = nonempty;
  for (let depth = 0; depth < 4; depth++)
    schema = z.union([nonempty, z.object({ all: z.array(schema).min(2).max(8) }).strict(), z.object({ any: z.array(schema).min(2).max(8) }).strict()]);
  return schema;
}
