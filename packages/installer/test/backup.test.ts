import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnswersSchema } from '../src/answers.js';
import { BackupError, formatBytes, runBackupChoice, scanVaultFiles, writeBackup, type BackupManifest, type VaultFiles } from '../src/backup.js';
import { createScriptedPrompter } from '../src/prompter.js';
import { fakeHost, makeTree, removeTrees, replayPrompter } from './helpers.js';

afterEach(removeTrees);

const NOTE = '# Note\n';
const ALPHA = '---\ntype: project\n---\nAlpha\n';

async function vaultTree() {
  const vault = await makeTree({
    'Note.md': NOTE,
    'Projects/Alpha.md': ALPHA,
    'Attachments/photo.png': 'not really a png',
    '.obsidian/app.json': '{}',
    '.vault-engine/vault.db': 'database',
    'data/state.json': '{}',
  });
  await symlink(join(vault, 'Note.md'), join(vault, 'Linked.md'));
  return vault;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('scanVaultFiles', () => {
  it('counts Markdown and all files, skipping Engine\'s folder, the data directory, and symlinks', async () => {
    const vault = await vaultTree();

    expect(await scanVaultFiles(vault, join(vault, 'data'))).toEqual({
      markdown: { files: 2, bytes: NOTE.length + ALPHA.length },
      all: { files: 4, bytes: NOTE.length + ALPHA.length + 'not really a png'.length + '{}'.length },
      symlinks: 1,
    });
  });
});

describe('runBackupChoice', () => {
  const files: VaultFiles = { markdown: { files: 2, bytes: 100 }, all: { files: 5, bytes: 5000 }, symlinks: 0 };
  const scan = async () => files;

  it('backs up the notes by default and takes the mode from an answers file', async () => {
    const run = (backup?: { mode: 'markdown' | 'full' | 'skip' }) => runBackupChoice({
      host: fakeHost(),
      prompter: createScriptedPrompter({ version: 1, vault: { path: '/v' }, ...(backup ? { backup } : {}) }, () => {}),
      vaultPath: '/v',
      dataDir: '/data',
      scan,
    });

    expect(await run()).toEqual({ mode: 'markdown', files: 2, bytes: 100 });
    expect(await run({ mode: 'full' })).toEqual({ mode: 'full', files: 5, bytes: 5000 });
    expect(await run({ mode: 'skip' })).toEqual({ mode: 'skip', files: 0, bytes: 0 });
  });

  it('skips interactively only after the confirmation is typed', async () => {
    const { prompter } = replayPrompter({ 'backup.mode': ['skip', 'yes', 'skip', 'Skip Backup'] });

    const plan = await runBackupChoice({ host: fakeHost(), prompter, vaultPath: '/v', dataDir: '/data', scan });

    expect(plan.mode).toBe('skip');
  });

  it('keeps the backup when the confirmation is not typed', async () => {
    const { prompter } = replayPrompter({ 'backup.mode': ['skip', '', 'full'] });

    const plan = await runBackupChoice({ host: fakeHost(), prompter, vaultPath: '/v', dataDir: '/data', scan });

    expect(plan.mode).toBe('full');
  });

  it('warns when the data directory is too small', async () => {
    const lines: string[] = [];
    await runBackupChoice({
      host: fakeHost({ freeDiskBytes: async () => 1000 }),
      prompter: createScriptedPrompter({ version: 1, vault: { path: '/v' }, backup: { mode: 'full' } }, line => lines.push(line)),
      vaultPath: '/v',
      dataDir: '/data',
      scan,
    });

    expect(lines).toContainEqual(expect.stringContaining('installing would stop at the backup'));
  });

  it('accepts only the three modes in an answers file', () => {
    const parse = (mode: string) => AnswersSchema.safeParse({ version: 1, vault: { path: '/v' }, backup: { mode } }).success;

    expect(['markdown', 'full', 'skip', 'all'].map(parse)).toEqual([true, true, true, false]);
  });
});

describe('writeBackup', () => {
  it('copies the notes with a manifest of their hashes and leaves the vault as it was', async () => {
    const vault = await vaultTree();
    const directory = join(await makeTree({}), 'backup');
    const before = await readdir(vault, { recursive: true });

    const result = await writeBackup({
      vaultPath: vault,
      dataDir: join(vault, 'data'),
      directory,
      mode: 'markdown',
      now: new Date('2026-10-26T12:00:00Z'),
      freeBytes: async () => null,
    });

    expect(result).toEqual({ directory, files: 2, bytes: NOTE.length + ALPHA.length });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
    expect(manifest).toEqual({
      format: 'vault-installer-backup',
      version: 1,
      created_at: '2026-10-26T12:00:00.000Z',
      vault,
      mode: 'markdown',
      files: [
        { path: 'Note.md', bytes: NOTE.length, sha256: sha256(NOTE) },
        { path: 'Projects/Alpha.md', bytes: ALPHA.length, sha256: sha256(ALPHA) },
      ],
      skipped_symlinks: ['Linked.md'],
    });
    expect(await readFile(join(directory, 'vault', 'Projects', 'Alpha.md'), 'utf8')).toBe(ALPHA);
    expect((await stat(join(directory, 'vault', 'Note.md'))).mode & 0o777).toBe(0o600);
    expect(await readdir(vault, { recursive: true })).toEqual(before);
  });

  it('copies every file in full mode', async () => {
    const vault = await vaultTree();
    const directory = join(await makeTree({}), 'backup');

    await writeBackup({ vaultPath: vault, dataDir: '/elsewhere', directory, mode: 'full', now: new Date(0), freeBytes: async () => null });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
    expect(manifest.files.map(file => file.path)).toEqual([
      '.obsidian/app.json', 'Attachments/photo.png', 'Note.md', 'Projects/Alpha.md', 'data/state.json',
    ]);
  });

  it('stops before copying when there is not enough space', async () => {
    const vault = await vaultTree();
    const directory = join(await makeTree({}), 'backup');

    await expect(writeBackup({ vaultPath: vault, dataDir: '/elsewhere', directory, mode: 'markdown', now: new Date(0), freeBytes: async () => 10 }))
      .rejects.toThrow(BackupError);
    await mkdir(directory, { recursive: true });
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect([0, 1023, 1024, 5 * 1024 ** 2 + 1, 3 * 1024 ** 3].map(formatBytes)).toEqual(['0 bytes', '1023 bytes', '1.0 KB', '5.0 MB', '3.0 GB']);
  });
});
