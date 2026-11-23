import type { ClassificationReadContext } from '../classification/read.js';
import { dateWindowMatches } from './temporal.js';
import { normalizeSummaryFilter, projectStatic, evaluateFilterSet, temporalValidationGates, type SummaryFilterNode } from './filter-expression.js';
import type Database from 'better-sqlite3';
import { buildFilterClauses } from '../mcp/query-builder.js';
import { projectFieldValues, type FieldRow } from '../fields/project.js';
import { createFieldMap } from '../fields/field-map.js';
import { capacity, invalid } from './errors.js';
import { splitDateWindows, filterCalendarIds, type StaticSummaryFilter } from './temporal-read.js';
import { SUMMARY_LIMITS } from './input.js';
import type { EvaluationContext, SummaryDefinition, SummaryFilter, SummaryIdentity } from './types.js';
export interface SummaryEdge {
    parent_id: string;
    related_id: string | null;
}
function* batches(ids: readonly string[]) {
    for (let i = 0; i < ids.length; i += 200)
        yield ids.slice(i, i + 200);
}
const slots = (ids: readonly unknown[]) => ids.map(() => '?').join(',');
function summaryFilterClauses(db: Database.Database, filter: StaticSummaryFilter, classification?: ClassificationReadContext) {
    const clauses = buildFilterClauses(filter, 'n', { n: 0 }, db, classification);
    for (const [field, predicate] of Object.entries(filter.fields ?? {})) {
        // Explicit null overrides legacy stored values for comparisons. Keep the
        // established row-presence semantics of exists filters unchanged.
        if ('exists' in predicate || 'is_unclassified' in predicate || 'in_group' in predicate) continue;
        clauses.whereClauses.push('NOT EXISTS (SELECT 1 FROM node_explicit_null_fields z WHERE z.node_id=n.id AND z.field_name=?)');
        clauses.whereParams.push(field);
    }
    return clauses;
}
function staticExpressionSql(db: Database.Database, node: SummaryFilterNode, classification?: ClassificationReadContext): {
  sql: string;
  params: unknown[];
} {
  if (node.kind === 'true')
    return { sql: '1', params: [] };
  if (node.kind === 'date')
    throw new Error('Temporal atom reached static compiler');
  if (node.kind === 'static') {
    const c = summaryFilterClauses(db, node.filter as StaticSummaryFilter, classification);
    return { sql: `n.id IN (SELECT n.id FROM nodes n ${c.joins.join(' ')}${c.whereClauses.length ? ' WHERE ' + c.whereClauses.join(' AND ') : ''})`, params: [...c.joinParams, ...c.whereParams] };
  }
  const children = node.children.map(child => staticExpressionSql(db, child, classification));
  return { sql: `(${children.map(c => c.sql).join(node.kind === 'all' ? ' AND ' : ' OR ')})`, params: children.flatMap(c => c.params) };
}

function expressionIds(db: Database.Database, ids: readonly string[], node: SummaryFilterNode, context?: EvaluationContext, classification?: ClassificationReadContext): Set<string> {
  const universe = new Set(ids);
  const cache = new Map<SummaryFilterNode, Set<string>>();
  const matchStatic = (atom: Extract<SummaryFilterNode, {
    kind: 'static' | 'date';
  }>): ReadonlySet<string> => {
    if (atom.kind === 'date')
      return cache.get(atom)!;
    if (!cache.has(atom))
      cache.set(atom, readMatchingRelatedIds(db, ids, atom.filter, context, classification));
    return cache.get(atom)!;
  };
  const gates = temporalValidationGates(node);
  if (gates.length && !context)
    invalid('Relative-date predicates require evaluation_context.time_zone.');
  // Validate all relevant values before evaluating any OR branch's success.
  for (const { atom, gate } of gates) {
    const eligible = evaluateFilterSet(gate, universe, matchStatic);
    const fields = readSelectedFields(db, [...eligible], [atom.field]);
    const matched = new Set<string>();
    for (const id of eligible) {
      const row = fields.get(id);
      const value = row && Object.hasOwn(row, atom.field) ? row[atom.field] : undefined;
      if (dateWindowMatches(value, atom.window, context!, { field: atom.field, node_id: id }))
        matched.add(id);
    }
    cache.set(atom, matched);
  }
  return evaluateFilterSet(node, universe, matchStatic);
}

