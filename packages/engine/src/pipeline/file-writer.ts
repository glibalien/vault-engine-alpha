// src/pipeline/file-writer.ts
//
// Atomic file writes via write-to-temp-then-rename.
// Used by the pipeline (Stage 6) and batch-mutate's multi-op rollback.

import {
  writeFileSync, renameSync, mkdirSync, existsSync, readFileSync, copyFileSync, unlinkSync,
  linkSync, openSync, closeSync, fstatSync, lstatSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { nanoid } from 'nanoid';

/**
 * Write content to a file atomically via temp-file-and-rename.
 * Creates parent directories if needed.
 */
export function atomicWriteFile(targetPath: string, content: string, tmpDir: string): void {
  // Ensure target directory exists
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Ensure tmp directory exists
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  const tmpFile = join(tmpDir, `${nanoid()}.tmp`);
  writeFileSync(tmpFile, content, 'utf-8');
  renameSync(tmpFile, targetPath);
}

/** link(2) failures that mean the filesystem or temp location cannot hard-link here. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/**
 * Create a file only if nothing exists at `targetPath`, leaving whatever is there untouched.
 * The content is written to a temp file first and hard-linked into place, so the target
 * appears whole and link(2) refuses an existing target, even one created a moment ago by
 * another writer. Where hard links are unavailable (FAT/exFAT, some network filesystems,
 * or a temp folder on another device), an exclusive create (O_EXCL) writes it in place.
 * Returns false when the target already exists. Creates parent directories if needed.
 */
export function atomicCreateFile(targetPath: string, content: string, tmpDir: string): boolean {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const tmpFile = join(tmpDir, `${nanoid()}.tmp`);
  writeFileSync(tmpFile, content, 'utf-8');
  try {
    linkSync(tmpFile, targetPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw err;
    return exclusiveCreate(targetPath, content);
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Best-effort cleanup; the temp folder is Engine's own.
    }
  }
}

function exclusiveCreate(targetPath: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(targetPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  const created = fstatSync(fd);
  try {
    // writeFileSync on a descriptor repeats short writes until every byte is written.
    writeFileSync(fd, content, 'utf-8');
  } catch (err) {
    closeSync(fd);
    // The partial file is ours to remove, unless another writer has replaced the path
    // since; only the same file (device and inode) is removed.
    try {
      const current = lstatSync(targetPath);
      if (current.dev === created.dev && current.ino === created.ino) unlinkSync(targetPath);
    } catch {
      // Already gone.
    }
    throw err;
  }
  closeSync(fd);
  return true;
}

/**
 * Write binary content to a file atomically via temp-file-and-rename. Creates parent dirs.
 * The Buffer variant of atomicWriteFile (no utf-8 encoding).
 */
export function atomicWriteFileBuffer(targetPath: string, content: Buffer, tmpDir: string): void {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${nanoid()}.tmp`);
  writeFileSync(tmpFile, content);
  renameSync(tmpFile, targetPath);
}

/**
 * Back up a file for potential rollback during batch-mutate.
 * Returns the backup path, or null if the file doesn't exist.
 */
export function backupFile(filePath: string, tmpDir: string): string | null {
  if (!existsSync(filePath)) return null;

  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  const backupPath = join(tmpDir, `backup-${nanoid()}.md`);
  copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Restore a file from its backup location.
 */
export function restoreFile(backupPath: string, targetPath: string): void {
  renameSync(backupPath, targetPath);
}

/**
 * Clean up backup files after a successful batch-mutate.
 */
export function cleanupBackups(backupPaths: string[]): void {
  for (const bp of backupPaths) {
    try {
      unlinkSync(bp);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Read file content, returning null on any read failure. For best-effort paths such as
 * rollback; checks that decide whether a file is absent use {@link readFileIfExists}.
 */
export function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read file content, returning null only when the file does not exist. Any other failure
 * (permissions, I/O, a directory in its place) propagates, so it is never taken for absence.
 */
export function readFileIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
