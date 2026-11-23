import type Database from 'better-sqlite3';
import type { ClassificationContext } from './types.js';
export interface EnumGroupReference { schema: string; path: string; group: string | null }
/** Scan only the governed saved-definition namespace, including nested percentage filters. */
export function findEnumGroupReferences(db: Database.Database, context: ClassificationContext, group?: string): EnumGroupReference[] {
  const found: EnumGroupReference[] = [];
  for (const row of db.prepare('SELECT name,metadata FROM schemas WHERE metadata IS NOT NULL').all() as {name:string;metadata:string}[]) {
    const metadata = JSON.parse(row.metadata);
    function visit(value: unknown, path: string): void {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach((v,i)=>visit(v,`${path}[${i}]`)); return; }
      const obj = value as Record<string,unknown>;
      const fields = obj.fields as Record<string, {in_group?:{schema:string;group:string};is_unclassified?:{schema:string}}> | undefined;
      if (fields && Object.hasOwn(fields,context.field)) {
        const predicate = fields[context.field];
        if (predicate.in_group?.schema === context.schema && (group === undefined || predicate.in_group.group === group)) found.push({schema:row.name,path:`${path}.fields.${context.field}.in_group`,group:predicate.in_group.group});
        if (group === undefined && predicate.is_unclassified?.schema === context.schema) found.push({schema:row.name,path:`${path}.fields.${context.field}.is_unclassified`,group:null});
      }
      for (const [key,child] of Object.entries(obj)) visit(child,`${path}.${key}`);
    }
    visit(metadata.relationship_views_v1,'relationship_views_v1');
  }
  return found;
}
