import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb, summaryRequest } from '../helpers/summary-fixture.js';
import { parseSummaryRequest, validateSummaryRequest } from '../../src/summaries/input.js';
let db: Database.Database;
beforeEach(() => { db = makeSummaryDb(); });
afterEach(() => db.close());
function validate(input: unknown) { return validateSummaryRequest(db, parseSummaryRequest(input)); }
describe('summary input', () => {
    it('supplies bounded defaults and typed metric definitions', () => {
        const r = validate(summaryRequest());
        expect(r.request).toMatchObject({ limit: 50, offset: 0, sort: { by: 'title', order: 'asc' } });
        expect(r.definitions[1].metrics[1]).toMatchObject({ type: 'date', nullable: true, date_mode: 'calendar_date' });
    });
    it.each([
        ['status', { eq: 'open' }], ['status', { ne: 'retired' }], ['status', { one_of: ['retired'] }],
        ['estimate', { eq: 1 }], ['estimate', { ne: 1 }], ['estimate', { gt: 1 }], ['estimate', { gte: 1 }], ['estimate', { lt: 1 }], ['estimate', { lte: 1 }], ['estimate', { one_of: [1, 2] }],
        ['label', { eq: 'a' }], ['label', { ne: 'a' }], ['label', { one_of: ['a'] }],
        ['due', { eq: '2026-09-18' }], ['due', { ne: '2026-09-18T12:00-04:00' }],
        ['tags', { includes: 'a' }], ['scores', { includes: 1 }], ['flag', { exists: true }], ['owner', { exists: false }], ['flags', { exists: false }],
    ])('accepts supported %s predicate %j', (field, predicate) => {
        expect(() => validate({ ...summaryRequest(), filter: { fields: { [field]: predicate } } })).not.toThrow();
    });
    it.each([
        ['status', { eq: 1 }], ['status', { one_of: [] }], ['status', { eq: 'open', ne: 'done' }],
        ['estimate', { eq: '1' }], ['estimate', { eq: Infinity }], ['estimate', { one_of: [1, '2'] }],
        ['due', { one_of: ['2026-09-18'] }], ['due', { eq: '2026-02-30' }], ['due', { gt: '2026-09-18' }],
        ['flag', { eq: true }], ['owner', { eq: 'P1' }], ['flags', { includes: true }], ['tags', { eq: ['a'] }],
        ['scores', { includes: '1' }], ['status', { eq: null }], ['missing', { exists: true }], ['status', {}],
    ])('rejects unsupported %s predicate %j', (field, predicate) => {
        expect(() => validate({ ...summaryRequest(), filter: { fields: { [field]: predicate } } })).toThrow();
    });
    it.each([
        { query: 'tasks' }, { filter: { node_ids: [] } }, { filter: { types: ['unknown'] } }, { limit: 101 }, { offset: 10001 },
        { relations: [] }, { full_text: 'abc' },
    ])('rejects unsupported shape or bound %j', patch => {
        expect(() => validate({ ...summaryRequest(), ...patch })).toThrow();
    });
    it('rejects ambiguous extrema and bad lookup types', () => {
        const req = summaryRequest();
        req.relations[1].metrics = [{ as: 'date', op: 'min', field: 'due' }];
        expect(() => validate(req)).toThrow();
        req.relations[1].metrics = [{ as: 'num', op: 'min', field: 'estimate', date_mode: 'calendar_date' }];
        expect(() => validate(req)).toThrow();
        req.relations[1].metrics = [];
        req.relations[1].lookup = { fields: ['project'] };
        expect(() => validate(req)).toThrow();
    });
    it('preserves prototype-sensitive field names', () => {
        const req = summaryRequest();
        req.filter = { fields: JSON.parse('{"__proto__":{"eq":2}}') };
        const r = validate(req);
        expect(Object.hasOwn(r.request.filter.fields!, '__proto__')).toBe(true);
    });
    it('rejects duplicate or reserved aliases and metrics on unknown relations', () => {
        const req = summaryRequest();
        req.relations[1].as = 'all_tasks';
        expect(() => validate(req)).toThrow();
        req.relations[1].as = 'constructor';
        expect(() => validate(req)).toThrow();
        const r = summaryRequest();
        r.sort = { by: 'metric', relation: 'missing', metric: 'count', order: 'desc' };
        expect(() => validate(r)).toThrow();
    });
    it('rejects outputless relations and oversized requests', () => {
        expect(() => validate({ relations: [{ as: 'r', field: 'project', direction: 'outgoing' }] })).toThrow();
        expect(() => validate({ ...summaryRequest(), extra: 'x'.repeat(65536) })).toThrow();
    });
});
it.each([
    ['node_ids', 200], ['without_node_ids', 200], ['types', 10], ['without_types', 10],
] as const)('bounds %s arrays before contextual validation', (key, limit) => {
    expect(() => parseSummaryRequest({ ...summaryRequest(), filter: { [key]: Array(limit).fill('task') } })).not.toThrow();
    expect(() => parseSummaryRequest({ ...summaryRequest(), filter: { [key]: Array(limit + 1).fill('task') } })).toThrow();
});
it('bounds predicates, filter fields, strings and the shared metric population', () => {
    const fields = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { exists: true }]));
    expect(() => parseSummaryRequest({ ...summaryRequest(), filter: { fields } })).not.toThrow();
    expect(() => parseSummaryRequest({ ...summaryRequest(), filter: { fields: { ...fields, extra: { exists: false } } } })).toThrow();
    for (const length of [100, 101]) {
        const run = () => validate({ ...summaryRequest(), filter: { fields: { status: { one_of: Array(length).fill('open') } } } });
        if (length === 100)
            expect(run).not.toThrow();
        else
            expect(run).toThrow();
    }
    expect(() => validate({ ...summaryRequest(), filter: { title_contains: 'a'.repeat(1024) } })).not.toThrow();
    expect(() => validate({ ...summaryRequest(), filter: { title_contains: 'a'.repeat(1025) } })).toThrow();
    const relations = Array.from({ length: 4 }, (_, i) => ({ as: `r${i}`, direction: 'incoming', field: 'project', metrics: [{ as: 'a', op: 'count' }, { as: 'b', op: 'count' }] }));
    expect(() => validate({ relations })).not.toThrow();
    expect(() => validate({ relations: [...relations, { ...relations[0], as: 'fifth' }] })).toThrow();
    relations[0].metrics.push({ as: 'c', op: 'count' });
    expect(() => validate({ relations })).toThrow();
});
it('bounds lookup fields/items and metric aliases independently', () => {
    const relation = { as: 'r', direction: 'incoming', field: 'project', lookup: { fields: ['status', 'due', 'flag', 'label', 'estimate'], limit: 10 } };
    expect(() => validate({ relations: [relation], limit: 100, offset: 10000 })).not.toThrow();
    expect(() => validate({ relations: [{ ...relation, lookup: { ...relation.lookup, limit: 11 } }] })).toThrow();
    expect(() => validate({ relations: [{ ...relation, lookup: { fields: [...relation.lookup.fields, 'status'] } }] })).toThrow();
    expect(() => validate({ relations: [{ ...relation, metrics: [{ as: 'n', op: 'count' }, { as: 'n', op: 'count' }] }] })).toThrow();
    expect(() => validate({ relations: [{ ...relation, metrics: [{ as: 'n', op: 'count', field: 'estimate' }] }] })).toThrow();
});
it('checks actual UTF-8 request bytes at the boundary', () => {
    const request = { ...summaryRequest(), filter: { node_ids: Array(200).fill('a'.repeat(300)), title_eq: '' } };
    const shortfall = 65536 - Buffer.byteLength(JSON.stringify(request));
    // Spread padding across individually bounded scalar values to retain a valid shape.
    for (let i = 0, remaining = shortfall; remaining > 0; i++) {
        const n = Math.min(700, remaining);
        request.filter.node_ids[i] += 'a'.repeat(n);
        remaining -= n;
    }
    expect(Buffer.byteLength(JSON.stringify(request))).toBe(65536);
    expect(() => parseSummaryRequest(request)).not.toThrow();
    request.filter.title_eq = 'é';
    expect(() => parseSummaryRequest(request)).toThrow();
});
