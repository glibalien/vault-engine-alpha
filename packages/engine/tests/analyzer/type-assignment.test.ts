import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze, discoverTypeFields, matchFolderRule } from '../../src/analyzer/index.js';
import { isInExcludedDir, normalizeExcludeDirs, setExcludeDirs, shouldIgnore } from '../../src/indexer/ignore.js';
import { fm, makeScanTree } from './helpers.js';

const roots: string[] = [];

async function makeTree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await makeScanTree(files);
  roots.push(root);
  return root;
}

afterEach(async () => {
  setExcludeDirs([]);
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('folder type rules', () => {
  it('types files by folder, including files without frontmatter', async () => {
    const root = await makeTree({
      'Meetings/2026/Kickoff.md': fm({ attendees: 3 }),
      'Meetings/2026/Review.md': '# No frontmatter\n',
      'Meetings/Standup.md': fm({ attendees: 5 }),
      'Loose.md': fm({ attendees: 1 }),
    });

    const result = await analyze({ root, folderRules: [{ directory: 'Meetings', type: 'meeting' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source.confirmed_type_field).toBeNull();
    expect(result.data.proposal.type_field_mapping).toBeNull();
    expect(result.data.coverage).toMatchObject({
      typed_files: 3,
      untyped_files: 1,
      typed_by_type_field: 0,
      typed_by_folder_rule: 3,
    });
    expect(result.data.proposal.type_assignment.folder_rules).toEqual([
      { directory: 'Meetings', type: 'meeting', markdown_files: 3, documents: 3 },
    ]);
    expect(result.data.proposal.schemas).toEqual([expect.objectContaining({
      name: 'meeting',
      default_directory: 'Meetings',
      field_claims: [expect.objectContaining({ field: 'attendees' })],
    })]);
    expect(result.data.issues.map(issue => issue.code)).not.toContain('TYPE_KEY_INCOMPLETE_COVERAGE');
  });

  it('lets the deepest rule win and a null rule leave its subtree untyped', async () => {
    const root = await makeTree({
      'Work/A.md': fm({ x: 1 }),
      'Work/Meetings/B.md': fm({ x: 2 }),
      'Work/Archive/C.md': fm({ x: 3 }),
      'Work/Archive/Meetings/D.md': fm({ x: 4 }),
    });

    const result = await analyze({
      root,
      folderRules: [
        { directory: 'Work', type: 'note' },
        { directory: 'Work/Meetings', type: 'meeting' },
        { directory: 'Work/Archive', type: null },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.type_assignment.folder_rules).toEqual([
      { directory: 'Work', type: 'note', markdown_files: 1, documents: 1 },
      { directory: 'Work/Archive', type: null, markdown_files: 2, documents: 0 },
      { directory: 'Work/Meetings', type: 'meeting', markdown_files: 1, documents: 1 },
    ]);
    expect(result.data.proposal.schemas.map(schema => [schema.name, schema.evidence.typed_documents]))
      .toEqual([['meeting', 1], ['note', 1]]);
  });

  it('matches whole path segments only', () => {
    const rules = [{ directory: 'Notes', segments: ['Notes'], type: 'note' }];
    expect(matchFolderRule(rules, 'Notes/A.md')?.directory).toBe('Notes');
    expect(matchFolderRule(rules, 'TaskNotes/A.md')).toBeNull();
    expect(matchFolderRule(rules, 'Notes.md')).toBeNull();
  });

  it('prefers the type field and fills gaps from folder rules', async () => {
    const root = await makeTree({
      'Projects/Keyed.md': fm({ kind: 'initiative', status: 'open' }),
      'Projects/Plain.md': fm({ status: 'done' }),
    });

    const result = await analyze({
      root,
      typeField: 'kind',
      folderRules: [{ directory: 'Projects', type: 'project' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage).toMatchObject({ typed_by_type_field: 1, typed_by_folder_rule: 1 });
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['initiative', 'project']);
    expect(result.data.proposal.type_assignment.folder_rules)
      .toEqual([{ directory: 'Projects', type: 'project', markdown_files: 2, documents: 1 }]);
    expect(result.data.issues).toContainEqual(expect.objectContaining({
      code: 'TYPE_KEY_INCOMPLETE_COVERAGE',
      count: 1,
      examples: [expect.objectContaining({ path: 'Projects/Plain.md' })],
    }));
  });

  it('falls back to the folder rule when every type-field value is dropped', async () => {
    const root = await makeTree({
      'Clips/A.md': fm({ kind: 'misc' }),
      'Clips/B.md': fm({ kind: 'clipping' }),
    });

    const result = await analyze({
      root,
      typeField: 'kind',
      folderRules: [{ directory: 'Clips', type: 'clipping' }],
      typeRenames: { misc: null },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => [schema.name, schema.evidence.typed_documents]))
      .toEqual([['clipping', 2]]);
    expect(result.data.proposal.type_assignment.type_field_values).toEqual([
      { value: 'clipping', type: 'clipping', documents: 1 },
      { value: 'misc', type: null, documents: 1 },
    ]);
    expect(result.data.coverage).toMatchObject({ typed_by_type_field: 1, typed_by_folder_rule: 1 });
  });

  it('lets a rename rescue a value that is not a safe schema name', async () => {
    const root = await makeTree({ 'A.md': fm({ kind: '_inbox' }) });

    const result = await analyze({ root, typeField: 'kind', typeRenames: { _inbox: 'inbox' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['inbox']);
    expect(result.data.issues.map(issue => issue.code)).not.toContain('TYPE_VALUE_INVALID');
  });

  it('refuses folder typing for documents that already carry canonical types', async () => {
    const root = await makeTree({
      'Projects/Typed.md': fm({ types: ['legacy'] }),
      'Projects/Plain.md': fm({ status: 'open' }),
    });

    const result = await analyze({ root, folderRules: [{ directory: 'Projects', type: 'project' }] });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'TYPE_FIELD_TARGET_COLLISION',
        message: 'Assigned types cannot be mapped to "types" because typed documents already contain it',
        details: {
          type_field: null,
          target_field: 'types',
          conflicting_files: ['Projects/Typed.md'],
          conflicts_truncated: false,
        },
      },
    });
  });

  it.each([
    ['a name that is not a safe schema filename', 'types: _legacy'],
    ['an unquoted wiki-link that YAML parses as a nested list', 'types: [[legacy]]'],
    ['a non-string value', 'types: [1]'],
  ])('refuses folder typing over existing canonical types holding %s', async (_label, line) => {
    const root = await makeTree({ 'Projects/A.md': `---\n${line}\n---\n` });

    await expect(analyze({ root, folderRules: [{ directory: 'Projects', type: 'project' }] }))
      .resolves.toMatchObject({
        ok: false,
        error: {
          code: 'TYPE_FIELD_TARGET_COLLISION',
          details: { conflicting_files: ['Projects/A.md'] },
        },
      });
  });

  it.each([
    ['null', 'types:'],
    ['an empty string', "types: ''"],
    ['an empty list', 'types: []'],
  ])('folder-types a document whose canonical types key is %s', async (_label, line) => {
    const root = await makeTree({ 'Projects/A.md': `---\n${line}\n---\n` });

    const result = await analyze({ root, folderRules: [{ directory: 'Projects', type: 'project' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['project']);
  });

  it('ignores an empty canonical types key and never proposes it as a field', async () => {
    const root = await makeTree({ 'Projects/A.md': '---\ntypes:\nstatus: open\n---\n' });

    const result = await analyze({ root, folderRules: [{ directory: 'Projects', type: 'project' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.global_fields.map(field => field.name)).toEqual(['status']);
  });

  it('keeps canonical types where present when types is the confirmed field', async () => {
    const root = await makeTree({
      'Projects/Typed.md': fm({ types: ['initiative'] }),
      'Projects/Plain.md': fm({ status: 'open' }),
    });

    const result = await analyze({
      root,
      typeField: 'types',
      folderRules: [{ directory: 'Projects', type: 'project' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['initiative', 'project']);
  });

  it('reports rules that match no Markdown, including rules inside exclusions', async () => {
    const root = await makeTree({
      'Notes/A.md': fm({ x: 1 }),
      'Templates/Meeting.md': fm({ x: 2 }),
    });

    const result = await analyze({
      root,
      exclude: ['Templates'],
      folderRules: [
        { directory: 'Notes', type: 'note' },
        { directory: 'Missing', type: 'missing' },
        { directory: 'Templates', type: 'template' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.issues).toContainEqual({
      code: 'FOLDER_RULE_UNMATCHED',
      count: 2,
      examples: [
        { path: 'Missing', message: 'Folder rule matches no eligible Markdown file' },
        { path: 'Templates', message: 'Folder rule matches no eligible Markdown file' },
      ],
      truncated: false,
    });
  });

  it('keeps multi-type ownership when a colliding name is withheld', async () => {
    const root = await makeTree({
      'Mixed/A.md': fm({ kind: ['Meeting', 'project'], agenda: 'kickoff' }),
      'Meetings/B.md': fm({ kind: 'meeting' }),
      'Projects/C.md': fm({ kind: 'project', status: 'open' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const project = result.data.proposal.schemas.find(schema => schema.name === 'project');
    expect(project).toMatchObject({
      default_directory: 'Projects',
      evidence: { typed_documents: 2, single_type_documents: 1 },
    });
    expect(project?.field_claims.map(claim => claim.field)).toEqual(['status']);
    expect(result.data.needs_review.ambiguous_claims).toEqual([{
      field: 'agenda',
      candidate_types: ['Meeting', 'project'],
      multi_type_documents: 1,
      status: 'needs_review',
    }]);
  });

  it('refuses folder rules that type nothing', async () => {
    const root = await makeTree({ 'Notes/A.md': fm({ x: 1 }) });

    await expect(analyze({ root, folderRules: [{ directory: 'Notes', type: null }] }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'NO_USABLE_TYPE_VALUES', message: 'Type assignment produces no typed documents' },
      });
  });
});

describe('per-file assignment', () => {
  it('lists every eligible file with its final types, in path order', async () => {
    const root = await makeTree({
      'Projects/Alpha.md': fm({ kind: 'Project' }),
      'Projects/Beta.md': fm({ kind: 'misc' }),
      'Meetings/Sync.md': fm({ kind: ['meeting', 'note'] }),
      'Inbox.md': '# Inbox\n',
      'Broken.md': '---\nkind: [\n---\n',
    });

    const result = await analyze({
      root,
      typeField: 'kind',
      typeRenames: { Project: 'project', misc: null },
      folderRules: [{ directory: 'Projects', type: 'project' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposal.type_assignment.files).toEqual([
      { path: 'Broken.md', types: [] },
      { path: 'Inbox.md', types: [] },
      { path: 'Meetings/Sync.md', types: ['meeting', 'note'] },
      { path: 'Projects/Alpha.md', types: ['project'] },
      { path: 'Projects/Beta.md', types: ['project'] },
    ]);
  });

  it('leaves withheld colliding names out of each file\'s types', async () => {
    const root = await makeTree({
      'A.md': fm({ kind: ['meeting', 'call'] }),
      'B.md': fm({ kind: 'Meeting' }),
    });

    const result = await analyze({ root, typeField: 'kind' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.needs_review.type_name_collisions).toEqual([{ names: ['Meeting', 'meeting'], documents: 2 }]);
    expect(result.data.proposal.type_assignment.files).toEqual([
      { path: 'A.md', types: ['call'] },
      { path: 'B.md', types: [] },
    ]);
  });
});

describe('analysis input validation', () => {
  it.each([
    ['no type field or rules', {}],
    ['an empty type field', { typeField: '' }],
    ['renames without a type field', { folderRules: [{ directory: 'A', type: 'a' }], typeRenames: { x: 'y' } }],
    ['a parent-relative rule directory', { folderRules: [{ directory: '../A', type: 'a' }] }],
    ['an absolute rule directory', { folderRules: [{ directory: '/A', type: 'a' }] }],
    ['an empty rule segment', { folderRules: [{ directory: 'A//B', type: 'a' }] }],
    ['a padded rule directory', { folderRules: [{ directory: ' A', type: 'a' }] }],
    ['a duplicate rule directory', {
      folderRules: [{ directory: 'A', type: 'a' }, { directory: 'A/', type: 'b' }],
    }],
    ['an unsafe rule type', { folderRules: [{ directory: 'A', type: '_fields' }] }],
    ['a nested rule type', { folderRules: [{ directory: 'A', type: 'a/b' }] }],
    ['a padded rule type', { folderRules: [{ directory: 'A', type: ' a' }] }],
    ['a wiki-link rule type', { folderRules: [{ directory: 'A', type: '[[meeting]]' }] }],
    ['a wiki-link rename target', { typeField: 'kind', typeRenames: { a: '[[meeting|M]]' } }],
    ['an unsafe rename target', { typeField: 'kind', typeRenames: { a: 'CON' } }],
    ['a padded rename source', { typeField: 'kind', typeRenames: { ' a': 'b' } }],
    ['a non-array exclusion', { typeField: 'kind', exclude: 'Templates' }],
    ['a parent-relative exclusion', { typeField: 'kind', exclude: ['..'] }],
    ['non-object field types', { typeField: 'kind', fieldTypes: [] }],
    ['an empty field type name', { typeField: 'kind', fieldTypes: { '': { field_type: 'string' } } }],
    ['an enum field type', { typeField: 'kind', fieldTypes: { status: { field_type: 'enum' } } }],
    ['a list without its item type', { typeField: 'kind', fieldTypes: { tags: { field_type: 'list' } } }],
    ['a list of lists', { typeField: 'kind', fieldTypes: { tags: { field_type: 'list', list_item_type: 'list' } } }],
    ['an item type on a scalar', { typeField: 'kind', fieldTypes: { due: { field_type: 'date', list_item_type: 'date' } } }],
    ['an extra field type key', { typeField: 'kind', fieldTypes: { due: { field_type: 'date', required: true } } }],
  ])('refuses %s before scanning', async (_label, input) => {
    const result = await analyze({ root: '/definitely/missing/root', ...input } as never);

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  });
});

describe('exclusions', () => {
  it('leaves excluded directories out of inventory, inference, and the fingerprint', async () => {
    const root = await makeTree({
      'Projects/A.md': fm({ kind: 'project', status: 'open' }),
      'Templates/Project.md': fm({ kind: 'project', status: '{{status}}', due: '{{date}}' }),
      'Templates/logo.png': Buffer.from([1, 2, 3]),
    });

    const result = await analyze({ root, typeField: 'kind', exclude: ['Templates/'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source.exclusions).toEqual(['Templates']);
    expect(result.data.inventory).toMatchObject({
      total_files: 1,
      markdown_files: 1,
      non_markdown_by_extension: {},
      excluded_entries: { directories: 1, symlinks: 0 },
    });
    expect(result.data.proposal.global_fields.map(field => field.name)).toEqual(['status']);

    await writeFile(join(root, 'Templates/Project.md'), fm({ kind: 'changed' }));
    const rerun = await analyze({ root, typeField: 'kind', exclude: ['Templates'] });
    expect(rerun.ok && rerun.data.source.source_fingerprint).toBe(result.data.source.source_fingerprint);
  });

  it('matches exclusions from the root by whole segments, like Engine', async () => {
    const root = await makeTree({
      'Notes/A.md': fm({ kind: 'note' }),
      'TaskNotes/B.md': fm({ kind: 'task' }),
      'Archive/Old/C.md': fm({ kind: 'note' }),
      'Archive/D.md': fm({ kind: 'note' }),
      'Deep/Notes/E.md': fm({ kind: 'note' }),
    });
    const exclude = ['Notes', 'Archive/Old'];

    const result = await analyze({ root, typeField: 'kind', exclude });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const included = ['Archive/D.md', 'Deep/Notes/E.md', 'TaskNotes/B.md'];
    expect(result.data.inventory.markdown_files).toBe(included.length);
    setExcludeDirs(exclude);
    for (const path of ['Notes/A.md', 'TaskNotes/B.md', 'Archive/Old/C.md', 'Archive/D.md', 'Deep/Notes/E.md']) {
      expect(shouldIgnore(path, { pathStyle: 'posix' })).toBe(!included.includes(path));
      expect(isInExcludedDir(path, normalizeExcludeDirs(exclude), { pathStyle: 'posix' }))
        .toBe(!included.includes(path));
    }
  });
});

describe('discovery folders', () => {
  it('lists folders with direct and subtree Markdown counts and honors exclusions', async () => {
    const root = await makeTree({
      'Root.md': fm({ kind: 'note' }),
      'Projects/A.md': fm({ kind: 'project' }),
      'Projects/Archive/B.md': fm({ kind: 'project' }),
      'Projects/Archive/C.md': fm({ kind: 'project' }),
      'Assets/image.png': Buffer.from([1]),
      'Templates/T.md': fm({ kind: 'template' }),
    });

    const result = await discoverTypeFields({ root, exclude: ['Templates'] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.format_version).toBe(2);
    expect(result.data.source.exclusions).toEqual(['Templates']);
    expect(result.data.folders).toEqual([
      { path: 'Projects', markdown_files: 1, subtree_markdown_files: 3 },
      { path: 'Projects/Archive', markdown_files: 2, subtree_markdown_files: 2 },
    ]);
    expect(result.data.folders_truncated).toBe(false);
    expect(result.data.candidates[0]).toMatchObject({ key: 'kind', documents_with_key: 4 });
  });

  it('keeps the shallowest folders when the list is truncated', async () => {
    const root = await makeTree({ 'Top/Note.md': fm({ kind: 'note' }) });
    for (let index = 0; index < 1000; index++) {
      const directory = join(root, 'Top', `Sub${String(index).padStart(4, '0')}`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'N.md'), fm({ kind: 'note' }));
    }

    const result = await discoverTypeFields({ root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.folders_truncated).toBe(true);
    expect(result.data.folders).toHaveLength(1000);
    expect(result.data.folders[0]).toEqual({
      path: 'Top',
      markdown_files: 1,
      subtree_markdown_files: 1001,
    });
    expect(result.data.folders.at(-1)?.path).toBe('Top/Sub0998');
  });

  it('refuses invalid discovery exclusions', async () => {
    await expect(discoverTypeFields({ root: '/missing', exclude: ['/abs'] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  });
});
