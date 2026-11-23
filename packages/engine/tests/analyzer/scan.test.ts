import { chmod, realpath, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintEntries } from '../../src/analyzer/fingerprint.js';
import { readContainedFile, scanRoot } from '../../src/analyzer/scan.js';
import { setExcludeDirs } from '../../src/indexer/ignore.js';
import type { AnalyzerRefusalCode } from '../../src/analyzer/report.js';
import { fm, makeScanTree, snapshotTree } from './helpers.js';

const roots: string[] = [];

async function makeTree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await makeScanTree(files);
  roots.push(root);
  return root;
}

async function expectScanRefusal(root: string, code: AnalyzerRefusalCode): Promise<void> {
  const result = await scanRoot(root);
  expect(result).toMatchObject({ ok: false, error: { code } });
}

afterEach(async () => {
  setExcludeDirs([]);
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe('scanRoot', () => {
  it('walks recursively and applies Engine built-in exclusions without following symlinks', async () => {
    const root = await makeTree({
      'Visible.md': '---\nkind: note\n---\n',
      '.notes/Hidden.md': '---\nkind: note\n---\n',
      '.git/Ignored.md': '---\nkind: note\n---\n',
      '.obsidian/Ignored.md': '---\nkind: note\n---\n',
      '.trash/Ignored.md': '---\nkind: note\n---\n',
      '.sync-conflict-20260902.md': '---\nkind: note\n---\n',
      'node_modules/pkg/Ignored.md': '---\nkind: note\n---\n',
      'assets/image.png': 'png',
    });
    await symlink(join(root, 'Visible.md'), join(root, 'Alias.md'));

    const result = await scanRoot(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files.map(file => file.relativePath))
      .toEqual(['Visible.md']);
    expect(result.data.inventory.non_markdown_by_extension).toEqual({ '.png': 1 });
    expect(result.data.inventory.excluded_entries).toEqual({ directories: 5, symlinks: 1 });
  });

  it('does not inherit mutable runtime exclusions', async () => {
    const root = await makeTree({
      'RuntimeExcluded/StillEligible.md': fm({ kind: 'note' }),
    });
    setExcludeDirs(['RuntimeExcluded']);

    const result = await scanRoot(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files.map(file => file.relativePath))
      .toEqual(['RuntimeExcluded/StillEligible.md']);
  });

  it('returns NO_MARKDOWN_FILES without creating output', async () => {
    const root = await makeTree({ 'asset.txt': 'x' });
    const before = await snapshotTree(root);
    await expectScanRefusal(root, 'NO_MARKDOWN_FILES');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('refuses missing roots and paths that are not directories', async () => {
    const root = await makeTree({ 'Note.md': fm({ kind: 'note' }) });
    await expectScanRefusal(join(root, 'missing'), 'INVALID_ROOT');
    await expectScanRefusal(join(root, 'Note.md'), 'INVALID_ROOT');
  });

  it('returns ROOT_UNREADABLE when the root cannot be traversed', async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTree({ 'Note.md': fm({ kind: 'note' }) });
    await chmod(root, 0o000);
    await expectScanRefusal(root, 'ROOT_UNREADABLE');
  });

  it('records malformed YAML without retaining a Markdown body', async () => {
    const root = await makeTree({ 'Broken.md': '---\nkey: [\n---\nprivate body\n' });

    const result = await scanRoot(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files).toMatchObject([{
      relativePath: 'Broken.md',
      frontmatter: { hasFrontmatter: true, data: {}, parseError: expect.any(String) },
      unreadable: false,
    }]);
    expect(JSON.stringify(result.data)).not.toContain('private body');
    expect(result.data.issues).toMatchObject([{
      code: 'FRONTMATTER_MALFORMED',
      count: 1,
      examples: [{ path: 'Broken.md', message: expect.any(String) }],
      truncated: false,
    }]);
  });

  it('uses the unreadable sentinel in the fingerprint and continues scanning other files', async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTree({
      'Readable.md': fm({ kind: 'note' }),
      'Unreadable.md': fm({ kind: 'secret' }),
    });
    await chmod(join(root, 'Unreadable.md'), 0o000);

    const result = await scanRoot(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files).toMatchObject([
      { relativePath: 'Readable.md', unreadable: false },
      { relativePath: 'Unreadable.md', frontmatter: null, unreadable: true },
    ]);
    expect(result.data.issues).toMatchObject([{
      code: 'FILE_UNREADABLE',
      count: 1,
      examples: [{ path: 'Unreadable.md', message: expect.any(String) }],
      truncated: false,
    }]);
    expect(result.data.sourceFingerprint).toBe(fingerprintEntries([
      { relativePath: 'Readable.md', content: Buffer.from(fm({ kind: 'note' })) },
      { relativePath: 'Unreadable.md', content: 'UNREADABLE' },
    ]));
  });

  it('bounds malformed-frontmatter examples while preserving the full count', async () => {
    const root = await makeTree(Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [
        `Broken-${String(index).padStart(2, '0')}.md`,
        '---\nkey: [\n---\n',
      ]),
    ));

    const result = await scanRoot(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.issues).toMatchObject([{
      code: 'FRONTMATTER_MALFORMED',
      count: 11,
      examples: Array.from({ length: 10 }, (_, index) => ({
        path: `Broken-${String(index).padStart(2, '0')}.md`,
      })),
      truncated: true,
    }]);
  });

  it('treats .MD files as Markdown and inventories extensionless files under [none]', async () => {
    const root = await makeTree({
      'Upper.MD': fm({ kind: 'note' }),
      'LICENSE': 'terms',
    });

    const result = await scanRoot(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files.map(file => file.relativePath)).toEqual(['Upper.MD']);
    expect(result.data.files[0].title).toBe('Upper');
    expect(result.data.inventory).toMatchObject({
      total_files: 2,
      markdown_files: 1,
      non_markdown_by_extension: { '[none]': 1 },
    });
  });

  it('sorts Markdown paths and source fingerprints by relative path', async () => {
    const root = await makeTree({
      'z/Last.md': fm({ kind: 'note' }),
      'Alpha.md': fm({ kind: 'note' }),
      'middle/First.md': fm({ kind: 'note' }),
    });

    const result = await scanRoot(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files.map(file => file.relativePath))
      .toEqual(['Alpha.md', 'middle/First.md', 'z/Last.md']);
    expect(result.data.sourceFingerprint).toBe(fingerprintEntries([
      { relativePath: 'z/Last.md', content: Buffer.from(fm({ kind: 'note' })) },
      { relativePath: 'Alpha.md', content: Buffer.from(fm({ kind: 'note' })) },
      { relativePath: 'middle/First.md', content: Buffer.from(fm({ kind: 'note' })) },
    ]));
  });

  it('uses exact global path order rather than locale or traversal order', async () => {
    const root = await makeTree({
      'a/Inside.md': fm({ kind: 'note' }),
      'a.md': fm({ kind: 'note' }),
      'Z.md': fm({ kind: 'note' }),
    });

    const result = await scanRoot(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files.map(file => file.relativePath))
      .toEqual(['Z.md', 'a.md', 'a/Inside.md']);
  });

  it('refuses an ancestor swap that preserves the opened directory inode', async () => {
    if (process.platform !== 'linux') return;
    const root = await makeTree({
      'Container/Notes/Inside.md': fm({ kind: 'note' }),
      'Container/Outside.md': fm({ kind: 'secret' }),
    });
    const outsideRoot = await makeTree({});
    const container = join(root, 'Container');
    const movedContainer = join(outsideRoot, 'Container');
    let swapped = false;

    const result = await scanRoot(root, {
      afterDirectoryPreflight: async ({ relativePath }) => {
        if (relativePath !== 'Container/Notes') return;
        await rename(container, movedContainer);
        await symlink(movedContainer, container);
        swapped = true;
      },
    });

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: 'ROOT_UNREADABLE' } });
    expect(JSON.stringify(result)).not.toContain('Outside.md');
  });
});

