import { createFieldMap } from '../fields/field-map.js';
import { isStrictIsoDateString } from '../validation/date.js';
import { SummaryError } from './errors.js';
import type { SummaryIdentity, SummaryLookup, SummaryLookupDefinition, SummaryMetricDefinition, SummaryRow, SummaryScalar, SummarySort } from './types.js';
export function binaryCompare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
export function metricValue(metric: Exclude<SummaryMetricDefinition, {op: 'percentage'}>, ids: ReadonlySet<string>, fields: ReadonlyMap<string, Record<string, unknown>>): number | string | null {
    if (metric.op === 'count')
        return ids.size;
    let value: number | string | null = null;
    let invalidCount = 0;
    for (const id of ids) {
        const row = fields.get(id);
        const raw = row && Object.hasOwn(row, metric.field) ? row[metric.field] : undefined;
        if (raw === null || raw === undefined)
            continue;
        let candidate: number | string;
        if (metric.type === 'number' && typeof raw === 'number' && Number.isFinite(raw))
            candidate = raw;
        else if (metric.type === 'date' && typeof raw === 'string' && isStrictIsoDateString(raw))
            candidate = raw.trim().slice(0, 10);
        else {
            invalidCount++;
            continue;
        }
        if (value === null || (metric.op === 'min' ? candidate < value : candidate > value))
            value = candidate;
    }
    if (invalidCount)
        throw new SummaryError('VALIDATION_FAILED', 'Invalid stored aggregate value.', {
            reason: 'INVALID_AGGREGATE_VALUE', metric: metric.as, field: metric.field, affected_count: invalidCount,
        });
    return value;
}
export function compareSummaryRows(a: SummaryRow, b: SummaryRow, sort: SummarySort): number {
    const av = sort.by === 'metric' ? a.relations[sort.relation].metrics[sort.metric] : a.node[sort.by];
    const bv = sort.by === 'metric' ? b.relations[sort.relation].metrics[sort.metric] : b.node[sort.by];
    if (av === null && bv !== null)
        return 1;
    if (bv === null && av !== null)
        return -1;
    const comparison = av === null || bv === null ? 0 : typeof av === 'number' && typeof bv === 'number' ? av - bv : binaryCompare(String(av), String(bv));
    return comparison ? (sort.order === 'asc' ? comparison : -comparison) : binaryCompare(a.node.id, b.node.id);
}
function validScalar(value: unknown, type: SummaryLookupDefinition['fields'][number]['type']): value is SummaryScalar {
    if (value === null)
        return true;
    if (type === 'number')
        return typeof value === 'number' && Number.isFinite(value);
    if (type === 'boolean')
        return typeof value === 'boolean';
    return typeof value === 'string' && (type !== 'date' || isStrictIsoDateString(value));
}
export function projectLookup(ids: ReadonlySet<string>, identities: ReadonlyMap<string, SummaryIdentity>, fields: ReadonlyMap<string, Record<string, unknown>>, lookup: SummaryLookupDefinition): SummaryLookup {
    const selected = [...ids].sort(binaryCompare).slice(0, lookup.limit);
    for (const field of lookup.fields) {
        const invalidCount = selected.filter(id => {
            const row = fields.get(id);
            return row && Object.hasOwn(row, field.name) && !validScalar(row[field.name], field.type);
        }).length;
        if (invalidCount)
            throw new SummaryError('VALIDATION_FAILED', 'Invalid stored lookup value.', {
                reason: 'INVALID_LOOKUP_VALUE', field: field.name, affected_count: invalidCount,
            });
    }
    const items = selected.map(id => {
        const identity = identities.get(id);
        if (!identity)
            throw new Error('Missing summary lookup identity within read snapshot.');
        const values = createFieldMap<SummaryScalar>();
        const row = fields.get(id);
        for (const field of lookup.fields)
            if (row && Object.hasOwn(row, field.name))
                values[field.name] = row[field.name] as SummaryScalar;
        return { ...identity, fields: values };
    });
    return { items, total: ids.size, returned: items.length, truncated: items.length < ids.size };
}
