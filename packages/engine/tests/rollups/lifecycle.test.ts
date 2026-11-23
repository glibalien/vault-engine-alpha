import { afterEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { seedSummaryFixture } from '../helpers/summary-fixture.js';
import { seedRollups, projectViews } from '../helpers/rollup-fixture.js';
import { renameRelationshipViewFields } from '../../src/rollups/mutation.js';
import {
  describeRelationshipViews,
  namespace,
} from '../../src/rollups/definitions.js';
import { createOperation } from '../../src/undo/operation.js';
import { restoreSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
import { renameGlobalField } from '../../src/global-fields/crud.js';
const dbs: Database.Database[] = [];
const fixture = () => {
  const db = createTestDb();
  seedSummaryFixture(db);
  seedRollups(db);
  dbs.push(db);
  return db;
};
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
it('renames typed tokens on non-claiming owner schemas without rewriting text and restores them', () => {
  const db = fixture(),
    views = projectViews();
  views.rollups[0].filter!.fields.status.one_of = ['due'];
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
    JSON.stringify({ relationship_views_v1: views }),
  );
  const operation = createOperation(db, {
    source_tool: 'rename-global-field',
    description: 'rename due',
  });
  db.transaction(() => {
    renameGlobalField(db, 'due', 'deadline');
    expect(
      renameRelationshipViewFields(db, 'due', 'deadline', operation),
    ).toEqual(['project']);
  })();
  const result = describeRelationshipViews(db, 'project');
  expect(result.rollups[1].definition.metric).toMatchObject({
    field: 'deadline',
  });
  expect(result.rollups[0].definition.filter!.fields!.status).toEqual({
    one_of: ['due'],
  });
  restoreSchemaSnapshot(db, '/unused', operation, 'project', { render: false });
  const row = db
    .prepare("SELECT metadata FROM schemas WHERE name='project'")
    .get() as { metadata: string };
  expect(namespace(JSON.parse(row.metadata))).toEqual(views);
});
it('rolls back definition and global-field changes as one transaction', () => {
  const db = fixture(),
    before = db.serialize();
  expect(() =>
    db.transaction(() => {
      const op = createOperation(db, {
        source_tool: 'rename-global-field',
        description: 'rollback',
      });
      renameGlobalField(db, 'due', 'deadline');
      renameRelationshipViewFields(db, 'due', 'deadline', op);
      throw new Error('later failure');
    })(),
  ).toThrow('later failure');
  expect(db.serialize()).toEqual(before);
});
it('preserves invalid definitions until missing dependencies are restored', () => {
  const db = fixture();
  db.prepare("DELETE FROM global_fields WHERE name='due'").run();
  expect(describeRelationshipViews(db, 'project').rollups[1].state).toBe(
    'invalid',
  );
  db.prepare(
    "INSERT INTO global_fields (name,field_type) VALUES ('due','date')",
  ).run();
  expect(describeRelationshipViews(db, 'project').rollups[1].state).toBe(
    'valid',
  );
});

it('renames percentage matching keys without touching equal literal values and supports undo', () => {
  const db=fixture();
  const views={...projectViews(),rollups:[{name:'p',relation:'tasks',filter:{fields:{status:{one_of:['open','status']}}},metric:{op:'percentage',matching_filter:{fields:{status:{eq:'status'}}}}}]};
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(JSON.stringify({relationship_views_v1:views}));
  const op=createOperation(db,{source_tool:'rename-global-field',description:'nested status rename'});
  db.transaction(()=>{renameGlobalField(db,'status','state');renameRelationshipViewFields(db,'status','state',op);})();
  const d=describeRelationshipViews(db,'project');
  expect(d.rollups[0]).toMatchObject({state:'valid',definition:{filter:{fields:{state:{one_of:['open','status']}}},metric:{matching_filter:{fields:{state:{eq:'status'}}}}}});
  restoreSchemaSnapshot(db,'/unused',op,'project',{render:false});
  const row=db.prepare("SELECT metadata FROM schemas WHERE name='project'").get() as {metadata:string};
  expect(namespace(JSON.parse(row.metadata))).toEqual(views);
});