export function readParents(db: Database.Database, filter: SummaryFilter, context?: EvaluationContext, classification?: ClassificationReadContext): SummaryIdentity[] {
    if(filter.where) {
        const node=normalizeSummaryFilter(filter),c=staticExpressionSql(db,projectStatic(node),classification);
        const rows=db.prepare(`SELECT DISTINCT n.id,n.title,n.file_path,n.version FROM nodes n WHERE ${c.sql} LIMIT ?`).all(...c.params,SUMMARY_LIMITS.parents+1) as SummaryIdentity[];
        if(rows.length>SUMMARY_LIMITS.parents) capacity('parents',SUMMARY_LIMITS.parents,rows.length);
        const matched=expressionIds(db,rows.map(r=>r.id),node,context,classification);
        return rows.filter(r=>matched.has(r.id));
    }
    const {ordinary,windows}=splitDateWindows(filter);
    const c = summaryFilterClauses(db, ordinary, classification);
    const where = c.whereClauses.length ? ` WHERE ${c.whereClauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT DISTINCT n.id,n.title,n.file_path,n.version FROM nodes n ${c.joins.join(' ')}${where} LIMIT ?`)
        .all(...c.joinParams, ...c.whereParams, SUMMARY_LIMITS.parents + 1) as SummaryIdentity[];
    if (rows.length > SUMMARY_LIMITS.parents)
        capacity('parents', SUMMARY_LIMITS.parents, rows.length);
    if (!Object.keys(windows).length) return rows;
    if (!context) invalid('Relative-date predicates require evaluation_context.time_zone.');
    const ids=rows.map(r=>r.id);
    const eligible=filterCalendarIds(ids,windows,readSelectedFields(db,ids,Object.keys(windows)),context);
    return rows.filter(r=>eligible.has(r.id));
}
export function readEdges(db: Database.Database, parents: readonly string[], relation: SummaryDefinition, remaining: number): SummaryEdge[] {
    const parentCol = relation.direction === 'incoming' ? 'resolved_target_id' : 'source_id';
    const relatedCol = relation.direction === 'incoming' ? 'source_id' : 'resolved_target_id';
    const edges: SummaryEdge[] = [];
    for (const batch of batches(parents)) {
        const rows = db.prepare(`SELECT ${parentCol} AS parent_id,${relatedCol} AS related_id FROM relationships
      WHERE rel_type=? AND ${parentCol} IN (${slots(batch)}) LIMIT ?`).all(relation.field, ...batch, remaining - edges.length + 1) as SummaryEdge[];
        if (edges.length + rows.length > remaining)
            capacity('relationships', SUMMARY_LIMITS.edges, SUMMARY_LIMITS.edges + 1);
        for (const row of rows)
            edges.push(row);
    }
    return edges;
}
export function readMatchingRelatedIds(db: Database.Database, ids: readonly string[], filter: SummaryFilter, context?: EvaluationContext, classification?: ClassificationReadContext): Set<string> {
    if(filter.where) return expressionIds(db,ids,normalizeSummaryFilter(filter),context,classification);
    const {ordinary,windows}=splitDateWindows(filter);
    const result = new Set<string>();
    const c = summaryFilterClauses(db, ordinary, classification);
    for (const batch of batches(ids)) {
        const wheres = [...c.whereClauses, `n.id IN (${slots(batch)})`];
        const rows = db.prepare(`SELECT DISTINCT n.id FROM nodes n ${c.joins.join(' ')} WHERE ${wheres.join(' AND ')}`)
            .all(...c.joinParams, ...c.whereParams, ...batch) as Array<{
            id: string;
        }>;
        for (const r of rows)
            result.add(r.id);
    }
    if (!Object.keys(windows).length) return result;
    if (!context) invalid('Relative-date predicates require evaluation_context.time_zone.');
    return filterCalendarIds([...result],windows,readSelectedFields(db,[...result],Object.keys(windows)),context);
}
export function readSelectedFields(db: Database.Database, ids: readonly string[], fields: readonly string[]): Map<string, Record<string, unknown>> {
    const result = new Map<string, Record<string, unknown>>();
    for (const id of ids)
        result.set(id, {});
    if (!fields.length)
        return result;
    for (const batch of batches(ids)) {
        const predicate = `node_id IN (${slots(batch)}) AND field_name IN (${slots(fields)})`;
        const rows = db.prepare(`SELECT node_id,field_name,value_text,value_number,value_date,value_json,source FROM node_fields WHERE ${predicate}`)
            .all(...batch, ...fields) as Array<FieldRow & {
            node_id: string;
        }>;
        const markers = db.prepare(`SELECT node_id,field_name FROM node_explicit_null_fields WHERE ${predicate}`)
            .all(...batch, ...fields) as Array<{
            node_id: string;
            field_name: string;
        }>;
        const byId = new Map(batch.map(id => [id, [] as FieldRow[]]));
        const nulls = new Map(batch.map(id => [id, [] as string[]]));
        for (const r of rows)
            byId.get(r.node_id)!.push(r);
        for (const r of markers)
            nulls.get(r.node_id)!.push(r.field_name);
        for (const id of batch) {
            const nodeRows = byId.get(id)!;
            const nodeNulls = nulls.get(id)!;
            try {
                result.set(id, projectFieldValues(nodeRows, nodeNulls));
            }
            catch (error) {
                if (!(error instanceof SyntaxError))
                    throw error;
                // Preserve invalid stored JSON as a non-scalar sentinel. The evaluator
                // reports the appropriate aggregate/lookup failure with affected counts.
                // Project each row using the usual null-marker precedence.
                const values = createFieldMap<unknown>();
                for (const row of nodeRows) {
                    try {
                        Object.assign(values, projectFieldValues([row], nodeNulls));
                    }
                    catch (error) {
                        if (!(error instanceof SyntaxError))
                            throw error;
                        values[row.field_name] = Symbol('invalid stored JSON');
                    }
                }
                result.set(id, values);
            }
        }
    }
    return result;
}
export function readIdentities(db: Database.Database, ids: readonly string[]): Map<string, SummaryIdentity> {
    const result = new Map<string, SummaryIdentity>();
    for (const batch of batches(ids)) {
        const rows = db.prepare(`SELECT id,title,file_path,version FROM nodes WHERE id IN (${slots(batch)})`).all(...batch) as SummaryIdentity[];
        for (const row of rows)
            result.set(row.id, row);
    }
    return result;
}
export function hasUnresolvedField(db: Database.Database, field: string): boolean {
    return !!db.prepare('SELECT 1 FROM relationships WHERE rel_type=? AND resolved_target_id IS NULL LIMIT 1').get(field);
}
