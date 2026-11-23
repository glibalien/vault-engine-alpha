// src/pipeline/safe-path.ts
//
// Path containment guard. Ensures resolved paths stay within the vault root.
// Prevents path traversal via ../ segments in user-supplied directory, title,
// file_path, and filename parameters.

import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Resolve a vault-relative path and verify it stays within the vault root.
 * Throws if the resolved path escapes the vault directory.
 */
export function safeVaultPath(vaultPath: string, relativePath: string): string {
  const root = resolve(vaultPath);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path traversal blocked: "${relativePath}" escapes vault root`);
  }
  return resolved;
}

/**
 * Verify that an existing path is really inside the vault, following symlinks on both sides:
 * safeVaultPath checks only the path text, so a symlink in the vault that points out of it
 * would pass. The vault root may itself be a symlink. Returns the real path. Throws when it
 * lies outside the real vault root, and (from realpathSync) when either path does not exist.
 */
export function safeRealVaultPath(vaultPath: string, absolutePath: string): string {
  const root = realpathSync(vaultPath);
  const real = realpathSync(absolutePath);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`Path traversal blocked: "${absolutePath}" resolves outside vault root`);
  }
  return real;
}

/**
 * The real path of `absolute`, following symlinks as far as the path exists: the nearest
 * existing ancestor is resolved and the segments below it are kept as written.
 */
function realPathSoFar(absolute: string): string {
  const below: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...below);
    } catch {
      // Not there (yet): try the folder above.
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    below.unshift(basename(current));
    current = parent;
  }
}

/** Where a vault-relative path lands, as a comparison key; null when it escapes the vault. */
function landingKey(vaultPath: string, relativePath: string): string | null {
  let absolute: string;
  try {
    absolute = safeVaultPath(vaultPath, relativePath.replace(/\\/g, '/'));
  } catch {
    return null;
  }
  return realPathSoFar(absolute)
    .normalize('NFC')
    .toLowerCase()
    .split(sep)
    .map((segment) => segment.replace(/[. ]+$/, ''))
    .join(sep);
}

/**
 * True when two vault-relative paths name the same file, however each is spelled: `.` and
 * `..` segments and doubled separators are resolved, symlinks are followed as far as the
 * path exists, and case and trailing dots or spaces (which some filesystems ignore) do not
 * count. It errs toward "same", so use it to protect a path, never to prove two files differ.
 */
export function sameVaultFile(vaultPath: string, a: string, b: string): boolean {
  const first = landingKey(vaultPath, a);
  return first !== null && first === landingKey(vaultPath, b);
}