describe('readContainedFile', () => {
  it('rejects a file replaced by an external symlink after preflight validation', async () => {
    const root = await makeTree({ 'Note.md': 'inside' });
    const outsideRoot = await makeTree({ 'Secret.md': 'outside secret' });
    const target = join(root, 'Note.md');

    await expect(readContainedFile(await realpath(root), target, {
      afterPreflight: async () => {
        await rm(target);
        await symlink(join(outsideRoot, 'Secret.md'), target);
      },
    })).rejects.toThrow();
  });

  it('rejects an ancestor directory replaced by an external symlink during the read', async () => {
    if (process.platform !== 'linux') return;
    const root = await makeTree({ 'Notes/Note.md': 'inside' });
    const outsideRoot = await makeTree({ 'Note.md': 'outside secret' });
    const notesDirectory = join(root, 'Notes');
    const target = join(notesDirectory, 'Note.md');
    let reachedRead = false;

    await expect(readContainedFile(await realpath(root), target, {
      afterPreflight: async () => {
        await rm(notesDirectory, { recursive: true });
        await symlink(outsideRoot, notesDirectory);
      },
      beforeRead: async () => {
        reachedRead = true;
      },
    })).rejects.toThrow();
    expect(reachedRead).toBe(false);
  });
});

describe('fingerprintEntries', () => {
  it('distinguishes readable bytes from the unreadable marker', () => {
    expect(fingerprintEntries([{ relativePath: 'a.md', content: Buffer.from('UNREADABLE') }]))
      .not.toBe(fingerprintEntries([{ relativePath: 'a.md', content: 'UNREADABLE' }]));
  });

  it('length-prefixes content so NUL bytes cannot collide with entry boundaries', () => {
    expect(fingerprintEntries([{
      relativePath: 'a',
      content: Buffer.concat([
        Buffer.from('x'),
        Buffer.from([0]),
        Buffer.from('1:b'),
        Buffer.from([0]),
        Buffer.from('y'),
      ]),
    }])).not.toBe(fingerprintEntries([
      { relativePath: 'a', content: Buffer.from('x') },
      { relativePath: 'b', content: Buffer.from('y') },
    ]));
  });

  it('uses exact locale-independent path ordering', () => {
    expect(fingerprintEntries([
      { relativePath: 'a.md', content: Buffer.from('a') },
      { relativePath: 'Z.md', content: Buffer.from('z') },
    ])).toBe('d1e8a59afa0a1c36ad3cddfdf8b34348d64521f31f9984b45e16dfbd6b2e7843');
  });

  it('length-prefixes paths before hashing their complete byte contents', () => {
    expect(fingerprintEntries([{ relativePath: 'a', content: Buffer.from('bc') }]))
      .not.toBe(fingerprintEntries([{ relativePath: 'ab', content: Buffer.from('c') }]));
  });
});
