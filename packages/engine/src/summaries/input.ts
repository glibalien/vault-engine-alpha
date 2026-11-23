import { classificationOperatorShape } from '../classification/input.js';
import { resolveClassificationPredicate } from '../classification/filter.js';
import type { ClassificationReadContext } from '../classification/read.js';
import { assertExpressionBudget, FilterExpressionError, type FilterScope, filterLeaves } from '../filters/expression.js';
import { expressionSchema } from '../filters/expression-schema.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fieldRecordSchema } from '../mcp/field-record-schema.js';
import { isStrictIsoDateString } from '../validation/date.js';
import { invalid, SummaryError } from './errors.js';
import { dateWindowSchema, evaluationContextSchema } from './temporal.js';
import type { SummaryRequest, SummaryFilter, SummaryDefinition, SummaryMetricDefinition, SummaryLookupDefinition, SummaryRelation, SummarySort } from './types.js';
export const SUMMARY_LIMITS = { requestBytes: 65536, parents: 10000, edges: 100000, responseBytes: 1048576 } as const;
const text = z.string().max(1024);
const name = text.min(1);
const alias = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .refine(v => v !== 'constructor' && v !== 'prototype', 'Reserved alias');
const scalar = z.union([text, z.number().finite()]);
const predicate = z.object({
    ...classificationOperatorShape,
    date_window: dateWindowSchema.optional(),
    eq: scalar.optional(), ne: scalar.optional(),
    gt: z.number().finite().optional(), gte: z.number().finite().optional(),
    lt: z.number().finite().optional(), lte: z.number().finite().optional(),
    one_of: z.array(scalar).min(1).max(100).optional(), includes: scalar.optional(), exists: z.boolean().optional(),
}).strict().refine(v => Object.keys(v).length === 1, 'Exactly one field operator is required');
export const summaryLeafSchema = z.object({
    node_ids: z.array(name).min(1).max(200).optional(), without_node_ids: z.array(name).min(1).max(200).optional(),
    types: z.array(name).min(1).max(10).optional(), without_types: z.array(name).min(1).max(10).optional(),
    fields: fieldRecordSchema(predicate).refine(v => Object.keys(v).length <= 10, 'At most ten fields').optional(),
    title_eq: text.optional(), title_contains: text.optional(), path_prefix: text.optional(),
}).strict();
export const filterSchema = summaryLeafSchema.extend({where: expressionSchema(summaryLeafSchema).optional().describe('AND/OR read filters via all/any; 2–8 children, depth 4. Outer flat keys AND with where. Shared request caps: 64 expression nodes, 128 predicates, 512 scalar operands, 16 KiB where JSON. Every date_window requires the shared evaluation context.')});
const fieldsLeafSchema = summaryLeafSchema.pick({fields:true});
export const summaryFieldsFilterSchema = fieldsLeafSchema.extend({where:expressionSchema(fieldsLeafSchema).optional()});
export function summaryFilterScopes(input: unknown): FilterScope[] {
  const r = input as Partial<SummaryRequest> | null;
  return [{ filter: r?.filter, profile: 'summary', path: 'filter' }, ...Array.isArray(r?.relations) ? r.relations.flatMap((rel, i): FilterScope[] => [{ filter: rel?.filter, profile: 'summary', path: `relations[${i}].filter` }, ...Array.isArray(rel?.metrics) ? rel.metrics.flatMap((m, j): FilterScope[] => m?.op === 'percentage' ? [{ filter: m.matching_filter, profile: 'fields', path: `relations[${i}].metrics[${j}].matching_filter` }] : []) : []]) : []];
}

