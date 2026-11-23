import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, opendir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Host } from './host.js';
import type { Prompter } from './prompter.js';
import { count } from './text.js';

export type BackupMode = 'markdown' | 'full' | 'skip';

/** What the backup stage will copy; `files` and `bytes` are zero when it is skipped. */
export interface BackupPlan {
  mode: BackupMode;
  files: number;
  bytes: number;
}

export interface VaultFiles {
  markdown: { files: number; bytes: number };
  all: { files: number; bytes: number };
  symlinks: number;
}

/** Engine's own folder holds a database and caches, never notes. */
const ENGINE_FOLDER = '.vault-engine';

export const SKIP_CONFIRMATION = 'skip backup';

/** Stage 4: how the vault is backed up before anything in it changes. */
export async function runBackupChoice(input: {
  host: Host;
  prompter: Prompter;
  vaultPath: string;
  dataDir: string;
  scan?: (vaultPath: string, dataDir: string) => Promise<VaultFiles>;
}): Promise<BackupPlan> {
  const { host, prompter, vaultPath, dataDir } = input;
  const files = await (input.scan ?? scanVaultFiles)(vaultPath, dataDir);
  const mode = await prompter.decide<BackupMode>({
    id: 'backup.mode',
    ask: () => askMode(prompter, files),
    defaultValue: () => 'markdown',
  });
  const plan = mode === 'skip'
    ? { mode, files: 0, bytes: 0 }
    : { mode, ...(mode === 'markdown' ? files.markdown : files.all) };
  const free = await host.freeDiskBytes(dataDir);
  if (free !== null && plan.bytes > free) {
    prompter.warn(`The backup needs ${formatBytes(plan.bytes)} and only ${formatBytes(free)} is free for ${dataDir}; installing would stop at the backup.`);
  }
  return plan;
}

async function askMode(prompter: Prompter, files: VaultFiles): Promise<BackupMode> {
  for (;;) {
    const mode = await prompter.select<BackupMode>({
      id: 'backup.mode',
      message: 'Make a safety copy of your notes first?',
      options: [
        { value: 'markdown', label: 'Copy my notes (recommended)', hint: `${count(files.markdown.files, 'Markdown file')}, ${formatBytes(files.markdown.bytes)}` },
        { value: 'full', label: 'Copy the whole folder', hint: `${count(files.all.files, 'file')}, ${formatBytes(files.all.bytes)}` },
        { value: 'skip', label: 'No copy', hint: 'only if you already have your own backup' },
      ],
      initialValue: 'markdown',
    });
    if (mode !== 'skip') return mode;
    const typed = await prompter.text({
      id: 'backup.mode',
      message: `Vault will edit your notes, so a copy is strongly advised. To continue without one, type "${SKIP_CONFIRMATION}":`,
      allowEmpty: true,
    });
    if (typed.trim().toLowerCase() === SKIP_CONFIRMATION) return 'skip';
    prompter.info('Good choice: a copy will be made.');
  }
}

/** `512 bytes`, `12.0 KB`, `3.4 MB`, `1.2 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const [value, unit] = bytes < 1024 ** 2 ? [bytes / 1024, 'KB'] : bytes < 1024 ** 3 ? [bytes / 1024 ** 2, 'MB'] : [bytes / 1024 ** 3, 'GB'];
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * Every regular file under the vault, without following symlinks, leaving out Engine's
 * folder and the data directory when it sits inside the vault.
 */
export async function scanVaultFiles(vaultPath: string, dataDir: string): Promise<VaultFiles> {
  const result: VaultFiles = { markdown: { files: 0, bytes: 0 }, all: { files: 0, bytes: 0 }, symlinks: 0 };
  for await (const entry of walk(vaultPath, dataDir)) {
    if (entry.kind === 'symlink') {
      result.symlinks++;
      continue;
    }
    result.all.files++;
    result.all.bytes += entry.bytes;
    if (isMarkdown(entry.path)) {
      result.markdown.files++;
      result.markdown.bytes += entry.bytes;
    }
  }
  return result;
}

type WalkEntry = { kind: 'file'; path: string; bytes: number } | { kind: 'symlink'; path: string };

async function* walk(root: string, dataDir: string, directory = root): AsyncGenerator<WalkEntry> {
  const entries = [];
  for await (const entry of await opendir(directory)) entries.push(entry);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      yield { kind: 'symlink', path };
    } else if (entry.isDirectory()) {
      if (path === join(root, ENGINE_FOLDER) || path === dataDir) continue;
      yield* walk(root, dataDir, path);
    } else if (entry.isFile()) {
      yield { kind: 'file', path, bytes: (await lstat(path)).size };
    }
  }
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

export interface BackupManifest {
  format: 'vault-installer-backup';
  version: 1;
  created_at: string;
  vault: string;
  mode: Exclude<BackupMode, 'skip'>;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  skipped_symlinks: string[];
}

export interface BackupResult {
  directory: string;
  files: number;
  bytes: number;
}

/**
 * Stage 7. Copy the vault's files into `directory/vault/`, hashing each as it is copied,
 * then write `manifest.json` last: a backup without a manifest is incomplete. The vault is
 * only read.
 */
export async function writeBackup(input: {
  vaultPath: string;
  dataDir: string;
  directory: string;
  mode: Exclude<BackupMode, 'skip'>;
  now: Date;
  freeBytes: (path: string) => Promise<number | null>;
  onProgress?: (copied: number) => void;
}): Promise<BackupResult> {
  const { vaultPath, dataDir, directory, mode } = input;
  const selected: Array<{ path: string; bytes: number }> = [];
  const skippedSymlinks: string[] = [];
  for await (const entry of walk(vaultPath, dataDir)) {
    if (entry.kind === 'symlink') skippedSymlinks.push(toPosix(relative(vaultPath, entry.path)));
    else if (mode === 'full' || isMarkdown(entry.path)) selected.push(entry);
  }
  const needed = selected.reduce((sum, file) => sum + file.bytes, 0);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const free = await input.freeBytes(directory);
  if (free !== null && needed > free) {
    throw new BackupError(`The backup needs ${formatBytes(needed)} and only ${formatBytes(free)} is free for ${directory}.`);
  }

  const files: BackupManifest['files'] = [];
  for (const file of selected) {
    const path = toPosix(relative(vaultPath, file.path));
    const target = join(directory, 'vault', path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const { bytes, sha256 } = await copyAndHash(file.path, target);
    files.push({ path, bytes, sha256 });
    input.onProgress?.(files.length);
  }
  const manifest: BackupManifest = {
    format: 'vault-installer-backup',
    version: 1,
    created_at: input.now.toISOString(),
    vault: vaultPath,
    mode,
    files,
    skipped_symlinks: skippedSymlinks,
  };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { directory, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

/** Remove a backup the installer started but never finished (it has no manifest). */
export async function removeIncompleteBackup(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export class BackupError extends Error {
  override readonly name = 'BackupError';
}

async function copyAndHash(source: string, target: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(source), tap, createWriteStream(target, { mode: 0o600, flags: 'wx' }));
  return { bytes, sha256: hash.digest('hex') };
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** `20261026T120000Z`, for a backup folder name. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
