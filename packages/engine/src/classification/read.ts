import type Database from 'better-sqlite3';
import { getGlobalField } from '../global-fields/crud.js';
import { resolveFieldValue, type FieldRow } from '../fields/project.js';
import { classifyEnumValue, resolveEnumGroups, type ResolveEnumGroupsInput } from './resolver.js';
import { ClassificationError, type ClassificationContext, type ClassificationDependency, type ClassificationOutcome, type EffectiveEnumGroups, type StoredEnumValue } from './types.js';

export function loadClassificationInput(db: Database.Database, context: ClassificationContext): ResolveEnumGroupsInput {
  const field = getGlobalField(db, context.field);
  const claim = db.prepare('SELECT enum_values_override, enum_groups_override FROM schema_field_claims WHERE schema_name=? AND field=?').get(context.schema, context.field) as {enum_values_override:string|null; enum_groups_override:string|null} | undefined;
  if (!field || !claim) throw new ClassificationError('CLASSIFICATION_INVALID_CONFIG', 'Schema must claim the requested field.', context);
  return { context, fieldType: field.field_type, globalValues: field.enum_values, typeValues: claim.enum_values_override ? JSON.parse(claim.enum_values_override) : null, globalGroups: field.enum_groups ?? null, override: claim.enum_groups_override ? JSON.parse(claim.enum_groups_override) : null, overrideAllowed: field.overrides_allowed.enum_groups === true };
}
export interface ClassificationReadContext {
  resolve(context: ClassificationContext): EffectiveEnumGroups;
  dependencies(): ClassificationDependency[];
}
export function createClassificationReadContext(db: Database.Database): ClassificationReadContext {
  const cache = new Map<string, EffectiveEnumGroups>();
  return {
    resolve(context) {
      if (!db.inTransaction) throw new Error('Classification reads require an active snapshot.');
      const key = JSON.stringify([context.schema, context.field]);
      let result = cache.get(key);
      if (!result) { result = resolveEnumGroups(loadClassificationInput(db, context)); cache.set(key, result); }
      return result;
    },
    dependencies: () => [...cache.values()].map(({schema,field,execution_hash}) => ({schema,field,execution_hash})).sort((a,b) => JSON.stringify([a.schema,a.field]).localeCompare(JSON.stringify([b.schema,b.field]))),
  };
}
export function readStoredEnumValue(db: Database.Database, nodeId: string, field: string): StoredEnumValue {
  if (db.prepare('SELECT 1 FROM node_explicit_null_fields WHERE node_id=? AND field_name=?').get(nodeId, field)) return {kind:'null'};
  const row = db.prepare('SELECT * FROM node_fields WHERE node_id=? AND field_name=?').get(nodeId, field) as FieldRow | undefined;
  if (!row) return {kind:'missing'};
  return decodeStoredEnumValue(row);
}
/** Preserve malformed legacy JSON without interpreting its raw bytes as an enum string. */
export function decodeStoredEnumValue(row: FieldRow | undefined, explicitNull = false): StoredEnumValue {
  if (explicitNull) return {kind:'null'};
  if (!row) return {kind:'missing'};
  let value: unknown;
  try { value = resolveFieldValue(row); }
  catch { return {kind:'value',value:{value_json:row.value_json}}; }
  return value === null ? {kind:'null'} : {kind:'value',value};
}
export interface ClassifyNodesInput extends ClassificationContext { node_ids: string[] }
export interface ClassifyNodesResult { context: ClassificationContext; execution_hash: string; results: ({node_id:string} & ClassificationOutcome)[] }
export function classifyNodes(db: Database.Database, input: ClassifyNodesInput): ClassifyNodesResult {
  if (!Array.isArray(input.node_ids) || input.node_ids.length < 1 || input.node_ids.length > 200 || new Set(input.node_ids).size !== input.node_ids.length || input.node_ids.some(id => typeof id !== 'string' || !id)) throw new Error('Expected 1–200 distinct nonempty node IDs.');
  return db.transaction(() => {
    const context = {schema:input.schema,field:input.field};
    const definition = createClassificationReadContext(db).resolve(context);
    const results = input.node_ids.map(node_id => {
      if (!db.prepare('SELECT 1 FROM nodes WHERE id=?').get(node_id)) return {node_id,state:'missing_node' as const};
      if (!db.prepare('SELECT 1 FROM node_types WHERE node_id=? AND schema_type=?').get(node_id,input.schema)) return {node_id,state:'not_applicable' as const};
      return {node_id,...classifyEnumValue(definition,readStoredEnumValue(db,node_id,input.field))};
    });
    return {context,execution_hash:definition.execution_hash,results};
  }).deferred();
}
