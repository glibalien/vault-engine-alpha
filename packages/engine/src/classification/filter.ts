import type Database from 'better-sqlite3';
import { loadClassificationInput, type ClassificationReadContext } from './read.js';
import { resolveEnumGroups } from './resolver.js';
import { ClassificationError, type EffectiveEnumGroups } from './types.js';
export interface GroupPredicate { in_group?:{schema:string;group:string};is_unclassified?:{schema:string} }
export function resolveClassificationPredicate(db:Database.Database,field:string,ops:GroupPredicate,read?:ClassificationReadContext):EffectiveEnumGroups {
  const operand=ops.in_group??ops.is_unclassified!;
  const context={schema:operand.schema,field};
  const definition=read?read.resolve(context):resolveEnumGroups(loadClassificationInput(db,context));
  if(ops.in_group && !definition.enum_groups.groups.some(g=>g.name===ops.in_group!.group)) throw new ClassificationError('CLASSIFICATION_INVALID_CONFIG','Unknown enum group.',{...context,group:ops.in_group.group});
  return definition;
}
export function classificationSql(db:Database.Database|undefined,field:string,ops:GroupPredicate,alias:string,read?:ClassificationReadContext):{sql:string;params:unknown[]} {
  if(!db || !read) throw new ClassificationError('CLASSIFICATION_INVALID_CONFIG','Group predicates are read-only and require a classification snapshot.');
  const definition=resolveClassificationPredicate(db,field,ops,read);
  const values=ops.in_group?definition.enum_groups.groups.find(g=>g.name===ops.in_group!.group)!.values:[...new Set(definition.enum_groups.groups.flatMap(g=>g.values))];
  const sql=`EXISTS (SELECT 1 FROM node_types ct WHERE ct.node_id=${alias}.id AND ct.schema_type=?) AND ${ops.is_unclassified?'NOT ':''}EXISTS (SELECT 1 FROM node_fields cf WHERE cf.node_id=${alias}.id AND cf.field_name=? AND NOT EXISTS (SELECT 1 FROM node_explicit_null_fields cn WHERE cn.node_id=${alias}.id AND cn.field_name=cf.field_name) AND (CASE WHEN cf.value_json IS NOT NULL THEN CASE WHEN json_valid(cf.value_json) AND json_type(cf.value_json)='text' THEN json_extract(cf.value_json,'$') END WHEN cf.value_number IS NOT NULL THEN NULL ELSE COALESCE(cf.value_date,cf.value_text) END) IN (SELECT value FROM json_each(?)))`;
  return {sql:`(${sql})`,params:[definition.schema,field,JSON.stringify(values)]};
}
