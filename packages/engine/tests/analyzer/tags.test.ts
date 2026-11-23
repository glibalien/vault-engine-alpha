import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze, discoverTypeFields } from '../../src/analyzer/index.js';
import { noteTags, tagCandidates } from '../../src/analyzer/tags.js';
import { fm, makeScanTree } from './helpers.js';

const roots: string[] = [];
async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await makeScanTree(files);
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const types = (report: { proposal: { type_assignment: { files: Array<{ path: string; types: string[] }> } } }) =>
  Object.fromEntries(report.proposal.type_assignment.files.map(file => [file.path, file.types]));

describe('noteTags', () => {
  it('reads inline and frontmatter tags, with the parents of nested ones', () => {
    expect(noteTags('Met with Dana. #meeting/standup #Acme\n\n```\n#notatag\n```\n', { tags: ['Planning', '#q3'] }).sort())
      .toEqual(['acme', 'meeting', 'meeting/standup', 'planning', 'q3']);
    expect(noteTags('', { tag: 'book, reading' }).sort()).toEqual(['book', 'reading']);
  });

  it('offers only tags that can name a kind and are on at least two notes', () => {
    const { candidates } = tagCandidates([['meeting', 'meeting/standup'], ['meeting', 'q3'], ['book'], ['q3']]);
    expect(candidates).toEqual([{ tag: 'meeting', documents: 2 }, { tag: 'q3', documents: 2 }]);
  });
});

describe('tag rules', () => {
  const tree = {
    'Evernote/Kickoff.md': 'Agenda for the call.\n\n#meeting\n',
    'Evernote/Standup.md': 'Notes. #meeting/standup\n',
    'Evernote/Soup.md': `${fm({ tags: ['recipe'] })}Lentils, onions.\n`,
    'Evernote/Both.md': 'A recipe we discussed in a meeting. #meeting #recipe\n',
    'Evernote/Typed.md': `${fm({ kind: 'book' })}Read it. #meeting\n`,
    'Meetings/Odd.md': 'In the meetings folder, tagged as a recipe. #recipe\n',
    'Meetings/Plain.md': 'No tags here.\n',
    'Other/Untagged.md': 'Nothing.\n',
  };

  it('types notes by the tags they carry: after the type field, before folders, every matching tag', async () => {
    const root = await makeTree(tree);
    const result = await analyze({
      root,
      typeField: 'kind',
      tagRules: [{ tag: 'meeting', type: 'meeting' }, { tag: '#Recipe', type: 'recipe' }],
      folderRules: [{ directory: 'Meetings', type: 'meeting' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(types(result.data)).toEqual({
      'Evernote/Both.md': ['meeting', 'recipe'],
      'Evernote/Kickoff.md': ['meeting'],
      'Evernote/Soup.md': ['recipe'],
      'Evernote/Standup.md': ['meeting'],
      // The type field wins over a tag.
      'Evernote/Typed.md': ['book'],
      // A tag wins over the folder.
      'Meetings/Odd.md': ['recipe'],
      'Meetings/Plain.md': ['meeting'],
      'Other/Untagged.md': [],
    });
    expect(result.data.coverage).toMatchObject({ typed_by_type_field: 1, typed_by_tag_rule: 5, typed_by_folder_rule: 1 });
    expect(result.data.proposal.type_assignment.tag_rules).toEqual([
      { tag: 'meeting', type: 'meeting', documents: 3 },
      { tag: 'recipe', type: 'recipe', documents: 3 },
    ]);
    // Offered: tags on notes the type field leaves untyped, so Typed.md's #meeting is not counted.
    expect(result.data.tags.candidates).toEqual([{ tag: 'meeting', documents: 3 }, { tag: 'recipe', documents: 3 }]);
  });

  it('types by tags alone, and leaves out a tag ruled null', async () => {
    const root = await makeTree(tree);
    const result = await analyze({ root, tagRules: [{ tag: 'meeting', type: 'meeting' }, { tag: 'recipe', type: null }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(types(result.data)['Evernote/Both.md']).toEqual(['meeting']);
    expect(types(result.data)['Evernote/Soup.md']).toEqual([]);
    expect(result.data.proposal.schemas.map(schema => schema.name)).toEqual(['meeting']);
  });

  it('refuses rules it cannot use', async () => {
    const root = await makeTree(tree);
    for (const tagRules of [[{ tag: '', type: 'meeting' }], [{ tag: 'a b', type: 'x' }], [{ tag: 'meeting', type: 'bad/name' }], [{ tag: 'meeting', type: 'm' }, { tag: '#Meeting', type: 'n' }]]) {
      const result = await analyze({ root, tagRules });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENTS');
    }
  });

  it('lists the tags in discovery, before any rule', async () => {
    const root = await makeTree(tree);
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags.candidates).toEqual([{ tag: 'meeting', documents: 4 }, { tag: 'recipe', documents: 3 }]);
  });
});
