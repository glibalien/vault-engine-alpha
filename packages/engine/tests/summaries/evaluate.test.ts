import { describe, expect, it } from 'vitest';
import { metricValue, compareSummaryRows, projectLookup } from '../../src/summaries/evaluate.js';
import type { SummaryMetricDefinition, SummaryRow } from '../../src/summaries/types.js';
const date: SummaryMetricDefinition = { as: 'd', op: 'min', field: 'due', type: 'date', nullable: true, date_mode: 'calendar_date' };
const num: SummaryMetricDefinition = { as: 'n', op: 'max', field: 'estimate', type: 'number', nullable: true };
describe('summary evaluation', () => {
    it('counts distinct identities independently of field values', () => {
        expect(metricValue({ as: 'c', op: 'count', type: 'integer', nullable: false }, new Set(['a', 'b', 'a']), new Map())).toBe(2);
        expect(metricValue(date, new Set(), new Map())).toBe(null);
    });
    it.each(['2026-09-18', '2026-09-18T23:59:59-12:00', '2026-09-18 00:00+14:00', '2026-09-18T01:00'])('uses written calendar date for %s', value => {
        expect(metricValue(date, new Set(['a', 'b', 'c']), new Map([['a', { due: value }], ['b', { due: null }], ['c', {}]]))).toBe('2026-09-18');
    });
    it('handles negative and fractional extrema', () => {
        const fields = new Map([['a', { estimate: -1.5 }], ['b', { estimate: -2.5 }]]);
        expect(metricValue(num, new Set(fields.keys()), fields)).toBe(-1.5);
        expect(metricValue({ ...num, op: 'min' }, new Set(fields.keys()), fields)).toBe(-2.5);
    });
    it.each(['2026-02-30', true, {}, 12])('rejects malformed non-null date %j', value => {
        expect(() => metricValue(date, new Set(['a']), new Map([['a', { due: value }]]))).toThrow();
    });
    it.each(['2', Infinity, NaN])('rejects malformed numeric value %j', value => {
        expect(() => metricValue(num, new Set(['a']), new Map([['a', { estimate: value }]]))).toThrow();
    });
    it('orders nulls last in descending metric sort and breaks ties by UTF-8 ID', () => {
        const row = (id: string, value: number | null): SummaryRow => ({ node: { id, title: id, file_path: id, version: 1 }, relations: { r: { metrics: { m: value } } } });
        const rows = [row('a', null), row('b', 2), row('c', 3), row('d', 2)];
        rows.sort((a, b) => compareSummaryRows(a, b, { by: 'metric', relation: 'r', metric: 'm', order: 'desc' }));
        expect(rows.map(r => r.node.id)).toEqual(['c', 'b', 'd', 'a']);
        const unicode = [row('\u{10000}', 2), row('\uE000', 2)];
        unicode.sort((a, b) => compareSummaryRows(a, b, { by: 'id', order: 'asc' }));
        expect(unicode.map(r => r.node.id)).toEqual(['\uE000', '\u{10000}']);
    });
    it('reports lookup totals separately from the bounded emitted items', () => {
        const ids = new Set(['c', 'a', 'b']);
        const identities = new Map([...ids].map(id => [id, { id, title: id, file_path: id, version: 1 }]));
        const result = projectLookup(ids, identities, new Map([['a', {}], ['b', { due: null }], ['c', { due: '2026-09-20' }]]), { fields: [{ name: 'due', type: 'date' }], limit: 2 });
        expect(result).toMatchObject({ total: 3, returned: 2, truncated: true });
        expect(result.items.map(i => i.fields)).toEqual([{}, { due: null }]);
    });
});
it('validates only emitted lookup values and rejects invalid scalar booleans', () => {
    const identities = new Map(['a', 'b'].map(id => [id, { id, title: id, file_path: id, version: 1 }]));
    const fields = new Map([['a', { flag: true }], ['b', { flag: 'true' }]] as Array<[
        string,
        Record<string, unknown>
    ]>);
    expect(projectLookup(new Set(['b', 'a']), identities, fields, { fields: [{ name: 'flag', type: 'boolean' }], limit: 1 }).items[0].fields).toEqual({ flag: true });
    expect(() => projectLookup(new Set(['b', 'a']), identities, fields, { fields: [{ name: 'flag', type: 'boolean' }], limit: 2 })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', details: { reason: 'INVALID_LOOKUP_VALUE', field: 'flag', affected_count: 1 } }));
});
it('keeps missing titles last and uses stable IDs as the final title tie break', () => {
    const rows: SummaryRow[] = ['c', 'b', 'a'].map(id => ({ node: { id, title: id === 'c' ? null : 'same', file_path: id, version: 1 }, relations: {} }));
    rows.sort((a, b) => compareSummaryRows(a, b, { by: 'title', order: 'desc' }));
    expect(rows.map(r => r.node.id)).toEqual(['a', 'b', 'c']);
});