const metricSchema = z.discriminatedUnion('op', [
    z.object({as: alias, op: z.literal('percentage'), matching_filter: summaryFieldsFilterSchema}).strict(),
    z.object({ as: alias, op: z.literal('count') }).strict(),
    z.object({ as: alias, op: z.literal('min'), field: name, date_mode: z.literal('calendar_date').optional() }).strict(),
    z.object({ as: alias, op: z.literal('max'), field: name, date_mode: z.literal('calendar_date').optional() }).strict(),
]);
const relationSchema = z.object({
    as: alias, direction: z.enum(['incoming', 'outgoing']), field: name,
    filter: filterSchema.default({}), metrics: z.array(metricSchema).max(8).default([]),
    lookup: z.object({ fields: z.array(name).max(5).default([]), limit: z.number().int().min(1).max(10).default(5) }).strict().optional(),
}).strict().refine(v => v.metrics.length > 0 || v.lookup !== undefined, 'A metric or lookup is required');
const order = z.enum(['asc', 'desc']);
export const summaryRequestSchema = z.object({
    evaluation_context: evaluationContextSchema.optional(),
    filter: filterSchema.default({}), relations: z.array(relationSchema).min(1).max(4),
    sort: z.union([
        z.object({ by: z.enum(['id', 'title']), order }).strict(),
        z.object({ by: z.literal('metric'), relation: alias, metric: alias, order }).strict(),
    ]).default({ by: 'title', order: 'asc' }),
    limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(10000).default(0),
}).strict();
export interface NormalizedSummaryRequest extends SummaryRequest {
    filter: SummaryFilter;
    sort: SummarySort;
    limit: number;
    offset: number;
    relations: Array<SummaryRelation & {
        filter: SummaryFilter;
        metrics: NonNullable<SummaryRelation['metrics']>;
    }>;
}
export interface ValidatedSummary {
    request: NormalizedSummaryRequest;
    definitions: SummaryDefinition[];
}
interface FieldDefinition {
    name: string;
    field_type: string;
    list_item_type: string | null;
}
export function parseSummaryRequest(input: unknown): NormalizedSummaryRequest {
    try { assertExpressionBudget(summaryFilterScopes(input)); } catch(error) { if(error instanceof FilterExpressionError) throw new SummaryError('INVALID_PARAMS',error.message,error.details); throw error; }
    let json: string | undefined;
    try {
        json = JSON.stringify(input);
    }
    catch {
        invalid('Summary arguments must be JSON.');
    }
    if (json === undefined || Buffer.byteLength(json, 'utf8') > SUMMARY_LIMITS.requestBytes)
        invalid('Summary request exceeds the byte limit or is not JSON.');
    // Zod omits some prototype keys. Reject unknown top-level keys before parsing.
    if (input && typeof input === 'object' && Object.keys(input).some(k => !['filter', 'relations', 'sort', 'limit', 'offset', 'evaluation_context'].includes(k)))
        invalid('Unknown summary argument.');
    const parsed = summaryRequestSchema.safeParse(input);
    if (!parsed.success)
        invalid('Invalid summary request shape, operand or limit.');
    return parsed.data as NormalizedSummaryRequest;
}
export function validateSummaryRequest(db: Database.Database, request: NormalizedSummaryRequest, classification?: ClassificationReadContext): ValidatedSummary {
    const cache = new Map<string, FieldDefinition>();
    const getField = (name: string): FieldDefinition => {
        if (cache.has(name))
            return cache.get(name)!;
        const f = db.prepare('SELECT name,field_type,list_item_type FROM global_fields WHERE name=?').get(name) as FieldDefinition | undefined;
        if (!f)
            invalid(`Unknown summary field: ${name}`);
        cache.set(name, f);
        return f;
    };
    const validateLeaf = (filter: SummaryFilter) => {
        for (const type of [...filter.types ?? [], ...filter.without_types ?? []]) {
            if (!db.prepare('SELECT 1 FROM schemas WHERE name=?').get(type))
                invalid(`Unknown summary type: ${type}`);
        }
        for (const [name, predicate] of Object.entries(filter.fields ?? {})) {
            const f = getField(name);
            const [op, value] = Object.entries(predicate)[0];
            if (op === 'date_window') {
                if (f.field_type !== 'date') invalid(`Date windows require a date field: ${name}`);
                continue;
            }
            if ('in_group' in predicate || 'is_unclassified' in predicate) {
                resolveClassificationPredicate(db,name,predicate,classification); continue;
            }
            if (op === 'exists')
                continue;
            const values = op === 'one_of' ? value as unknown[] : [value];
            const kind = f.field_type === 'list' ? f.list_item_type : f.field_type;
            const allowed = f.field_type === 'list' ? op === 'includes' && ['string', 'enum', 'number'].includes(kind!)
                : kind === 'number' ? ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'one_of'].includes(op)
                    : kind === 'string' || kind === 'enum' ? ['eq', 'ne', 'one_of'].includes(op)
                        : kind === 'date' ? ['eq', 'ne'].includes(op) : false;
            if (!allowed || !values.every(v => kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
                : typeof v === 'string' && (kind !== 'date' || isStrictIsoDateString(v))))
                invalid(`Unsupported predicate for field: ${name}`);
        }
    };
    const validateFilter = (filter: SummaryFilter) => { for(const leaf of filterLeaves(filter)) validateLeaf(leaf); };
    validateFilter(request.filter);
    if (new Set(request.relations.map(r => r.as)).size !== request.relations.length)
        invalid('Relation aliases must be unique.');
    if (request.relations.reduce((n, r) => n + r.metrics.length, 0) > 8)
        invalid('At most eight metrics are allowed.');
    const definitions = request.relations.map((r): SummaryDefinition => {
        const field = getField(r.field);
        if (!(field.field_type === 'reference' || field.field_type === 'list' && field.list_item_type === 'reference') || r.field === 'wiki-link')
            invalid('Traversal requires a structured reference field.');
        validateFilter(r.filter);
        if (new Set(r.metrics.map(m => m.as)).size !== r.metrics.length)
            invalid('Metric aliases must be unique.');
        const metrics = r.metrics.map((m): SummaryMetricDefinition => {
            if (m.op === 'percentage') {
                validateFilter(m.matching_filter);
                return { ...m, type: 'number', nullable: true, unit: 'percent' };
            }
            if (m.op === 'count')
                return { ...m, type: 'integer', nullable: false };
            const f = getField(m.field);
            if (f.field_type !== 'number' && f.field_type !== 'date')
                invalid('Extrema require a number or date field.');
            if (f.field_type === 'date' ? m.date_mode !== 'calendar_date' : m.date_mode !== undefined)
                invalid('Date extrema require calendar_date; numeric extrema do not accept a date mode.');
            return { ...m, type: f.field_type, nullable: true };
        });
        const result: SummaryDefinition = { as: r.as, direction: r.direction, field: r.field, filter: r.filter, metrics };
        if (r.lookup) {
            result.lookup = { limit: r.lookup.limit!, fields: [...new Set(r.lookup.fields)].map(name => {
                    const f = getField(name);
                    if (!['string', 'enum', 'number', 'boolean', 'date'].includes(f.field_type))
                        invalid('Lookup projection requires scalar fields.');
                    return { name, type: f.field_type as SummaryLookupDefinition['fields'][number]['type'] };
                }) };
        }
        return result;
    });
    if (request.sort.by === 'metric') {
        const sort = request.sort;
        if (!definitions.find(r => r.as === sort.relation)?.metrics.some(m => m.as === sort.metric))
            invalid('Metric sort must name a requested metric.');
    }
    return { request, definitions };
}
