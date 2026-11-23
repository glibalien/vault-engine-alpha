import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { upgradeToEnumGroups } from '../../src/db/migrate.js';
it('upgrades old definitions idempotently without changing existing data',()=>{
 const db=new Database(':memory:');
 db.exec("CREATE TABLE global_fields(name TEXT); CREATE TABLE schema_field_claims(schema_name TEXT,field TEXT); INSERT INTO global_fields VALUES('status'); INSERT INTO schema_field_claims VALUES('task','status');");
 upgradeToEnumGroups(db); upgradeToEnumGroups(db);
 expect(db.prepare('SELECT * FROM global_fields').get()).toEqual({name:'status',enum_groups:null,overrides_allowed_enum_groups:0});
 expect(db.prepare('SELECT * FROM schema_field_claims').get()).toEqual({schema_name:'task',field:'status',enum_groups_override:null});
 db.close();
});
