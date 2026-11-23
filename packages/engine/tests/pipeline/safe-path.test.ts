import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeRealVaultPath, safeVaultPath, sameVaultFile } from '../../src/pipeline/safe-path.js';

describe('safeVaultPath', () => {
  const vault = '/srv/example-vault';

  it('allows simple relative paths', () => {
    expect(safeVaultPath(vault, 'notes/file.md')).toBe('/srv/example-vault/notes/file.md');
  });

  it('allows nested directories', () => {
    expect(safeVaultPath(vault, 'a/b/c/file.md')).toBe('/srv/example-vault/a/b/c/file.md');
  });

  it('allows bare filenames', () => {
    expect(safeVaultPath(vault, 'file.md')).toBe('/srv/example-vault/file.md');
  });

  it('blocks ../ traversal', () => {
    expect(() => safeVaultPath(vault, '../etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks ../../ traversal', () => {
    expect(() => safeVaultPath(vault, '../../etc/shadow')).toThrow('Path traversal blocked');
  });

  it('blocks mid-path traversal', () => {
    expect(() => safeVaultPath(vault, 'notes/../../etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks directory param traversal', () => {
    expect(() => safeVaultPath(vault, '../../.ssh/authorized_keys')).toThrow('Path traversal blocked');
  });

  it('allows paths that contain .. in names but stay inside vault', () => {
    // A file literally named "foo..bar.md" is fine
    expect(safeVaultPath(vault, 'foo..bar.md')).toBe('/srv/example-vault/foo..bar.md');
  });

  it('blocks absolute paths that escape vault', () => {
    expect(() => safeVaultPath(vault, '/etc/passwd')).toThrow('Path traversal blocked');
  });

  it('allows the vault root itself', () => {
    expect(safeVaultPath(vault, '')).toBe('/srv/example-vault');
    expect(safeVaultPath(vault, '.')).toBe('/srv/example-vault');
  });
});

describe('safeRealVaultPath', () => {
  // <root>/vault, a sibling <root>/vault-other sharing its prefix, and <root>/outside.png.
  let root: string;
  let vault: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-engine-realpath-')));
    vault = join(root, 'vault');
    mkdirSync(join(vault, 'Attachments'), { recursive: true });
    mkdirSync(join(root, 'vault-other'));
    writeFileSync(join(vault, 'Attachments', 'inside.png'), 'x');
    writeFileSync(join(root, 'vault-other', 'sibling.png'), 'x');
    writeFileSync(join(root, 'outside.png'), 'x');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the real path of a file inside the vault', () => {
    const file = join(vault, 'Attachments', 'inside.png');
    expect(safeRealVaultPath(vault, file)).toBe(file);
  });

  it('allows the vault root itself', () => {
    expect(safeRealVaultPath(vault, vault)).toBe(vault);
  });

  it('follows a symlink to a file elsewhere inside the vault', () => {
    const link = join(vault, 'link.png');
    symlinkSync(join(vault, 'Attachments', 'inside.png'), link);
    expect(safeRealVaultPath(vault, link)).toBe(join(vault, 'Attachments', 'inside.png'));
  });

  it('blocks a symlink inside the vault that points outside it', () => {
    const link = join(vault, 'Attachments', 'escape.png');
    symlinkSync(join(root, 'outside.png'), link);
    expect(() => safeRealVaultPath(vault, link)).toThrow('Path traversal blocked');
  });

  it('blocks a symlinked folder that leads outside the vault', () => {
    symlinkSync(root, join(vault, 'up'));
    expect(() => safeRealVaultPath(vault, join(vault, 'up', 'outside.png'))).toThrow('Path traversal blocked');
  });

  it('blocks a sibling folder whose name starts with the vault name', () => {
    const link = join(vault, 'sibling.png');
    symlinkSync(join(root, 'vault-other', 'sibling.png'), link);
    expect(() => safeRealVaultPath(vault, link)).toThrow('Path traversal blocked');
  });

  it('compares real paths when the vault root is a symlink', () => {
    const linkedRoot = join(root, 'vault-link');
    symlinkSync(vault, linkedRoot);
    expect(safeRealVaultPath(linkedRoot, join(linkedRoot, 'Attachments', 'inside.png')))
      .toBe(join(vault, 'Attachments', 'inside.png'));
    expect(() => safeRealVaultPath(linkedRoot, join(root, 'outside.png'))).toThrow('Path traversal blocked');
  });

  it('throws for a path that does not exist', () => {
    expect(() => safeRealVaultPath(vault, join(vault, 'missing.png'))).toThrow();
  });
});

describe('sameVaultFile', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'same-vault-file-'));
    mkdirSync(join(vault, 'Settings'));
    mkdirSync(join(vault, 'Notes'));
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it('is true for the same path and for other spellings of it', () => {
    for (const spelled of [
      'Settings/Memories.md', 'Settings/./Memories.md', 'Settings//Memories.md', './Settings/Memories.md',
      'Notes/../Settings/Memories.md', 'Missing/../Settings/Memories.md', 'Settings\\Memories.md',
    ]) {
      expect(sameVaultFile(vault, spelled, 'Settings/Memories.md'), spelled).toBe(true);
    }
  });

  it('ignores case and trailing dots or spaces, which some filesystems ignore', () => {
    for (const spelled of ['settings/memories.md', 'SETTINGS/Memories.MD', 'Settings/Memories.md.', 'Settings./Memories.md', 'Settings /Memories.md']) {
      expect(sameVaultFile(vault, spelled, 'Settings/Memories.md'), spelled).toBe(true);
    }
  });

  it('follows a symlinked folder, a symlinked file and a symlinked vault root', () => {
    symlinkSync(join(vault, 'Settings'), join(vault, 'Shortcut'));
    expect(sameVaultFile(vault, 'Shortcut/Memories.md', 'Settings/Memories.md')).toBe(true);
    // The folder below the symlink does not exist yet: the segments under it are kept as written.
    expect(sameVaultFile(vault, 'Shortcut/New/Memories.md', 'Settings/New/Memories.md')).toBe(true);

    writeFileSync(join(vault, 'Settings', 'Memories.md'), 'x');
    symlinkSync(join(vault, 'Settings', 'Memories.md'), join(vault, 'Notes', 'Alias.md'));
    expect(sameVaultFile(vault, 'Notes/Alias.md', 'Settings/Memories.md')).toBe(true);

    const link = `${vault}-link`;
    symlinkSync(vault, link);
    try {
      expect(sameVaultFile(link, 'Settings/./Memories.md', 'Settings/Memories.md')).toBe(true);
      expect(sameVaultFile(link, 'Fresh/Memories.md', 'Fresh/Memories.md')).toBe(true);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('is false for another file, and for a path that leaves the vault', () => {
    for (const other of ['Settings/Memories 2.md', 'Notes/Memories.md', 'Settings/Memories.md.bak', 'Settings/Sub/Memories.md', 'Memories.md']) {
      expect(sameVaultFile(vault, other, 'Settings/Memories.md'), other).toBe(false);
    }
    expect(sameVaultFile(vault, '../Settings/Memories.md', 'Settings/Memories.md')).toBe(false);
    expect(sameVaultFile(vault, '../x.md', '../x.md')).toBe(false);
  });
});
