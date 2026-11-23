import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicCreateFile, readFileIfExists, readFileOrNull } from '../../src/pipeline/file-writer.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, linkSync: vi.fn(actual.linkSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const actualWrite = vi.mocked(writeFileSync).getMockImplementation()!;

let dirs: string[] = [];
afterEach(() => {
  vi.mocked(linkSync).mockClear();
  vi.mocked(writeFileSync).mockClear().mockImplementation(actualWrite);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 've-create-'));
  dirs.push(dir);
  return dir;
}

function linkFails(code: string): void {
  vi.mocked(linkSync).mockImplementationOnce(() => {
    throw Object.assign(new Error(`${code}: link failed`), { code });
  });
}

describe('atomicCreateFile', () => {
  it('creates the file whole, with its parent folders, and leaves no temp file', () => {
    const dir = root();
    const target = join(dir, 'notes', 'New.md');

    expect(atomicCreateFile(target, '# New\n', join(dir, '.tmp'))).toBe(true);

    expect(readFileSync(target, 'utf8')).toBe('# New\n');
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('keeps a file that already exists and reports it', () => {
    const dir = root();
    const target = join(dir, 'Taken.md');
    writeFileSync(target, 'theirs');

    expect(atomicCreateFile(target, 'ours', join(dir, '.tmp'))).toBe(false);

    expect(readFileSync(target, 'utf8')).toBe('theirs');
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it.each(['EPERM', 'EXDEV', 'ENOTSUP'])('falls back to an exclusive create when link fails with %s', code => {
    const dir = root();
    const created = join(dir, 'Created.md');
    const taken = join(dir, 'Taken.md');
    writeFileSync(taken, 'theirs');

    linkFails(code);
    expect(atomicCreateFile(created, 'ours', join(dir, '.tmp'))).toBe(true);
    linkFails(code);
    expect(atomicCreateFile(taken, 'ours', join(dir, '.tmp'))).toBe(false);

    expect(readFileSync(created, 'utf8')).toBe('ours');
    expect(readFileSync(taken, 'utf8')).toBe('theirs');
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('removes a partly written fallback file when the write fails', () => {
    const dir = root();
    const target = join(dir, 'New.md');
    linkFails('EPERM');
    // The temp file is written by path; only the exclusive create writes to a descriptor.
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file !== 'number') return actualWrite(file, data, options);
      actualWrite(file, String(data).slice(0, 2), options);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    expect(() => atomicCreateFile(target, 'ours', join(dir, '.tmp'))).toThrow('ENOSPC');

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });

  it('keeps a file another writer put in place before a failed fallback write is cleaned up', () => {
    const dir = root();
    const target = join(dir, 'New.md');
    linkFails('EPERM');
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file !== 'number') return actualWrite(file, data, options);
      // An editor saves over the path while this write is still going.
      actualWrite(join(dir, 'editor.tmp'), 'theirs');
      renameSync(join(dir, 'editor.tmp'), target);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    expect(() => atomicCreateFile(target, 'ours', join(dir, '.tmp'))).toThrow('ENOSPC');

    expect(readFileSync(target, 'utf8')).toBe('theirs');
  });

  it('propagates any other link failure without creating the file', () => {
    const dir = root();
    const target = join(dir, 'New.md');

    linkFails('EIO');
    expect(() => atomicCreateFile(target, 'ours', join(dir, '.tmp'))).toThrow('EIO');

    expect(readFileIfExists(target)).toBeNull();
    expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
  });
});

describe('readFileIfExists', () => {
  it('returns content, or null only for a missing file', () => {
    const dir = root();
    writeFileSync(join(dir, 'A.md'), 'a');

    expect(readFileIfExists(join(dir, 'A.md'))).toBe('a');
    expect(readFileIfExists(join(dir, 'Missing.md'))).toBeNull();
  });

  it('propagates a read failure that is not absence, where readFileOrNull hides it', () => {
    const dir = root();
    mkdirSync(join(dir, 'Folder.md'));

    expect(() => readFileIfExists(join(dir, 'Folder.md'))).toThrow(/EISDIR/);
    expect(readFileOrNull(join(dir, 'Folder.md'))).toBeNull();
  });
});
