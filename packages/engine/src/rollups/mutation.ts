import { filterLeaves } from '../filters/expression.js';
import type Database from 'better-sqlite3';
import {
  canonicalJson,
  namespace,
  parseRelationshipViews,
  relationshipViewsHash,
  RollupError,
  validateSavedRelation,
  VIEWS_KEY,
} from './definitions.js';
import type { RelationshipViews, SavedRelation } from './types.js';
import { captureSchemaSnapshot } from '../undo/schema-snapshot.js';
export interface RelationshipViewsMutationInput {
  metadata?: unknown;
  relationship_views?: unknown;
  expected_relationship_views_hash?: string;
}
export function relationshipViewsDiff(
  before: unknown,
  after: unknown,
): {
  added: string[];
  changed: string[];
  removed: string[];
  references: Record<string, string[]>;
} {
  const entries = (value: unknown) => {
    let v: RelationshipViews;
    try {
      v = parseRelationshipViews(value);
    } catch {
      return new Map<string, unknown>();
    }
    return new Map<string, unknown>([
      ...v.relations.map((r) => ['relation:' + r.name, r] as [string, unknown]),
      ...v.rollups.map((r) => ['rollup:' + r.name, r] as [string, unknown]),
    ]);
  };
  const old = entries(before),
    next = entries(after),
    references: Record<string, string[]> = {};
  for (const [name, value] of next)
    if (name.startsWith('rollup:'))
      references[name] = [
        'relation:' + (value as { relation: string }).relation,
      ];
  return {
    added: [...next.keys()].filter((k) => !old.has(k)),
    removed: [...old.keys()].filter((k) => !next.has(k)),
    changed: [...next.keys()].filter(
      (k) =>
        old.has(k) && canonicalJson(old.get(k)) !== canonicalJson(next.get(k)),
    ),
    references,
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const relationExecution = (relation: SavedRelation) => {
  const { label: _label, description: _description, ...execution } = relation;
  return execution;
};
export function normalizeRelationshipViewsMutation(
  db: Database.Database,
  currentMetadata: unknown,
  input: RelationshipViewsMutationInput,
  creating = false,
): unknown {
  if (object(input.metadata) && ['enum_groups','enum_groups_override'].some(key=>Object.hasOwn(input.metadata as object,key))) throw new RollupError('INVALID_PARAMS','Use typed enum group properties, not raw schema metadata.');
  const old = namespace(currentMetadata),
    hasTyped = input.relationship_views !== undefined;
  if (object(input.metadata) && Object.hasOwn(input.metadata, VIEWS_KEY))
    throw new RollupError(
      'INVALID_PARAMS',
      'Use relationship_views, not reserved raw metadata.',
    );
  if (!hasTyped) {
    if (input.metadata === undefined) return currentMetadata;
    if (old === undefined) return input.metadata;
    if (!object(input.metadata))
      throw new RollupError(
        'INVALID_PARAMS',
        'Metadata containing relationship definitions must remain an object.',
      );
    return { ...input.metadata, [VIEWS_KEY]: old };
  }
  if (
    !creating &&
    input.expected_relationship_views_hash !== relationshipViewsHash(old)
  )
    throw new RollupError(
      'CONFLICT',
      'Relationship definitions changed; rediscover before updating.',
      { reason: 'STALE_RELATIONSHIP_VIEWS' },
    );
  const base = input.metadata === undefined ? currentMetadata : input.metadata;
  if (input.relationship_views === null) {
    // Removal preserves legacy metadata or an explicit replacement of any shape.
    if (!object(base)) return base;
    const result = { ...base };
    delete result[VIEWS_KEY];
    return result;
  }
  if (base !== undefined && base !== null && !object(base))
    throw new RollupError(
      'INVALID_PARAMS',
      'Cannot attach definitions to non-object metadata.',
    );
  if (input.metadata === null)
    throw new RollupError(
      'INVALID_PARAMS',
      'Relationship definitions require object metadata.',
    );
  const result = { ...(object(base) ? base : {}) };
  delete result[VIEWS_KEY];
  const views = parseRelationshipViews(input.relationship_views);
  let previous: RelationshipViews | undefined;
  try {
    if (old !== undefined) previous = parseRelationshipViews(old);
  } catch {
    /* Replacement can repair invalid storage. */
  }
  const equal = (a: unknown, b: unknown) =>
    a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b);
  for (const relation of views.relations) {
    const prior = previous?.relations.find((r) => r.name === relation.name);
    if (!equal(prior, relation)) validateSavedRelation(db, relation);
  }
  for (const rollup of views.rollups) {
    const relation = views.relations.find((r) => r.name === rollup.relation);
    const prior = previous?.rollups.find((r) => r.name === rollup.name),
      priorRelation = previous?.relations.find(
        (r) => r.name === rollup.relation,
      );
    const unchangedRelation =
      priorRelation === relation ||
      (priorRelation !== undefined && relation !== undefined &&
        equal(relationExecution(priorRelation), relationExecution(relation)));
    if (equal(prior, rollup) && unchangedRelation) continue;
    if (!relation)
      throw new RollupError('INVALID_PARAMS', 'Unknown saved relation.', {
        rollup: rollup.name,
      });
    validateSavedRelation(db, relation, rollup);
  }
  result[VIEWS_KEY] = views;
  return result;
}
/** Called inside the governed field-rename transaction; exports happen after commit. */
export function renameRelationshipViewFields(
  db: Database.Database,
  oldName: string,
  newName: string,
  operationId: string,
): string[] {
  const changed: string[] = [];
  const rows = db
    .prepare('SELECT name,metadata FROM schemas ORDER BY name')
    .all() as Array<{ name: string; metadata: string | null }>;
  for (const row of rows) {
    const metadata = row.metadata === null ? null : JSON.parse(row.metadata),
      raw = namespace(metadata);
    if (raw === undefined) continue;
    let views: RelationshipViews;
    try {
      views = parseRelationshipViews(raw);
    } catch {
      continue;
    }
    let touched = false;
    for (const relation of views.relations)
      if (relation.field === oldName) {
        relation.field = newName;
        touched = true;
      }
    for (const rollup of views.rollups) {
      if ((rollup.metric.op === 'min' || rollup.metric.op === 'max') && rollup.metric.field === oldName) {
        rollup.metric.field = newName;
        touched = true;
      }
      for (const fields of [rollup.filter ?? {}, ...(rollup.metric.op === 'percentage' ? [rollup.metric.matching_filter] : [])].flatMap(filter=>[...filterLeaves(filter)].map(leaf=>leaf.fields))) {
      if (fields && Object.hasOwn(fields, oldName)) {
        if (Object.hasOwn(fields, newName))
          throw new RollupError(
            'CONFLICT',
            'Field rename would overwrite a saved predicate.',
            { schema: row.name, rollup: rollup.name },
          );
        Object.defineProperty(fields, newName, {
          value: fields[oldName],
          enumerable: true,
          writable: true,
          configurable: true,
        });
        delete fields[oldName];
        touched = true;
      }
      }
    }
    if (!touched) continue;
    // Enforce storage limits even when the new field name is longer.
    parseRelationshipViews(views);
    captureSchemaSnapshot(db, operationId, row.name);
    db.prepare('UPDATE schemas SET metadata=? WHERE name=?').run(
      JSON.stringify({ ...metadata, [VIEWS_KEY]: views }),
      row.name,
    );
    changed.push(row.name);
  }
  return changed;
}
