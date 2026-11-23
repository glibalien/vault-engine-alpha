import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { indexFile } from '../../src/indexer/indexer.js';

let vault: string;
let db: Database.Database;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'typed-index-'));
  mkdirSync(join(vault, 'Projects'));
  mkdirSync(join(vault, 'Wiki'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUiHints(db);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, '2');
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createGlobalField(db, { name: 'projects', field_type: 'list', list_item_type: 'reference', reference_target: 'project' });
});
afterEach(() => { db.close(); rmSync(vault, { recursive: true, force: true }); });

function indexed(path: string, raw: string): string {
  const absolute = join(vault, path);
  writeFileSync(absolute, raw);
  return indexFile(absolute, vault, db);
}

describe('typed parse/index references', () => {
  it('uses field type for frontmatter and body origin for prose', () => {
    const projectId = indexed('Projects/P1.md', '---\ntypes: [project]\n---\n');
    const wikiId = indexed('Wiki/P1.md', '---\ntypes: [wiki]\n---\n');
    const sourceId = indexed('Task.md', '---\nproject: "[[P1]]"\nprojects: ["[[P1]]", "[[Missing]]"]\n---\nproject [[P1]]\n');
    const rels = db.prepare('SELECT target, rel_type, resolved_target_id FROM relationships WHERE source_id = ? ORDER BY rel_type, target')
      .all(sourceId) as Array<{ target: string; rel_type: string; resolved_target_id: string | null }>;
    expect(rels.find(r => r.rel_type === 'project')?.resolved_target_id).toBe(projectId);
    expect(rels.find(r => r.rel_type === 'projects' && r.target === 'P1')?.resolved_target_id).toBe(projectId);
    expect(rels.find(r => r.target === 'Missing')?.resolved_target_id).toBeNull();
    expect(rels.find(r => r.rel_type === 'wiki-link')).toMatchObject({ target: 'P1', resolved_target_id: wikiId });
    expect(db.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'projects'").get(sourceId))
      .toEqual({ value_json: JSON.stringify(['P1', 'Missing']) });
  });

  it('retains explicit path, null and empty list data with a wrong-type binding', () => {
    indexed('Wiki/Only.md', '---\ntypes: [wiki]\n---\n');
    const sourceId = indexed('Task.md', '---\nproject: "[[Wiki/Only.md]]"\nprojects: []\nspare: null\n---\n');
    expect(db.prepare('SELECT target, rel_type, resolved_target_id FROM relationships WHERE source_id = ?').all(sourceId))
      .toEqual([{ target: 'Wiki/Only.md', rel_type: 'project', resolved_target_id: null }]);
    expect(db.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'projects'").get(sourceId))
      .toEqual({ value_json: '[]' });
    expect(db.prepare("SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?").all(sourceId))
      .toContainEqual({ field_name: 'spare' });
  });

  it('retains nested frontmatter wiki-links as unconstrained references', () => {
    const projectId = indexed('Projects/P1.md', '---\ntypes: [project]\n---\n');
    const sourceId = indexed('Task.md', '---\nmeta: { related: "[[P1]]" }\n---\n');
    expect(db.prepare('SELECT target, rel_type, context, resolved_target_id FROM relationships WHERE source_id = ?').all(sourceId))
      .toEqual([{ target: 'P1', rel_type: 'meta', context: 'meta', resolved_target_id: projectId }]);
    expect(db.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'meta'").get(sourceId))
      .toEqual({ value_json: JSON.stringify({ related: 'P1' }) });
  });
});
