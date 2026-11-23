import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTypeFieldCandidateReport,
  discoverTypeFields,
  extractCandidateOccurrence,
  normalizeTypeValue,
} from '../../src/analyzer/index.js';
import type { ScanSnapshot } from '../../src/analyzer/scan.js';
import { fm, makeScanTree } from './helpers.js';
import type { YamlValue } from '../../src/parser/types.js';

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

describe('normalizeTypeValue', () => {
  it('trims values and unwraps a whole wikilink while preserving aliases only as syntax', () => {
    expect(normalizeTypeValue('  [[Project|alias]]  ')).toBe('Project');
    expect(normalizeTypeValue('  plain type  ')).toBe('plain type');
    expect(normalizeTypeValue('   ')).toBeNull();
  });

  it('accepts the exact nested-array shape produced by an unquoted wikilink', () => {
    expect(extractCandidateOccurrence([[' [[Project]] ']] as unknown as YamlValue))
      .toEqual({ accepted: ['Project'], validShape: true });
    expect(extractCandidateOccurrence([['Project|Alias']] as unknown as YamlValue))
      .toEqual({ accepted: ['Project'], validShape: true });
    expect(extractCandidateOccurrence([['one', 'two']] as unknown as YamlValue))
      .toEqual({ accepted: [], validShape: false });
  });
});

