import { beforeEach, afterEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb, seedRel, summaryRequest } from '../helpers/summary-fixture.js';
import { summarizeNodes } from '../../src/summaries/service.js';
import type { SummaryData, SummaryRequest } from '../../src/summaries/types.js';
let db: Database.Database;
beforeEach(() => { db = makeSummaryDb(); });
afterEach(() => db.close());
function run(request: SummaryRequest = summaryRequest()) {
    return JSON.parse(summarizeNodes(db, request).content[0].text) as {
        ok: true;
        data: SummaryData;
        warnings: Array<{
            code: string;
            details: Record<string, unknown>;
        }>;
    };
}
it('returns hand-checked totals, minima and lookup completeness through duplicate paths', () => {
    seedRel(db, 'T1', 'alternate', 'P1');
    const r = run();
    expect(r.data.rows.map(row => [row.node.id, row.relations.all_tasks.metrics.count, row.relations.outstanding_tasks.metrics.count, row.relations.outstanding_tasks.metrics.next_due]))
        .toEqual([['P1', 3, 2, '2026-09-18'], ['P2', 3, 3, '2026-09-18'], ['P3', 0, 0, null]]);
    expect(r.data.rows[1].relations.outstanding_tasks.lookup).toMatchObject({ total: 3, returned: 2, truncated: true });
    expect(r.data.rows[1].relations.outstanding_tasks.lookup!.items.map(i => i.id)).toEqual(['T2', 'T4']);
    expect(r.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'RESULT_TRUNCATED', details: { relation: 'outstanding_tasks', parent_ids: ['P2'] } }),
        expect.objectContaining({ code: 'CROSS_NODE_FILTER_UNRESOLVED', details: { relation: 'all_tasks', field: 'project', scope: 'vault_rel_type' } }),
    ]));
    expect(JSON.stringify(r)).not.toContain('PRIVATE BODY');
});
it('sorts metrics before paging and returns exact parent totals on empty later pages', () => {
    const req = summaryRequest();
    req.limit = 1;
    req.sort = { by: 'metric', relation: 'outstanding_tasks', metric: 'count', order: 'desc' };
    const r = run(req);
    expect(r.data.rows.map(row => row.node.id)).toEqual(['P2']);
    expect(r.data.page).toEqual({ total: 3, returned: 1, limit: 1, offset: 0, has_more: true });
    req.offset = 3;
    expect(run(req).data.page).toEqual({ total: 3, returned: 0, limit: 1, offset: 3, has_more: false });
});
it('looks up multiple project statuses from a task with no editable computed fields', () => {
    const r = run({ filter: { node_ids: ['T2'] }, relations: [{ as: 'projects', direction: 'outgoing', field: 'project', lookup: { fields: ['status'] } }] });
    expect(r.data.rows[0].relations.projects.lookup!.items.map(i => [i.id, i.fields.status])).toEqual([['P1', 'open'], ['P2', 'pending']]);
    expect(r.data.rows[0]).not.toHaveProperty('fields');
    expect(r.data.rows[0].relations.projects.metrics).toEqual({});
});
it('retains conservative unresolved warnings when no parents match', () => {
    const req = summaryRequest();
    req.filter = { node_ids: ['missing'] };
    const r = run(req);
    expect(r.data.rows).toEqual([]);
    expect(r.warnings.filter(w => w.code === 'CROSS_NODE_FILTER_UNRESOLVED')).toHaveLength(2);
});
it('rejects invalid values outside the returned page instead of giving partial exact metrics', () => {
    db.prepare("UPDATE node_fields SET value_text='INVALID PRIVATE' WHERE node_id='T2' AND field_name='due'").run();
    const req = summaryRequest();
    req.limit = 1;
    req.offset = 2;
    try {
        run(req);
        throw new Error('expected rejection');
    }
    catch (e) {
        expect(e).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'INVALID_AGGREGATE_VALUE', relation: 'outstanding_tasks', field: 'due' } });
        expect(JSON.stringify(e)).not.toContain('INVALID PRIVATE');
    }
});
it('fails response byte overflow without truncating metric populations', () => {
    db.prepare('UPDATE nodes SET title=? WHERE id=?').run('x'.repeat(1048576), 'P1');
    expect(() => run()).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS', details: expect.objectContaining({ stage: 'response_bytes', limit: 1048576 }) }));
});
it('counts every descriptor against the shared raw-edge budget', () => {
    db.transaction(() => {
        const stmt = db.prepare("INSERT INTO relationships (source_id,target,resolved_target_id,rel_type) VALUES ('T1',?,'P1','project')");
        for (let i = 0; i < 50000; i++)
            stmt.run(`variant-${i}`);
    })();
    const req = summaryRequest();
    req.filter = { node_ids: ['P1'] };
    expect(() => run(req)).toThrow();
    req.relations = req.relations.slice(0, 1);
    expect(run(req).data.rows[0].relations.all_tasks.metrics.count).toBe(3);
});
it('does not mutate nodes, fields, relationships, versions or SQLite total_changes', () => {
    const state = () => ['nodes', 'node_fields', 'node_explicit_null_fields', 'relationships'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const before = state();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    run();
    expect(state()).toEqual(before);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
});
it('reports malformed stored JSON as a validation failure without disclosing values', () => {
    db.prepare("UPDATE node_fields SET value_json='INVALID PRIVATE' WHERE node_id='T2' AND field_name='due'").run();
    expect(() => run()).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', details: expect.objectContaining({ reason: 'INVALID_AGGREGATE_VALUE', field: 'due' }) }));
});
it('retains null-marker precedence over a malformed legacy row', () => {
    db.prepare("INSERT INTO node_fields (node_id,field_name,value_json,source) VALUES ('T6','due','INVALID PRIVATE','frontmatter')").run();
    const req = summaryRequest();
    req.relations[1].lookup!.limit = 3;
    expect(run(req).data.rows[1].relations.outstanding_tasks.lookup!.items[2].fields.due).toBeNull();
});
it('supports self memberships and stable identities after rename and deletion', () => {
    seedRel(db, 'P1', 'P1', 'P1');
    const req: SummaryRequest = { filter: { node_ids: ['P1'] }, relations: [{ as: 'r', direction: 'incoming', field: 'project', metrics: [{ as: 'n', op: 'count' }], lookup: {} }] };
    expect(run(req).data.rows[0].relations.r.metrics.n).toBe(4);
    db.prepare("UPDATE nodes SET title='Renamed',file_path='Renamed.md' WHERE id='T1'").run();
    expect(run(req).data.rows[0].relations.r.lookup!.items.find(i => i.id === 'T1')).toMatchObject({ title: 'Renamed', file_path: 'Renamed.md' });
    db.prepare("DELETE FROM nodes WHERE id='T1'").run();
    expect(run(req).data.rows[0].relations.r.metrics.n).toBe(3);
});
it('preserves the existing row-presence semantics for exists filters', () => {
    const req: SummaryRequest = { filter: { node_ids: ['P2'] }, relations: [{ as: 'r', direction: 'incoming', field: 'project', filter: { fields: { due: { exists: false } } }, metrics: [{ as: 'n', op: 'count' }] }] };
    expect(run(req).data.rows[0].relations.r.metrics.n).toBe(2); // absent T4 and null marker T6
});
it('remains read-only when aggregate validation fails', () => {
    db.prepare("UPDATE node_fields SET value_text='bad' WHERE node_id='T2' AND field_name='due'").run();
    const before = db.prepare('SELECT total_changes() AS n').get();
    expect(() => run()).toThrow();
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});
