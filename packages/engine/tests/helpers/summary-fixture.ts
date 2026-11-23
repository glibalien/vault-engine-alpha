import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForResolvedTargetId } from '../../src/db/migrate.js';
import { classifyValue } from '../../src/pipeline/classify-value.js';
import type { SummaryRequest } from '../../src/summaries/types.js';
export function makeSummaryDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    upgradeForResolvedTargetId(db);
    seedSummaryFixture(db);
    return db;
}
export function seedNode(db: Database.Database, id: string, types: string[], fields: Record<string, unknown> = {}): void {
    db.prepare('INSERT INTO nodes (id,title,file_path,body) VALUES (?,?,?,?)').run(id, id, `${id}.md`, 'PRIVATE BODY');
    for (const type of types)
        db.prepare('INSERT INTO node_types (node_id,schema_type) VALUES (?,?)').run(id, type);
    for (const [name, value] of Object.entries(fields)) {
        if (value === null) {
            db.prepare('INSERT INTO node_explicit_null_fields (node_id,field_name) VALUES (?,?)').run(id, name);
        }
        else {
            const c = classifyValue(value);
            db.prepare('INSERT INTO node_fields (node_id,field_name,value_text,value_number,value_date,value_json,source) VALUES (?,?,?,?,?,?,?)')
                .run(id, name, c.value_text, c.value_number, c.value_date, c.value_json, 'frontmatter');
        }
    }
}
export function seedRel(db: Database.Database, source: string, target: string, resolved: string | null, field = 'project'): void {
    db.prepare('INSERT INTO relationships (source_id,target,resolved_target_id,rel_type) VALUES (?,?,?,?)').run(source, target, resolved, field);
}
export function seedSummaryFixture(db: Database.Database): void {
    for (const name of ['project', 'task'])
        db.prepare('INSERT INTO schemas (name) VALUES (?)').run(name);
    for (const [name, type, item] of [
        ['project', 'list', 'reference'], ['status', 'enum', null], ['due', 'date', null],
        ['estimate', 'number', null], ['flag', 'boolean', null], ['label', 'string', null],
        ['tags', 'list', 'string'], ['scores', 'list', 'number'], ['owner', 'reference', null],
        ['flags', 'list', 'boolean'], ['__proto__', 'number', null],
    ])
        db.prepare('INSERT INTO global_fields (name,field_type,list_item_type) VALUES (?,?,?)').run(name, type, item);
    for (const p of ['P1', 'P2', 'P3'])
        seedNode(db, p, ['project'], { status: p === 'P2' ? 'pending' : 'open' });
    seedNode(db, 'T1', ['task'], { status: 'open', due: '2026-09-20', estimate: 2, flag: true, tags: ['a'], scores: [2] });
    seedNode(db, 'T2', ['task'], { status: 'in-progress', due: '2026-09-18', estimate: -1.5 });
    seedNode(db, 'T3', ['task'], { status: 'done', due: '2026-09-16', estimate: 5 });
    seedNode(db, 'T4', ['task'], { status: 'open' });
    seedNode(db, 'T5', ['task'], { status: 'open', due: '2026-09-17' });
    seedNode(db, 'T6', ['task'], { status: 'open', due: null });
    for (const [s, t] of [['T1', 'P1'], ['T2', 'P1'], ['T2', 'P2'], ['T3', 'P1'], ['T4', 'P2'], ['T6', 'P2']])
        seedRel(db, s, t, t);
    seedRel(db, 'T1', 'P1', 'P1', 'wiki-link');
    seedRel(db, 'T5', 'Missing', null);
}
export function summaryRequest(): SummaryRequest {
    return {
        filter: { types: ['project'] },
        relations: [
            { as: 'all_tasks', direction: 'incoming', field: 'project', filter: { types: ['task'] }, metrics: [{ as: 'count', op: 'count' }] },
            { as: 'outstanding_tasks', direction: 'incoming', field: 'project', filter: { types: ['task'], fields: { status: { one_of: ['open', 'in-progress'] } } },
                metrics: [{ as: 'count', op: 'count' }, { as: 'next_due', op: 'min', field: 'due', date_mode: 'calendar_date' }], lookup: { fields: ['status', 'due'], limit: 2 } },
        ],
    };
}