describe('discoverTypeFields', () => {
  it('ranks conventional keys before stronger non-conventional candidates', async () => {
    const root = await makeTree({
      'A.md': fm({ types: ['note'], status: 'open' }),
      'B.md': fm({ status: 'open' }),
      'C.md': fm({ status: 'done' }),
    });
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates.map(candidate => candidate.key).slice(0, 2))
      .toEqual(['types', 'status']);
  });

  it('reports mixed lists as invalid occurrences but keeps their string members visible', async () => {
    const root = await makeTree({
      'A.md': '---\nkind: [note, 4]\n---\n',
    });
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates[0]).toMatchObject({
      key: 'kind',
      valid_occurrences: 0,
      invalid_occurrences: 1,
      sample_values: ['note'],
    });
  });

  it('canonicalizes aliases in unquoted nested wiki-link candidates', async () => {
    const root = await makeTree({
      'A.md': '---\nkind: [[Project|Alias]]\n---\n',
    });

    const result = await discoverTypeFields({ root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates[0]).toMatchObject({
      key: 'kind',
      distinct_values: 1,
      sample_values: ['Project'],
    });
  });

  it('does not surface inherited object keys as discovery candidates', async () => {
    const root = await makeTree({ 'A.md': fm({ kind: 'note' }) });

    const result = await discoverTypeFields({ root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates.map(candidate => candidate.key))
      .not.toEqual(expect.arrayContaining(['constructor', 'toString', '__proto__']));
  });

  it('treats a non-plain YAML root as malformed without exposing sanitizer fields', async () => {
    const root = await makeTree({
      'Set.md': '---\n!!set\nkind:\n---\n',
    });

    const result = await discoverTypeFields({ root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates.map(candidate => candidate.key))
      .not.toEqual(expect.arrayContaining(['analyzer_value', 'reason', 'summary']));
    expect(result.data.issues).toEqual([
      expect.objectContaining({ code: 'FRONTMATTER_MALFORMED', count: 1 }),
    ]);
  });

  it('counts non-string occurrences in metrics after another occurrence makes a key eligible', async () => {
    const root = await makeTree({
      'A.md': fm({ kind: 'note' }),
      'B.md': fm({ kind: 4 }),
    });
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates[0]).toMatchObject({
      key: 'kind',
      documents_with_key: 2,
      valid_occurrences: 1,
      invalid_occurrences: 1,
      valid_shape_ratio: 0.5,
    });
  });

  it('reports coverage, valid-shape ratio, distinct values, and repeated-value ratio', async () => {
    const root = await makeTree({
      'A.md': fm({ category: [' z ', 'a', 'a'] }),
      'B.md': fm({ category: ' [[b|display]] ' }),
      'C.md': fm({ category: [''] }),
      'D.md': fm({ other: 'value' }),
    });
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates).toContainEqual({
      key: 'category',
      documents_with_key: 3,
      valid_occurrences: 2,
      invalid_occurrences: 1,
      markdown_coverage: 0.75,
      valid_shape_ratio: 2 / 3,
      distinct_values: 3,
      repeated_value_ratio: 0.25,
      sample_values: ['a', 'b', 'z'],
      conventional_name: false,
    });
  });

  it('sorts samples exactly and caps them at ten values', async () => {
    const root = await makeTree(Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `${String(index).padStart(2, '0')}.md`,
        fm({ kind: `value-${String(11 - index).padStart(2, '0')}` }),
      ]),
    ));
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates[0].sample_values).toEqual([
      'value-00', 'value-01', 'value-02', 'value-03', 'value-04',
      'value-05', 'value-06', 'value-07', 'value-08', 'value-09',
    ]);
  });

  it('preserves exact large-stream counts while retaining only bounded samples', () => {
    const documentCount = 20_000;
    const distinctValueCount = 100;
    const snapshot: ScanSnapshot = {
      canonicalRoot: '/fixture',
      exclusions: [],
      folders: [],
      foldersTruncated: false,
      files: Array.from({ length: documentCount }, (_, index) => ({
        relativePath: `${String(index).padStart(5, '0')}.md`,
        title: String(index),
        contentHash: '',
        frontmatter: {
          hasFrontmatter: true,
          data: {
            kind: `value-${String(distinctValueCount - 1 - (index % distinctValueCount))
              .padStart(3, '0')}`,
          },
          parseError: null,
        },
        unreadable: false,
        tags: [],
      })),
      inventory: {
        total_files: documentCount,
        markdown_files: documentCount,
        non_markdown_by_extension: {},
        excluded_entries: { directories: 0, symlinks: 0 },
      },
      issues: [],
      sourceFingerprint: 'fixture',
    };

    const candidate = buildTypeFieldCandidateReport(snapshot).candidates[0];

    expect(candidate).toMatchObject({
      documents_with_key: documentCount,
      valid_occurrences: documentCount,
      distinct_values: distinctValueCount,
      repeated_value_ratio: 1 - (distinctValueCount / documentCount),
      sample_values: Array.from({ length: 10 }, (_, index) =>
        `value-${String(index).padStart(3, '0')}`),
    });
  });

  it('truncates after the first fifty sorted candidates', async () => {
    const root = await makeTree(Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [
        `${String(index).padStart(2, '0')}.md`,
        fm({ [`field-${String(index).padStart(2, '0')}`]: 'value' }),
      ]),
    ));
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates).toHaveLength(50);
    expect(result.data.candidates_truncated).toBe(true);
    expect(result.data.candidates[0].key).toBe('field-00');
    expect(result.data.candidates.at(-1)?.key).toBe('field-49');
    expect(result.data).not.toHaveProperty('selected_key');
  });

  it('uses exact key order to break otherwise equal non-conventional candidates', async () => {
    const root = await makeTree({
      'A.md': fm({ beta: 'same', alpha: 'same' }),
    });
    const result = await discoverTypeFields({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates.map(candidate => candidate.key)).toEqual(['alpha', 'beta']);
  });

  it('reports a folder with no eligible Markdown instead of refusing it', async () => {
    const root = await makeTree({ 'photo.png': 'x', 'Scans/receipt.pdf': 'x', 'Archive/Old.md': '# Old\n' });
    const result = await discoverTypeFields({ root, exclude: ['Archive'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.inventory).toMatchObject({ markdown_files: 0, non_markdown_by_extension: { '.pdf': 1, '.png': 1 } });
    expect(result.data.folders).toEqual([]);
    expect(result.data.candidates).toEqual([]);
    expect(result.data.source.source_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns invalid arguments for a missing or non-string root', async () => {
    await expect(discoverTypeFields({ root: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
    await expect(discoverTypeFields({ root: 42 as unknown as string })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    });
  });
});
