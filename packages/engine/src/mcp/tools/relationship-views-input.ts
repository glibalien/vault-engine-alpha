import { z } from 'zod';
import { relationshipViewsSchema } from '../../rollups/definitions.js';

/**
 * Input schema for the schema-write tools that accept `relationship_views`.
 *
 * The SDK boundary keeps `relationship_views` lenient (`unknown`) so governed
 * validation (`parseRelationshipViews`) returns domain error envelopes, while the
 * advertised JSON Schema carries the strict relationship-views contract.
 *
 * The advertisement is generated with `reused: 'ref'`, like query-nodes,
 * summarize-nodes and read-rollups: the finite-depth filter expressions repeat
 * one subschema at every all/any level, and inlining those copies made each
 * schema tool's listing roughly 90 KB.
 */
export function relationshipViewsToolInput<S extends z.ZodRawShape>(
  shape: S,
  relationshipViews: { description: string; allowRemoval?: boolean },
) {
  const strict = relationshipViews.allowRemoval ? relationshipViewsSchema.nullable() : relationshipViewsSchema;
  const advertisedSchema = z.object({
    ...shape,
    relationship_views: strict.optional().describe(relationshipViews.description),
  });
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(advertisedSchema, {
    io: 'input',
    target: 'draft-7',
    reused: 'ref',
  });
  return z.object({
    ...shape,
    relationship_views: z.unknown().optional().describe(relationshipViews.description),
  }).meta(advertised);
}
