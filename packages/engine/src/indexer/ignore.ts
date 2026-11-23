import { sep } from 'node:path';

const IGNORED_DIRS = new Set([
  '.vault-engine',
  '.schemas',
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
]);

let customExcludeDirs: string[] = [];

/**
 * Set additional directory prefixes to exclude from indexing.
 * Matching is segment-based: excluding "Notes" won't match "TaskNotes".
 */
export function setExcludeDirs(dirs: string[]): void {
  customExcludeDirs = normalizeExcludeDirs(dirs);
}

/** Normalize directory exclusions exactly as `setExcludeDirs` stores them. */
export function normalizeExcludeDirs(dirs: readonly string[]): string[] {
  return dirs
    .map(d => d.replace(/\/+$/, '').trim())
    .filter(Boolean);
}

export interface IgnoreOptions {
  allowNonMarkdown?: boolean;
  /** Treat paths as slash-normalized instead of host-native paths. */
  pathStyle?: 'native' | 'posix';
}

function pathSegments(relativePath: string, options?: IgnoreOptions): string[] {
  return relativePath.split(options?.pathStyle === 'posix' ? '/' : sep);
}

/** Apply only Engine's stable built-in eligibility rules. */
export function shouldIgnoreBuiltIn(relativePath: string, options?: IgnoreOptions): boolean {
  const segments = pathSegments(relativePath, options);
  const name = segments.at(-1) ?? '';

  if (!options?.allowNonMarkdown && !name.endsWith('.md')) return true;
  if (name.startsWith('.sync-conflict-')) return true;

  for (const segment of segments) {
    if (segment.startsWith('.')) return true;
    if (IGNORED_DIRS.has(segment)) return true;
  }

  return false;
}

/**
 * Determine whether a vault-relative path should be ignored by the indexer.
 *
 * Ignores:
 * - Non-.md files (unless options.allowNonMarkdown — used by the unlink handler,
 *   which must let attachment deletions through for transcript retention)
 * - Obsidian .sync-conflict-* files
 * - Any path segment starting with "."
 * - Known ignored directories
 * - Custom excluded directories (set via VAULT_EXCLUDE_DIRS)
 */
export function shouldIgnore(relativePath: string, options?: IgnoreOptions): boolean {
  if (shouldIgnoreBuiltIn(relativePath, options)) return true;
  return isInExcludedDir(relativePath, customExcludeDirs, options);
}

/**
 * Whether a vault-relative path is inside one of the given normalized exclusion
 * prefixes. Matching starts at the vault root and compares whole segments.
 */
export function isInExcludedDir(
  relativePath: string,
  excludeDirs: readonly string[],
  options?: IgnoreOptions,
): boolean {
  const segments = pathSegments(relativePath, options);
  for (const exclude of excludeDirs) {
    const excludeSegments = exclude.split('/');
    if (excludeSegments.length <= segments.length) {
      const match = excludeSegments.every((es, i) => segments[i] === es);
      if (match) return true;
    }
  }
  return false;
}
