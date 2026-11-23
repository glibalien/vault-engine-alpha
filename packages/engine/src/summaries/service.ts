import { createClassificationReadContext } from '../classification/read.js';
import type Database from 'better-sqlite3';
import { requestNeedsEvaluationContext, resolveEvaluationContext } from './temporal.js';
import { percentageOf } from './percentage.js';
import { createFieldMap } from '../fields/field-map.js';
import { ok, type Issue } from '../mcp/tools/errors.js';
import { capacity, SummaryError } from './errors.js';
import { binaryCompare, compareSummaryRows, metricValue, projectLookup } from './evaluate.js';
import { parseSummaryRequest, SUMMARY_LIMITS, validateSummaryRequest } from './input.js';
import { hasUnresolvedField, readEdges, readIdentities, readMatchingRelatedIds, readParents, readSelectedFields } from './read.js';
import type { PercentageDetails, SummaryData, SummaryRow } from './types.js';
/** The serialized result is bounded here and emitted unchanged by the MCP handler. */
export function summarizeNodes(db: Database.Database, input: unknown): ReturnType<typeof ok<SummaryData>> {
    return db.transaction(() => {
        const { data, warnings } = evaluateSummaryInSnapshot(db, input);
        const result = ok(data, warnings);
        const bytes = Buffer.byteLength(result.content[0].text, 'utf8');
        if (bytes > SUMMARY_LIMITS.responseBytes)
            capacity('response_bytes', SUMMARY_LIMITS.responseBytes, bytes);
        return result;
    }).deferred();
}
/** Caller holds a read transaction spanning definition resolution and bounds its public envelope. */
export function evaluateSummaryInSnapshot(db: Database.Database, input: unknown): { data: SummaryData; warnings: Issue[] } {
    if (!db.inTransaction) throw new Error("Summary core requires a read transaction.");
    const classification = createClassificationReadContext(db);
    const request = parseSummaryRequest(input);
    const { definitions } = validateSummaryRequest(db, request, classification);
    const context = resolveEvaluationContext(request.evaluation_context, requestNeedsEvaluationContext(request));
    const parents = readParents(db, request.filter, context, classification);
    const parentIds = parents.map(p => p.id);
    const rows: SummaryRow[] = parents.map(node => ({ node, relations: createFieldMap() }));
    const memberships = new Map<string, Map<string, Set<string>>>();
    const warnings: Issue[] = [];
    const unresolved = new Map<string, boolean>();
    let remaining: number = SUMMARY_LIMITS.edges;
    for (const definition of definitions) {
        const edges = readEdges(db, parentIds, definition, remaining);
        remaining -= edges.length;
        const ids = [...new Set(edges.flatMap(e => e.related_id === null ? [] : [e.related_id]))];
        const eligible = readMatchingRelatedIds(db, ids, definition.filter, context, classification);
        const members = new Map(parentIds.map(id => [id, new Set<string>()]));
        for (const edge of edges)
            if (edge.related_id !== null && eligible.has(edge.related_id))
                members.get(edge.parent_id)!.add(edge.related_id);
        memberships.set(definition.as, members);
        const names = [...new Set(definition.metrics.flatMap(m => m.op === 'min' || m.op === 'max' ? [m.field] : []))];
        const fields = readSelectedFields(db, [...eligible], names);
        const matches = new Map<string, Set<string>>();
        for (const metric of definition.metrics) if (metric.op === 'percentage')
            matches.set(metric.as, readMatchingRelatedIds(db, [...eligible], metric.matching_filter, context, classification));
        for (const row of rows) {
            const details = createFieldMap<PercentageDetails>();
            const metrics = createFieldMap<number | string | null>();
            try {
                for (const metric of definition.metrics) {
                    if (metric.op === 'percentage') {
                        const result = percentageOf(members.get(row.node.id)!, matches.get(metric.as)!);
                        metrics[metric.as] = result.value;
                        details[metric.as] = result.details;
                    } else metrics[metric.as] = metricValue(metric, members.get(row.node.id)!, fields);
                }
            }
            catch (error) {
                if (error instanceof SummaryError)
                    throw new SummaryError(error.code, error.message, { ...error.details, relation: definition.as, parent_id: row.node.id });
                throw error;
            }
            row.relations[definition.as] = { metrics, ...(Object.keys(details).length ? {metric_details:details} : {}) };
        }
        if (!unresolved.has(definition.field))
            unresolved.set(definition.field, hasUnresolvedField(db, definition.field));
        if (unresolved.get(definition.field))
            warnings.push({
                code: 'CROSS_NODE_FILTER_UNRESOLVED', severity: 'warning',
                message: 'Unresolved references exist for this field; summaries include resolved memberships only. The warning scope is vault-wide.',
                details: { relation: definition.as, field: definition.field, scope: 'vault_rel_type' },
            });
    }
    rows.sort((a, b) => compareSummaryRows(a, b, request.sort));
    const page = rows.slice(request.offset, request.offset + request.limit);
    for (const definition of definitions) {
        if (!definition.lookup)
            continue;
        const lookup = definition.lookup;
        const members = memberships.get(definition.as)!;
        const ids = [...new Set(page.flatMap(row => [...members.get(row.node.id)!].sort(binaryCompare).slice(0, lookup.limit)))];
        const identities = readIdentities(db, ids);
        const fields = readSelectedFields(db, ids, lookup.fields.map(f => f.name));
        const truncated: string[] = [];
        for (const row of page) {
            try {
                const projected = projectLookup(members.get(row.node.id)!, identities, fields, lookup);
                row.relations[definition.as].lookup = projected;
                if (projected.truncated)
                    truncated.push(row.node.id);
            }
            catch (error) {
                if (error instanceof SummaryError)
                    throw new SummaryError(error.code, error.message, { ...error.details, relation: definition.as, parent_id: row.node.id });
                throw error;
            }
        }
        if (truncated.length)
            warnings.push({ code: 'RESULT_TRUNCATED', severity: 'warning', message: 'Related lookup items were limited; totals and metrics remain exact.', details: { relation: definition.as, parent_ids: truncated } });
    }
    const dependencies=classification.dependencies();
    const data: SummaryData = { ...(dependencies.length ? {classification_dependencies:dependencies} : {}), kind: 'node_summaries', version: 1, ...(context ? {evaluation_context:context} : {}), definitions, rows: page, page: {
            total: rows.length, returned: page.length, limit: request.limit, offset: request.offset,
            has_more: request.offset + page.length < rows.length,
        } };
    return { data, warnings };
}
