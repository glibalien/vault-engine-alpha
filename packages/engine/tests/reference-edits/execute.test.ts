import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { referenceEditFixture } from '../helpers/reference-edit.js';
import { executeReferenceEdit } from '../../src/reference-edits/execute.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { updateSchemaDefinition } from '../../src/schema/crud.js';
import { referenceEditResult } from '../../src/mcp/tools/reference-edit.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';

const fixtures: ReturnType<typeof referenceEditFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
function fixture(fields?: Record<string, unknown>) { const f = referenceEditFixture(fields); fixtures.push(f); return f; }
function edit(f: ReturnType<typeof fixture>, options: { dry_run?: boolean; expected_version?: number; expected_content_hash?: string } = {}, action: 'add' | 'remove' = 'add', target = { node_id: f.projectIds[1] }) {
  return executeReferenceEdit(f, { node_id: f.taskId, reference_edit: { field: 'project', action, target }, dry_run: false, ...options }, state => state);
}

describe('atomic reference edit service', () => {
  it('reuses one identity catalog for membership and pipeline relationship derivation', () => {
    let scans = 0;
    const f = referenceEditFixture({ project: Array.from({ length: 12 }, (_, i) => `Missing${i}`) }, {
      verbose(sql) { if (typeof sql === 'string' && sql.startsWith('SELECT id, file_path, title FROM nodes') && !sql.includes(' WHERE ')) scans++; },
    });
    fixtures.push(f);
    scans = 0;
    edit(f);
    expect(scans).toBe(1);
    expect(f.members()).toHaveLength(13);
  });
  it('combines independent additions and creates one undo snapshot per real change', () => {
    const f = fixture();
    expect(edit(f).plan.outcome).toBe('added');
    edit(f, {}, 'add', { node_id: f.projectIds[2] });
    expect(f.members()).toEqual(['P1', 'P2', 'P3']);
    expect(f.source().version).toBe(3);
    expect(f.db.prepare('SELECT node_count FROM undo_operations').all()).toEqual([{ node_count: 1 }, { node_count: 1 }]);
  });
  it('previews and no-ops without any durable changes', () => {
    const f = fixture();
    const before = f.snapshot();
    expect(edit(f, { dry_run: true }).plan.values).toEqual(['P1', 'P2']);
    expect(f.snapshot()).toEqual(before);
    expect(edit(f, {}, 'add', { node_id: f.projectIds[0] }).plan.changed).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });
  it('reports the stored state on a no-op without claiming coercions were applied', () => {
    const f = fixture();
    f.db.prepare("UPDATE node_fields SET value_json = ? WHERE node_id = ? AND field_name = 'project'").run(JSON.stringify(['P1', ' P2 ']), f.taskId);
    const before = f.snapshot();
    const result = edit(f, {}, 'add', { node_id: f.projectIds[0] });
    expect(result.pipeline.validation.coerced_state.project.value).toEqual(['P1', ' P2 ']);
    expect(result.pipeline.validation.coerced_state.project.changed).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });
  it.each([false, true])('checks all guards and disk equality even on no-op (preview=%s)', dry_run => {
    const f = fixture();
    const target = { node_id: f.projectIds[0] };
    const before = f.snapshot();
    expect(() => edit(f, { dry_run, expected_version: 999 }, 'add', target)).toThrow(/modified/i);
    expect(() => edit(f, { dry_run, expected_content_hash: 'stale' }, 'add', target)).toThrow(/content changed/i);
    expect(f.snapshot()).toEqual(before);
    writeFileSync(join(f.vaultPath, 'Task.md'), 'human edit');
    expect(() => edit(f, { dry_run }, 'add', target)).toThrow(/content changed/i);
    expect(f.snapshot().file).toBe('human edit');
    unlinkSync(join(f.vaultPath, 'Task.md'));
    expect(() => edit(f, { dry_run }, 'add', target)).toThrow(/content changed/i);
  });
  it.each([{}, { project: null }, { project: [] }])('preserves presence on removal and unrelated nulls on addition: %j', fields => {
    const f = fixture({ ...fields, note: null });
    const before = f.snapshot();
    edit(f, {}, 'remove');
    expect(f.snapshot()).toEqual(before);
    edit(f);
    expect(f.members()).toEqual(['P2']);
    expect(f.db.prepare('SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?').all(f.taskId)).toEqual([{ field_name: 'note' }]);
  });
  it('allows last-member removal from a required list and removal after target type drift', () => {
    const f = fixture();
    f.db.prepare("UPDATE global_fields SET required = 1 WHERE name = 'project'").run();
    f.db.prepare('DELETE FROM node_types WHERE node_id = ?').run(f.projectIds[0]);
    edit(f, {}, 'remove', { node_id: f.projectIds[0] });
    expect(f.members()).toEqual([]);
    expect(() => edit(f, {}, 'add', { node_id: f.projectIds[0] })).toThrow(/type/i);
  });
  it('rejects missing targets, unclaimed fields and malformed stored lists', () => {
    const f = fixture();
    expect(() => edit(f, {}, 'add', { node_id: 'missing' })).toThrow(/not found/i);
    for (const value of ['"P1"', '[42]', '{bad']) {
      f.db.prepare("UPDATE node_fields SET value_json = ? WHERE node_id = ? AND field_name = 'project'").run(value, f.taskId);
      const before = f.snapshot();
      expect(() => edit(f)).toThrow(/list|JSON/i);
      expect(f.snapshot()).toEqual(before);
    }
    updateSchemaDefinition(f.db, 'Task', { field_claims: [] });
    expect(() => edit(f)).toThrow(/claimed/i);
  });
  it('rejects unrelated default population instead of silently changing another field', () => {
    const f = fixture();
    createGlobalField(f.db, { name: 'required_default', field_type: 'string', required: true, default_value: 'surprise' });
    updateSchemaDefinition(f.db, 'Task', { field_claims: [{ field: 'project' }, { field: 'required_default' }] });
    const before = f.snapshot();
    expect(() => edit(f)).toThrow(/semantic|unrelated/i);
    expect(f.snapshot()).toEqual(before);
  });
  it('rolls back a provisional operation when result preflight rejects', () => {
    const f = fixture();
    const before = f.snapshot();
    expect(() => executeReferenceEdit(f, { node_id: f.taskId, reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[1] } }, dry_run: false }, () => { throw new Error('oversized'); })).toThrow('oversized');
    expect(f.snapshot()).toEqual(before);
  });
  it('returns the disk conflict if a human edit arrives after preflight but before any write', () => {
    const f = fixture();
    const before = f.snapshot().tables;
    expect(() => executeReferenceEdit(f, { node_id: f.taskId, reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[1] } }, dry_run: false }, state => {
      writeFileSync(join(f.vaultPath, 'Task.md'), 'late human edit');
      return state;
    })).toThrow(/content changed/i);
    expect(f.snapshot().tables).toEqual(before);
    expect(f.snapshot().file).toBe('late human edit');
  });
  it('bounds the actual serialized envelope at exactly 1 MiB including formatting', () => {
    const f = fixture({ project: ['P1'], large: '' });
    const state = edit(f, { dry_run: true });
    const base = referenceEditResult(state).content[0].text;
    const padding = 1024 * 1024 - Buffer.byteLength(base, 'utf8');
    state.pipeline.validation.coerced_state.large.value = 'x'.repeat(padding);
    expect(Buffer.byteLength(referenceEditResult(state).content[0].text, 'utf8')).toBe(1024 * 1024);
    state.pipeline.validation.coerced_state.large.value += 'x';
    expect(() => referenceEditResult(state)).toThrow(/envelope limit/);
  });
  it('preserves the ordinary shortest-path projection for unrelated ambiguous members', () => {
    const f = fixture({ project: ['P1', 'Ambiguous'] });
    f.db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('long', 'Long/Name.md', 'Ambiguous'), ('short', 'A.md', 'Ambiguous')").run();
    edit(f);
    expect(f.members()).toEqual(['P1', 'Ambiguous', 'P2']);
    expect(f.db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = 'Ambiguous'").get(f.taskId)).toEqual({ resolved_target_id: 'short' });
  });
  it('keeps the typed project binding during an unrelated member addition', () => {
    const f = fixture({ project: ['P1'] });
    f.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, '2');
    f.db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('wiki-p1', 'Wiki/P1.md', 'P1')").run();
    f.db.prepare("INSERT INTO node_types (node_id, schema_type, sort_order) VALUES ('wiki-p1', 'Wiki', 0)").run();
    edit(f, {}, 'add', { node_id: f.projectIds[1] });
    expect(f.members()).toEqual(['P1', 'P2']);
    expect(f.db.prepare("SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = 'P1'").get(f.taskId))
      .toEqual({ resolved_target_id: f.projectIds[0] });
    expect(f.db.prepare('SELECT relationships FROM undo_snapshots WHERE node_id = ?').get(f.taskId))
      .toEqual(expect.objectContaining({ relationships: expect.any(String) }));
  });
});
