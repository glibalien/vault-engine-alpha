import { describe, expect, it } from 'vitest';
import { buildReferenceCatalog, resolveRelationship } from '../../src/resolver/relationship-policy.js';
import { deriveReferenceContexts } from '../../src/pipeline/relationships.js';
import { typedReferenceDb, addSecondProject } from '../helpers/typed-reference.js';
import type { GlobalFieldDefinition } from '../../src/validation/types.js';

const field = (requiredType: string | null): GlobalFieldDefinition => ({
  name: 'project', field_type: 'reference', reference_target: requiredType,
  enum_values: null, description: null, default_value: null, required: false,
  ai_guessable: false, list_item_type: null, ui_hints: null,
  overrides_allowed: { required: false, default_value: false, enum_values: false, ai_guessable: false },
});
const request = (rawTarget: string, requiredType: string | null, origin: 'field' | 'body' = 'field') => ({
  rawTarget, context: { origin, field: origin === 'field' ? 'project' : null, requiredType },
});

describe('relationship policy', () => {
  it('selects one typed project among same-title wiki and person nodes', () => {
    const db = typedReferenceDb();
    const catalog = buildReferenceCatalog(db);
    expect(resolveRelationship(catalog, request('Example', 'Project'), 2)).toMatchObject({ status: 'resolved', targetId: 'P1' });
    expect(resolveRelationship(catalog, request('Example', 'Person'), 2)).toMatchObject({ status: 'resolved', targetId: 'C' });
    expect(resolveRelationship(catalog, request('Example', null, 'body'), 1)).toMatchObject({ status: 'resolved', targetId: 'W' });
    db.close();
  });

  it('rejects same-tier typed ambiguity, but exact path remains decisive', () => {
    const db = typedReferenceDb();
    addSecondProject(db);
    const catalog = buildReferenceCatalog(db);
    expect(resolveRelationship(catalog, request('Example', 'Project'), 2)).toMatchObject({ status: 'unresolved', reason: 'ambiguous', tier: 2, candidateCount: 2 });
    expect(resolveRelationship(catalog, request('Projects/Example.md', 'Project'), 2)).toMatchObject({ status: 'resolved', targetId: 'P1' });
    expect(resolveRelationship(catalog, request('Wiki/Example.md', 'Project'), 2)).toMatchObject({ status: 'unresolved', reason: 'type_mismatch', tier: 1 });
    // A path written without `.md` is the same exact path (#592), and decisive the same way.
    expect(resolveRelationship(catalog, request('Projects/Example', 'Project'), 2)).toMatchObject({ status: 'resolved', targetId: 'P1', tier: 1 });
    expect(resolveRelationship(catalog, request('Wiki/Example', 'Project'), 2)).toMatchObject({ status: 'unresolved', reason: 'type_mismatch', tier: 1 });
    expect(resolveRelationship(catalog, request('Nowhere/Example', 'Project'), 2)).toMatchObject({ status: 'unresolved', reason: 'missing' });
    const ambiguous = resolveRelationship(catalog, request('Example', 'Project'), 2);
    expect(ambiguous.candidates.map(c => c.id)).toEqual(['P2', 'P1']);
    db.close();
  });

  it('uses first eligible tier, multi-types, and Unicode tiers', () => {
    const db = typedReferenceDb();
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('W', 'Project');
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('U', 'Notes/café.md', 'Other');
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('U', 'Project');
    const catalog = buildReferenceCatalog(db);
    expect(resolveRelationship(catalog, request('Wiki/Example.md', 'Project'), 2)).toMatchObject({ status: 'resolved', targetId: 'W' });
    expect(resolveRelationship(catalog, request('cafe\u0301', 'Project'), 2)).toMatchObject({ status: 'resolved', targetId: 'U', tier: 5 });
    expect(resolveRelationship(catalog, request('Café', 'Project'), 2)).toMatchObject({ status: 'resolved', targetId: 'U', tier: 4 });
    db.close();
  });

  it('continues after a wrong-type textual tier and stops at the first eligible tier', () => {
    const db = typedReferenceDb();
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('T', 'Projects/Target.md', 'Different');
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('T', 'Project');
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('X', 'Wiki/Different.md', 'Target');
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('X', 'Wiki');
    const catalog = buildReferenceCatalog(db);
    expect(resolveRelationship(catalog, request('Target', 'Project'), 2)).toMatchObject({ status: 'resolved', targetId: 'T', tier: 3 });
    expect(resolveRelationship(catalog, request('Target', 'Person'), 2)).toMatchObject({ status: 'unresolved', reason: 'type_mismatch', tier: 2 });
    db.close();
  });

  it('counts every eligible candidate and bounds diagnostic examples', () => {
    const db = typedReferenceDb();
    const node = db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
    const type = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
    for (let i = 0; i < 12; i++) {
      node.run(`P${i + 10}`, `Projects/${i}/Many.md`, 'Many');
      type.run(`P${i + 10}`, 'Project');
    }
    const resolution = resolveRelationship(buildReferenceCatalog(db), request('Many', 'Project'), 2);
    expect(resolution).toMatchObject({ status: 'unresolved', reason: 'ambiguous', candidateCount: 12, candidatesTruncated: true });
    expect(resolution.candidates).toHaveLength(10);
    db.close();
  });

  it('derives field, orphan and body origins from actual values', () => {
    const globalFields = new Map([['project', field('Project')]]);
    const rels = deriveReferenceContexts({ project: '[[Example]]', extra: '[[Example]]' }, 'See [[Example]]', globalFields, {});
    expect(rels.map(r => r.referenceContext)).toEqual([
      { origin: 'field', field: 'project', requiredType: 'Project' },
      { origin: 'orphan', field: 'extra', requiredType: null },
      { origin: 'body', field: null, requiredType: null },
    ]);
  });
});
