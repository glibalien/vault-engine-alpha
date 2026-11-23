import { beforeEach, afterEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb, seedNode, seedRel, summaryRequest } from '../helpers/summary-fixture.js';
import { parseSummaryRequest, validateSummaryRequest } from '../../src/summaries/input.js';
import { readParents, readEdges, readMatchingRelatedIds, readSelectedFields, hasUnresolvedField } from '../../src/summaries/read.js';
let db: Database.Database;
beforeEach(() => { db = makeSummaryDb(); });
afterEach(() => db.close());
it('selects parent metadata with type intersection and caller ID restrictions', () => {
    expect(readParents(db, { types: ['project'] }).map(n => n.id)).toEqual(['P1', 'P2', 'P3']);
    expect(readParents(db, { types: ['project', 'task'] })).toEqual([]);
    expect(readMatchingRelatedIds(db, ['T1', 'T2'], { node_ids: ['T2', 'T3'] })).toEqual(new Set(['T2']));
    expect(readMatchingRelatedIds(db, ['T1', 'T2'], { fields: { status: { eq: 'open' } } })).toEqual(new Set(['T1']));
});
it('counts raw edges before duplicates and filters, with direction-specific endpoints', () => {
    const r = validateSummaryRequest(db, parseSummaryRequest(summaryRequest())).definitions[0];
    seedRel(db, 'T1', 'alternate spelling', 'P1');
    expect(readEdges(db, ['P1'], r, 4)).toHaveLength(4);
    expect(() => readEdges(db, ['P1'], r, 3)).toThrow();
    expect(readEdges(db, ['T2'], { ...r, direction: 'outgoing' }, 2)).toEqual([
        { parent_id: 'T2', related_id: 'P1' }, { parent_id: 'T2', related_id: 'P2' },
    ]);
    expect(readEdges(db, ['T5'], { ...r, direction: 'outgoing' }, 1)).toEqual([{ parent_id: 'T5', related_id: null }]);
});
it('projects absence, explicit null, boolean and date storage without bodies', () => {
    const values = readSelectedFields(db, ['T1', 'T4', 'T6'], ['due', 'flag']);
    expect(values.get('T1')).toEqual({ due: '2026-09-20', flag: true });
    expect(values.get('T4')).toEqual({});
    expect(values.get('T6')).toEqual({ due: null });
    expect(readParents(db, { node_ids: ['T1'] })[0]).not.toHaveProperty('body');
    expect(hasUnresolvedField(db, 'project')).toBe(true);
    expect(hasUnresolvedField(db, 'owner')).toBe(false);
});
it('fails at the parent capacity instead of returning an inexact population', () => {
    db.transaction(() => { for (let i = 3; i < 10000; i++)
        seedNode(db, `p-${i}`, ['project']); })();
    expect(readParents(db, { types: ['project'] })).toHaveLength(10000);
    seedNode(db, 'overflow', ['project']);
    expect(() => readParents(db, { types: ['project'] })).toThrow();
});
it('accepts exactly 100000 raw rows and rejects the next before deduplication', () => {
    const r = validateSummaryRequest(db, parseSummaryRequest(summaryRequest())).definitions[0];
    db.transaction(() => {
        const insert = db.prepare("INSERT INTO relationships (source_id,target,resolved_target_id,rel_type) VALUES ('T1',?,'P3','project')");
        for (let i = 0; i < 100000; i++)
            insert.run(`raw-${i}`);
    })();
    expect(readEdges(db, ['P3'], r, 100000)).toHaveLength(100000);
    seedRel(db, 'T1', 'overflow', 'P3');
    expect(() => readEdges(db, ['P3'], r, 100000)).toThrow(expect.objectContaining({ details: { reason: 'QUERY_LIMIT_EXCEEDED', stage: 'relationships', limit: 100000, observed_at_least: 100001 } }));
});
it('projects dates from the legacy date column as well as the text column', () => {
    db.prepare("UPDATE node_fields SET value_date=value_text,value_text=NULL WHERE node_id='T1' AND field_name='due'").run();
    expect(readSelectedFields(db, ['T1', 'T2'], ['due'])).toEqual(new Map([['T1', { due: '2026-09-20' }], ['T2', { due: '2026-09-18' }]]));
});
