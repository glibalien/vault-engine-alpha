import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyzer/index.js';
import { IssueCollector } from '../../src/analyzer/infer-structure.js';
import { fm, makeScanTree } from './helpers.js';

const roots: string[] = [];

async function makeTree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await makeScanTree(files);
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('chosen field types', () => {
  it('turns a review field into a proposed field that its types claim', async () => {
    const root = await makeTree({
      'Projects/A.md': fm({ kind: 'project', owners: '[[Alice]]' }),
      'Projects/B.md': fm({ kind: 'project', owners: ['[[Bob]]', '[[Carol]]'] }),
      'Alice.md': '# Alice\n',
      'Bob.md': '# Bob\n',
      'Carol.md': '# Carol\n',
    });

    const before = await analyze({ root, typeField: 'kind' });
    const after = await analyze({ root, typeField: 'kind', fieldTypes: { owners: { field_type: 'list', list_item_type: 'reference' } } });

    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.data.needs_review.ambiguous_fields.map(field => field.name)).toEqual(['owners']);
    expect(before.data.proposal.schemas[0]?.field_claims).toEqual([]);
    expect(after.data.needs_review.ambiguous_fields).toEqual([]);
    expect(after.data.proposal.global_fields).toEqual([expect.objectContaining({
      name: 'owners',
      field_type: 'list',
      list_item_type: 'reference',
      evidence: expect.objectContaining({ reference: expect.objectContaining({ resolved_targets: 3 }) }),
    })]);
    expect(after.data.proposal.schemas[0]?.field_claims.map(claim => claim.field)).toEqual(['owners']);
  });

  it('counts plain names as targets of a chosen reference, as Engine stores them', async () => {
    const root = await makeTree({
      'Projects/A.md': fm({ kind: 'project', owner: '[[Alice]]' }),
      'Projects/B.md': fm({ kind: 'project', owner: 'Acme' }),
      'People/Alice.md': fm({ kind: 'person' }),
      'Companies/Acme.md': fm({ kind: 'company' }),
    });

    const result = await analyze({ root, typeField: 'kind', fieldTypes: { owner: { field_type: 'reference' } } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const owner = result.data.proposal.global_fields.find(field => field.name === 'owner');
    expect(owner).toMatchObject({ field_type: 'reference', evidence: { reference: { resolved_targets: 2 } } });
    // Alice is a person and Acme a company, so no one type is the target.
    expect(owner).not.toHaveProperty('reference_target');
  });
});

describe('analyze', () => {
  it('analyzes typed files, reports untyped coverage, and maps the key to types', async () => {
    const root = await makeTree({
      'Projects/A.md': fm({ kind: 'project', status: 'open' }),
      'Projects/B.md': fm({ kind: 'project', status: 'done' }),
      'Loose.md': fm({ status: 'open' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage).toMatchObject({
      files_with_frontmatter: 3,
      typed_files: 2,
      untyped_files: 1,
      usable_percentage: (2 / 3) * 100,
    });
    expect(result.data.proposal.type_field_mapping).toEqual({ source: 'kind', target: 'types' });
    expect(result.data.proposal.schemas[0]).toMatchObject({
      name: 'project',
      default_directory: 'Projects',
      field_claims: [{
        field: 'status',
        effective_required: false,
        evidence: { single_type_documents: 2, all_typed_documents: 2, coverage: 1 },
      }],
    });
    expect(result.data.proposal.schemas[0].field_claims[0]).not.toHaveProperty('required');
    expect(result.data.issues).toContainEqual(expect.objectContaining({
      code: 'TYPE_KEY_INCOMPLETE_COVERAGE',
      count: 1,
    }));
  });

  it('refuses a custom type key when a typed document already has canonical types', async () => {
    const root = await makeTree({
      'Conflict.md': fm({ kind: 'project', types: ['legacy'] }),
      'Clean.md': fm({ kind: 'note' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'TYPE_FIELD_TARGET_COLLISION',
        message: 'Confirmed type field cannot be mapped because typed documents already contain "types"',
        details: {
          type_field: 'kind',
          target_field: 'types',
          conflicting_files: ['Conflict.md'],
          conflicts_truncated: false,
        },
      },
    });
  });

  it.each([
    ['null', 'types:'],
    ['an empty string', "types: ''"],
    ['an empty list', 'types: []'],
  ])('maps a custom type key over a canonical types key that is %s', async (_label, line) => {
    const root = await makeTree({ 'Saved.md': `---\n${line}\nkind: project\n---\n` });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.type_assignment.files).toEqual([{ path: 'Saved.md', types: ['project'] }]);
  });

  describe('with a designated type key (#445)', () => {
    it('maps the type field onto itself when it is the type key, and keeps a types key as a field', async () => {
      const root = await makeTree({
        'Projects/A.md': fm({ kind: 'project', types: ['legacy'] }),
        'Projects/B.md': fm({ kind: 'project' }),
      });

      const result = await analyze({ root, typeField: 'kind', typeKey: 'kind' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.proposal.type_field_mapping).toEqual({ source: 'kind', target: 'kind' });
      expect(result.data.proposal.type_assignment.files).toEqual([
        { path: 'Projects/A.md', types: ['project'] },
        { path: 'Projects/B.md', types: ['project'] },
      ]);
      // With kind holding types, a types key is the vault's own field like any other.
      expect(result.data.proposal.global_fields.map(field => field.name)).toEqual(['types']);
      expect(result.data.proposal.global_fields.map(field => field.name)).not.toContain('kind');
    });

    it('refuses folder typing over a value already in the type key', async () => {
      const root = await makeTree({
        'Projects/Typed.md': fm({ kind: 'legacy' }),
        'Projects/Plain.md': fm({ types: ['kept'] }),
      });

      const result = await analyze({ root, folderRules: [{ directory: 'Projects', type: 'project' }], typeKey: 'kind' });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'TYPE_FIELD_TARGET_COLLISION',
          message: 'Assigned types cannot be mapped to "kind" because typed documents already contain it',
          details: { type_field: null, target_field: 'kind', conflicting_files: ['Projects/Typed.md'], conflicts_truncated: false },
        },
      });
    });

    it('refuses a type field mapped onto another designated key that typed documents already use', async () => {
      const root = await makeTree({ 'A.md': fm({ type: 'project', kind: 'legacy' }) });

      const result = await analyze({ root, typeField: 'type', typeKey: 'kind' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: 'TYPE_FIELD_TARGET_COLLISION',
        message: 'Confirmed type field cannot be mapped because typed documents already contain "kind"',
        details: { type_field: 'type', target_field: 'kind' },
      });
    });

    it('refuses a designated key holding a value Engine could not keep as a type', async () => {
      const root = await makeTree({
        'A.md': fm({ kind: 'meeting' }),
        'B.md': '---\nkind:\n  category: meeting\n---\n',
        'C.md': '---\nkind:\n  - task\n  - [a, b]\n---\n',
        'D.md': '---\nkind: [[project]]\n---\n',
      });

      const result = await analyze({ root, typeField: 'kind', typeKey: 'kind' });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'TYPE_KEY_VALUE_UNSUPPORTED',
          message: 'Engine could not keep every value of "kind" as note types: some notes hold a mapping or a nested list there, which the next save would drop. Change those values or choose another way to type notes',
          details: { type_key: 'kind', files: ['B.md', 'C.md'], files_truncated: false },
        },
      });
    });

    it('refuses types holding a value Engine could not keep as a type, as any key (#482)', async () => {
      const root = await makeTree({
        'A.md': fm({ types: 'meeting' }),
        'B.md': '---\ntypes:\n  category: x\n---\n',
        'C.md': '---\ntypes: [[project]]\n---\n',
        'D.md': '---\ntypes:\n  - [[task]]\n  - 3\n---\n',
      });

      const result = await analyze({ root, typeField: 'types' });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'TYPE_KEY_VALUE_UNSUPPORTED',
          message: 'Engine could not keep every value of "types" as note types: some notes hold a mapping or a nested list there, which the next save would drop. Change those values or choose another way to type notes',
          details: { type_key: 'types', files: ['B.md'], files_truncated: false },
        },
      });
      // Typed by folders only, Engine still reads types from `types`.
      const byFolder = await analyze({
        root: await makeTree({ 'Meetings/A.md': '# A\n', 'Other/B.md': '---\ntypes:\n  category: x\n---\n' }),
        folderRules: [{ directory: 'Meetings', type: 'meeting' }],
      });
      expect(byFolder.ok).toBe(false);
      if (byFolder.ok) return;
      expect(byFolder.error.code).toBe('TYPE_KEY_VALUE_UNSUPPORTED');
    });

    it('refuses a type key Engine writes in its own notes', async () => {
      const root = await makeTree({ 'A.md': fm({ source: 'book' }) });

      const result = await analyze({ root, typeField: 'source', typeKey: 'source' });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'TYPE_KEY_RESERVED',
          message: 'Engine writes "source" in its own notes, so that key cannot also hold note types',
          details: { type_key: 'source' },
        },
      });
    });

    it.each([['', 'empty'], [' kind', 'padded'], ['ki\nnd', 'multi-line']])('rejects a type key %j (%s)', async (typeKey) => {
      const root = await makeTree({ 'A.md': fm({ kind: 'project' }) });

      const result = await analyze({ root, typeField: 'kind', typeKey });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_ARGUMENTS');
    });
  });

  it('does not turn incomplete coverage into a collision refusal', async () => {
    const root = await makeTree({
      'Typed.md': fm({ kind: 'project' }),
      'UntypedWithCanonicalKey.md': fm({ types: ['legacy'] }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage).toMatchObject({ typed_files: 1, untyped_files: 1 });
    expect(result.data.issues).toContainEqual(expect.objectContaining({
      code: 'TYPE_KEY_INCOMPLETE_COVERAGE',
      count: 1,
    }));
  });

  it('uses single-type files for ownership and reports multi-type-only claims', async () => {
    const root = await makeTree({
      'Task.md': fm({ kind: 'task', status: 'open' }),
      'Mixed.md': fm({ kind: ['meeting', 'project'], attendees: ['[[Alice]]'] }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.find(schema => schema.name === 'task')?.field_claims)
      .toEqual([expect.objectContaining({ field: 'status' })]);
    expect(result.data.needs_review.ambiguous_claims).toEqual([{
      field: 'attendees',
      candidate_types: ['meeting', 'project'],
      multi_type_documents: 1,
      status: 'needs_review',
    }]);
  });

  it('normalizes scalar, list, and unquoted-link type values without changing exact case', async () => {
    const root = await makeTree({
      'A.md': fm({ kind: '  Project  ' }),
      'B.md': fm({ kind: ['Project', 'project-archive', 'Project'] }),
      'C.md': '---\nkind: [[Meeting]]\n---\n',
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name))
      .toEqual(['Meeting', 'Project', 'project-archive']);
  });

  it.each([
    [['Project', 'project'], ['Project', 'project']],
    [['Caf\u00e9', 'Cafe\u0301'], ['Cafe\u0301', 'Caf\u00e9']],
    [['\u03a3', '\u03c2'], ['\u03a3', '\u03c2']],
  ])('withholds portable schema filename collisions for %j as review items', async (typeNames, expectedNames) => {
    const root = await makeTree({ 'Collision.md': fm({ kind: typeNames }) });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.needs_review.type_name_collisions)
      .toEqual([{ names: expectedNames, documents: 1 }]);
    expect(result.data.proposal.schemas).toEqual([]);
    expect(result.data.coverage).toMatchObject({ typed_files: 0, untyped_files: 1 });
    expect(result.data.issues).toContainEqual({
      code: 'TYPE_NAME_COLLISION',
      count: 1,
      examples: [{
        path: 'Collision.md',
        value: expectedNames,
        message: 'Type names that differ only by case or Unicode form were withheld',
      }],
      truncated: false,
    });
  });

  it('keeps non-colliding types and merges a collision through a rename', async () => {
    const root = await makeTree({
      'Meetings/A.md': fm({ kind: 'meeting', attendees: 3 }),
      'Meetings/B.md': fm({ kind: 'Meeting', attendees: 4 }),
      'Projects/C.md': fm({ kind: 'project', status: 'open' }),
    });

    const withheld = await analyze({ root, typeField: 'kind' });
    expect(withheld.ok).toBe(true);
    if (!withheld.ok) return;
    expect(withheld.data.proposal.schemas.map(schema => schema.name)).toEqual(['project']);
    expect(withheld.data.needs_review.type_name_collisions)
      .toEqual([{ names: ['Meeting', 'meeting'], documents: 2 }]);
    expect(withheld.data.proposal.global_fields.map(field => field.name)).toEqual(['status']);

    const merged = await analyze({ root, typeField: 'kind', typeRenames: { Meeting: 'meeting' } });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.data.needs_review.type_name_collisions).toEqual([]);
    expect(merged.data.proposal.schemas.map(schema => ({
      name: schema.name,
      typed: schema.evidence.typed_documents,
      directory: schema.default_directory,
    }))).toEqual([
      { name: 'meeting', typed: 2, directory: 'Meetings' },
      { name: 'project', typed: 1, directory: 'Projects' },
    ]);
    expect(merged.data.proposal.type_assignment.type_field_values).toEqual([
      { value: 'Meeting', type: 'meeting', documents: 1 },
      { value: 'meeting', type: 'meeting', documents: 1 },
      { value: 'project', type: 'project', documents: 1 },
    ]);
    expect(merged.data.proposal.type_assignment.type_renames)
      .toEqual([{ from: 'Meeting', to: 'meeting' }]);
  });

  it('canonicalizes aliases in an unquoted nested type wiki-link', async () => {
    const root = await makeTree({
      'A.md': '---\nkind: [[Project|Alias]]\n---\n',
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['Project']);
  });

  it.each(['constructor', 'toString', '__proto__'])
  ('does not treat inherited %s as a confirmed key', async (typeField) => {
    const root = await makeTree({ 'A.md': fm({ kind: 'note' }) });

    await expect(analyze({ root, typeField })).resolves.toMatchObject({
      ok: false,
      error: { code: 'TYPE_FIELD_NOT_FOUND' },
    });
  });

  it('still accepts an own property named constructor as the confirmed key', async () => {
    const root = await makeTree({
      'A.md': '---\nconstructor: note\n---\n',
    });

    const result = await analyze({ root, typeField: 'constructor' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['note']);
  });

  it('keeps usable string members and reports every invalid type member', async () => {
    const root = await makeTree({
      'A.md': '---\nkind: [project, 4, "  ", false]\n---\n',
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['project']);
    expect(result.data.issues).toContainEqual(expect.objectContaining({
      code: 'TYPE_VALUE_INVALID',
      count: 3,
      examples: expect.arrayContaining([
        expect.objectContaining({ path: 'A.md', field: 'kind', value: 4 }),
        expect.objectContaining({ path: 'A.md', field: 'kind', value: '  ' }),
        expect.objectContaining({ path: 'A.md', field: 'kind', value: false }),
      ]),
    }));
  });

  it('rejects type values that cannot be safely rendered as schema filenames', async () => {
    const root = await makeTree({
      'Unsafe.md': fm({ kind: ['project', '../../escape', 'nested/type', '_fields', 'CON'] }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['project']);
    expect(result.data.issues).toContainEqual(expect.objectContaining({
      code: 'TYPE_VALUE_INVALID',
      count: 4,
      examples: expect.arrayContaining([
        expect.objectContaining({ value: '../../escape' }),
        expect.objectContaining({ value: 'nested/type' }),
        expect.objectContaining({ value: '_fields' }),
        expect.objectContaining({ value: 'CON' }),
      ]),
    }));
  });

  it('distinguishes an absent confirmed key from a key with no usable values', async () => {
    const missingRoot = await makeTree({ 'A.md': fm({ status: 'open' }) });
    const unusableRoot = await makeTree({ 'A.md': fm({ kind: [1, false, ''] }) });

    await expect(analyze({ root: missingRoot, typeField: 'kind' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'TYPE_FIELD_NOT_FOUND' },
    });
    await expect(analyze({ root: unusableRoot, typeField: 'kind' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NO_USABLE_TYPE_VALUES' },
    });
  });

  it('counts malformed frontmatter in coverage without using it as structure evidence', async () => {
    const root = await makeTree({
      'Good.md': fm({ kind: 'note', score: 1 }),
      'Bad.md': '---\nkind: [broken\n---\n',
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage).toEqual({
      files_with_frontmatter: 2,
      typed_files: 1,
      untyped_files: 1,
      malformed_frontmatter_files: 1,
      usable_percentage: 50,
      typed_by_type_field: 1,
      typed_by_folder_rule: 0,
      typed_by_tag_rule: 0,
    });
    expect(result.data.issues.map(issue => issue.code)).toContain('FRONTMATTER_MALFORMED');
  });

  it('claims one apply-ready field independently for two single types', async () => {
    const root = await makeTree({
      'Project.md': fm({ kind: 'project', status: 'open' }),
      'Task.md': fm({ kind: 'task', status: 'done' }),
      'Mixed.md': fm({ kind: ['project', 'task'], status: 'open' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => ({
      name: schema.name,
      claims: schema.field_claims.map(claim => claim.field),
    }))).toEqual([
      { name: 'project', claims: ['status'] },
      { name: 'task', claims: ['status'] },
    ]);
    expect(result.data.proposal.schemas[0].field_claims[0].evidence).toEqual({
      single_type_documents: 1,
      all_typed_documents: 2,
      coverage: 1,
    });
  });

  it('excludes review-required fields from the field pool and all schema claims', async () => {
    const root = await makeTree({
      'A.md': fm({ kind: 'project', mixed: 'text' }),
      'B.md': fm({ kind: 'project', mixed: 4 }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.global_fields).toEqual([]);
    expect(result.data.proposal.schemas[0].field_claims).toEqual([]);
    expect(result.data.needs_review.ambiguous_fields)
      .toEqual([expect.objectContaining({ name: 'mixed', status: 'needs_review' })]);
    expect(result.data.issues.map(issue => issue.code)).toContain('FIELD_SHAPE_AMBIGUOUS');
  });

  it('suggests a directory only when all single-type files have the same exact parent', async () => {
    const root = await makeTree({
      'Root.md': fm({ kind: 'root-note' }),
      'Projects/A.md': fm({ kind: 'project' }),
      'Projects/B.md': fm({ kind: 'project' }),
      'Archive/C.md': fm({ kind: 'split' }),
      'Current/D.md': fm({ kind: 'split' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.find(schema => schema.name === 'root-note'))
      .toMatchObject({ default_directory: '.' });
    expect(result.data.proposal.schemas.find(schema => schema.name === 'project'))
      .toMatchObject({ default_directory: 'Projects' });
    expect(result.data.proposal.schemas.find(schema => schema.name === 'split'))
      .not.toHaveProperty('default_directory');
  });

  it('preserves literal backslashes in POSIX default directory names', async () => {
    if (process.platform === 'win32') return;
    const directory = 'Team\\Archive';
    const root = await makeTree({
      [`${directory}/A.md`]: fm({ kind: 'note' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.find(schema => schema.name === 'note'))
      .toMatchObject({
        default_directory: directory,
        evidence: { parent_directories: { [directory]: 1 } },
      });
  });

  it('ignores multi-type notes when deriving a single-type default directory', async () => {
    const root = await makeTree({
      'Projects/A.md': fm({ kind: 'project' }),
      'Archive/Mixed.md': fm({ kind: ['project', 'archived'] }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.find(schema => schema.name === 'project'))
      .toMatchObject({ default_directory: 'Projects' });
  });

  it('sets a reference target only when every link resolves to one shared confirmed type', async () => {
    const root = await makeTree({
      'People/Alice.md': fm({ kind: ['person', 'contact'] }),
      'People/Bob.md': fm({ kind: ['person', 'friend'] }),
      'Tasks/A.md': fm({ kind: 'task', assignees: ['[[Alice]]', '[[Bob]]'] }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.global_fields).toEqual([
      expect.objectContaining({
        name: 'assignees',
        field_type: 'list',
        list_item_type: 'reference',
        reference_target: 'person',
        evidence: expect.objectContaining({
          reference: {
            resolved_targets: 2,
            unresolved_targets: 0,
            ambiguous_targets: 0,
            target_type_distribution: { contact: 1, friend: 1, person: 2 },
          },
        }),
      }),
    ]);
  });

  it('withholds a reference target and reports unresolved and ambiguous links', async () => {
    const root = await makeTree({
      'A/Same.md': fm({ kind: 'person' }),
      'B/Same.md': fm({ kind: 'person' }),
      'Task.md': fm({ kind: 'task', people: ['[[Same]]', '[[Missing]]'] }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const people = result.data.proposal.global_fields.find(field => field.name === 'people');
    expect(people).not.toHaveProperty('reference_target');
    expect(people?.evidence.reference).toEqual({
      resolved_targets: 0,
      unresolved_targets: 1,
      ambiguous_targets: 1,
      target_type_distribution: {},
    });
    expect(result.data.issues.map(issue => issue.code))
      .toEqual(expect.arrayContaining(['REFERENCE_AMBIGUOUS', 'REFERENCE_UNRESOLVED']));
  });

  it('keeps malformed Markdown files in the reference universe', async () => {
    const root = await makeTree({
      'Known/Alice.md': fm({ kind: 'person' }),
      'Broken/Alice.md': '---\nkind: [\n---\n',
      'Task.md': fm({ kind: 'task', owner: '[[Alice]]' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const owner = result.data.proposal.global_fields.find(field => field.name === 'owner');
    expect(owner).not.toHaveProperty('reference_target');
    expect(owner?.evidence.reference).toEqual({
      resolved_targets: 0,
      unresolved_targets: 0,
      ambiguous_targets: 1,
      target_type_distribution: {},
    });
    expect(result.data.issues).toContainEqual(expect.objectContaining({
      code: 'REFERENCE_AMBIGUOUS',
      count: 1,
    }));
  });

  it('keeps unreadable Markdown files in the reference universe when permissions apply', async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTree({
      'Known/Alice.md': fm({ kind: 'person' }),
      'Unreadable/Alice.md': fm({ kind: 'person' }),
      'Task.md': fm({ kind: 'task', owner: '[[Alice]]' }),
    });
    const unreadablePath = join(root, 'Unreadable/Alice.md');
    await chmod(unreadablePath, 0o000);

    try {
      const result = await analyze({ root, typeField: 'kind' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const owner = result.data.proposal.global_fields.find(field => field.name === 'owner');
      expect(owner).not.toHaveProperty('reference_target');
      expect(owner?.evidence.reference?.ambiguous_targets).toBe(1);
      expect(result.data.issues.map(issue => issue.code))
        .toEqual(expect.arrayContaining(['FILE_UNREADABLE', 'REFERENCE_AMBIGUOUS']));
    } finally {
      await chmod(unreadablePath, 0o600);
    }
  });

  it('resolves uppercase Markdown suffixes through basename tiers', async () => {
    const root = await makeTree({
      'People/Alice.MD': fm({ kind: 'person' }),
      'Task.md': fm({ kind: 'task', owner: '[[Alice.md]]' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.global_fields.find(field => field.name === 'owner'))
      .toMatchObject({ reference_target: 'person' });
  });

  it('marks YAML NaN and infinities for review without serializing them as null', async () => {
    const root = await makeTree({
      'Numbers.md': [
        '---',
        'kind: note',
        'nan: .nan',
        'positive: .inf',
        'negative: -.inf',
        '---',
        '',
      ].join('\n'),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.needs_review.ambiguous_fields.map(field => field.name))
      .toEqual(['nan', 'negative', 'positive']);
    const serialized = JSON.stringify(result);
    expect(JSON.parse(serialized)).toEqual(result);
    expect(serialized).toContain('non_finite_number');
    expect(serialized).toContain('NaN');
    expect(serialized).toContain('Infinity');
    expect(serialized).toContain('-Infinity');
  });

  it('proposes a parsed negative zero field as ordinary numeric evidence', async () => {
    const root = await makeTree({
      'Number.md': '---\nkind: note\nbalance: -0\n---\n',
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.global_fields).toContainEqual(
      expect.objectContaining({
        name: 'balance',
        status: 'apply_ready',
        field_type: 'number',
        evidence: expect.objectContaining({
          shape_distribution: { number: 1 },
          sample_values: [0],
        }),
      }),
    );
    expect(result.data.needs_review.ambiguous_fields).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('non_finite_number');
  });

  it('summarizes recursive YAML aliases so analysis remains JSON serializable', async () => {
    const root = await makeTree({
      'Recursive.md': '---\nkind: note\nrecursive: &loop [*loop]\n---\n',
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.needs_review.ambiguous_fields).toEqual([
      expect.objectContaining({ name: 'recursive', status: 'needs_review' }),
    ]);
    const serialized = JSON.stringify(result);
    expect(JSON.parse(serialized)).toEqual(result);
    expect(serialized).toContain('cyclic_reference');
  });

  it('does not let non-plain YAML root sanitizer fields drive full analysis', async () => {
    const root = await makeTree({
      'Set.md': '---\n!!set\nkind:\n---\n',
    });

    const result = await analyze({ root, typeField: 'analyzer_value' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'TYPE_FIELD_NOT_FOUND' },
    });
    expect(result).not.toHaveProperty('data.proposal.global_fields');
  });

  it('omits unbounded ambiguity candidate paths from issue messages', async () => {
    const candidates = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `People/${String(index).padStart(3, '0')}/Same.md`,
      fm({ kind: 'person' }),
    ]));
    const root = await makeTree({
      ...candidates,
      'Task.md': fm({ kind: 'task', owner: '[[Same]]' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const issue = result.data.issues.find(item => item.code === 'REFERENCE_AMBIGUOUS');
    expect(issue?.examples[0]?.message).toBe('Reference target matches multiple files');
    expect(issue?.examples[0]?.message).not.toContain('People/');
  });

  it('sorts set-like report arrays and maps and caps issue examples deterministically', async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      `${String(11 - index).padStart(2, '0')}.md`,
      fm({
        kind: index === 0 ? ['zeta', 'Alpha', 4] : index === 1 ? ['Alpha', 4] : [4],
        zed: index,
        alpha: true,
      }),
    ]));
    const root = await makeTree(files);

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.global_fields.map(field => field.name)).toEqual(['alpha', 'zed']);
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['Alpha', 'zeta']);
    expect(Object.keys(result.data.proposal.schemas[0].evidence.parent_directories)).toEqual(['.']);
    expect(result.data.issues.map(issue => issue.code)).toEqual(
      [...result.data.issues.map(issue => issue.code)].sort(),
    );
    const invalid = result.data.issues.find(issue => issue.code === 'TYPE_VALUE_INVALID');
    expect(invalid).toMatchObject({ count: 12, truncated: true });
    expect(invalid?.examples).toHaveLength(10);
    expect(invalid?.examples.map(example => example.path)).toEqual([
      '00.md', '01.md', '02.md', '03.md', '04.md',
      '05.md', '06.md', '07.md', '08.md', '09.md',
    ]);
  });

  it('rejects empty exact-key inputs before scanning', async () => {
    await expect(analyze({ root: '', typeField: 'kind' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
    await expect(analyze({ root: '/not/scanned', typeField: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
  });
});

describe('IssueCollector', () => {
  it('retains only the deterministic best ten examples from an arbitrarily ordered stream', () => {
    const collector = new IssueCollector([]);

    for (let index = 99; index >= 0; index--) {
      collector.add('TYPE_VALUE_INVALID', {
        path: `${String(index).padStart(2, '0')}.md`,
        message: 'invalid type value',
      });
      expect(collector.retainedExampleCount('TYPE_VALUE_INVALID')).toBeLessThanOrEqual(10);
    }

    expect(collector.finish()).toEqual([{
      code: 'TYPE_VALUE_INVALID',
      count: 100,
      examples: Array.from({ length: 10 }, (_, index) => ({
        path: `${String(index).padStart(2, '0')}.md`,
        message: 'invalid type value',
      })),
      truncated: true,
    }]);
  });
});
