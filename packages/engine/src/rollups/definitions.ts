import { assertExpressionBudget, FilterExpressionError } from '../filters/expression.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hasDateWindows } from '../summaries/temporal.js';
import type { ErrorCode } from '../mcp/tools/errors.js';
import {
  filterSchema, summaryFieldsFilterSchema,
  parseSummaryRequest,
  validateSummaryRequest,
} from '../summaries/input.js';
import type {
  RelationshipViews,
  RelationshipViewsDiscovery,
  SavedRelation,
  SavedRollup,
} from './types.js';
export const VIEWS_KEY = 'relationship_views_v1';
export class RollupError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const savedName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine((v) => v !== 'constructor' && v !== 'prototype');
const text = z.string().max(1024);
const relationSchema = z
  .object({
    name: savedName,
    direction: z.enum(['incoming', 'outgoing']),
    field: text.min(1),
    filter: filterSchema.pick({ types: true, without_types: true }).optional(),
    label: text.optional(),
    description: text.optional(),
  })
  .strict();
const rollupSchema = z
  .object({
    name: savedName,
    relation: savedName,
    filter: summaryFieldsFilterSchema.optional(),
    label: text.optional(),
    description: text.optional(),
    metric: z.discriminatedUnion('op', [
      z.object({op:z.literal('percentage'),matching_filter:summaryFieldsFilterSchema}).strict(),
      z.object({ op: z.literal('count') }).strict(),
      z
        .object({
          op: z.literal('min'),
          field: text.min(1),
          date_mode: z.literal('calendar_date').optional(),
        })
        .strict(),
      z
        .object({
          op: z.literal('max'),
          field: text.min(1),
          date_mode: z.literal('calendar_date').optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export const relationshipViewsSchema = z
  .object({
    version: z.literal(1),
    relations: z.array(relationSchema).max(16),
    rollups: z.array(rollupSchema).max(32),
  })
  .strict();
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            canonicalJson((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new RollupError(
      'INVALID_PARAMS',
      'Definitions must contain JSON values.',
    );
  return result;
}
export function relationshipViewsHash(value: unknown): string {
  return createHash('sha256')
    .update(
      value === undefined
        ? 'relationship-views:v1:absent'
        : 'relationship-views:v1:json:' + canonicalJson(value),
    )
    .digest('hex');
}
export function namespace(metadata: unknown): unknown {
  return metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.hasOwn(metadata, VIEWS_KEY)
    ? (metadata as Record<string, unknown>)[VIEWS_KEY]
    : undefined;
}
export function parseRelationshipViews(input: unknown): RelationshipViews {
  // Preflight each stored definition before recursive parsing or canonical hashing.
  const raw=input as Partial<RelationshipViews>|null;
  if(Array.isArray(raw?.rollups)) for(const [i,rollup] of raw.rollups.entries()) {
    try { assertExpressionBudget([{filter:rollup?.filter,profile:'fields',path:`rollups[${i}].filter`},
      ...(rollup?.metric?.op==='percentage'?[{filter:rollup.metric.matching_filter,profile:'fields' as const,path:`rollups[${i}].metric.matching_filter`}]:[])]); }
    catch(error) { if(error instanceof FilterExpressionError) throw new RollupError('INVALID_PARAMS',error.message,error.details);throw error; }
  }
  let bytes = Infinity;
  try {
    bytes = Buffer.byteLength(canonicalJson(input), 'utf8');
  } catch {
    /* Rejected below. */
  }
  if (bytes > 65536)
    throw new RollupError(
      'INVALID_PARAMS',
      'Relationship definitions exceed 64 KiB or are not JSON.',
    );
  const parsed = relationshipViewsSchema.safeParse(input);
  if (!parsed.success)
    throw new RollupError(
      'INVALID_PARAMS',
      'Invalid relationship definition shape, version or limit.',
    );
  for (const values of [parsed.data.relations, parsed.data.rollups])
    if (new Set(values.map((v) => v.name)).size !== values.length)
      throw new RollupError('INVALID_PARAMS', 'Saved names must be unique.');
  return parsed.data as RelationshipViews;
}
export function validateSavedRelation(
  db: Database.Database,
  relation: SavedRelation,
  rollup?: SavedRollup,
) {
  return validateSummaryRequest(
    db,
    parseSummaryRequest({
      relations: [
        {
          as: 'saved',
          direction: relation.direction,
          field: relation.field,
          filter: { ...relation.filter, ...rollup?.filter },
          metrics: [
            rollup
              ? { as: 'value', ...rollup.metric }
              : { as: 'count', op: 'count' },
          ],
        },
      ],
    }),
  ).definitions[0];
}
export function describeRelationshipViews(
  db: Database.Database,
  schema: string,
): RelationshipViewsDiscovery {
  const row = db
    .prepare('SELECT metadata FROM schemas WHERE name=?')
    .get(schema) as { metadata: string | null } | undefined;
  if (!row) throw new RollupError('NOT_FOUND', 'Rollup schema not found.');
  const raw = namespace(
    row.metadata === null ? null : JSON.parse(row.metadata),
  );
  const result: RelationshipViewsDiscovery = {
    schema,
    relationship_views_hash: relationshipViewsHash(raw),
    state: raw === undefined ? 'absent' : 'valid',
    relations: [],
    rollups: [],
  };
  if (raw === undefined) return result;
  const version =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.hasOwn(raw, 'version')
      ? (raw as { version: unknown }).version
      : undefined;
  if (
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > 0 &&
    version !== 1
  ) {
    result.state = 'unsupported';
    result.error = 'Unsupported relationship definition version.';
    return result;
  }
  let views: RelationshipViews;
  try {
    views = parseRelationshipViews(raw);
  } catch (e) {
    result.state = 'invalid';
    result.error = e instanceof Error ? e.message : 'Invalid definitions.';
    return result;
  }
  result.relations = views.relations.map((definition) => {
    try {
      validateSavedRelation(db, definition);
      return { definition, state: 'valid' as const };
    } catch (e) {
      return {
        definition,
        state: 'invalid' as const,
        error: e instanceof Error ? e.message : 'Invalid relation.',
      };
    }
  });
  result.rollups = views.rollups.map((definition) => {
    try {
      const relation = views.relations.find(
        (r) => r.name === definition.relation,
      );
      if (!relation) throw new Error('Unknown saved relation.');
      const metric = validateSavedRelation(db, relation, definition).metrics[0];
      return {
        definition,
        state: 'valid' as const,
        type: metric.type,
        nullable: metric.nullable,
        ...(metric.op === 'percentage' ? {unit:metric.unit} : {}),
        ...(hasDateWindows(definition.filter ?? {}) || (metric.op === 'percentage' && hasDateWindows(metric.matching_filter)) ? {requires_evaluation_context:true} : {}),
      };
    } catch (e) {
      return {
        definition,
        state: 'invalid' as const,
        error: e instanceof Error ? e.message : 'Invalid rollup.',
      };
    }
  });
  if (
    [...result.relations, ...result.rollups].some((r) => r.state === 'invalid')
  )
    result.state = 'invalid';
  return result;
}
