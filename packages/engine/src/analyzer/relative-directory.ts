import { invalidArguments, type AnalyzerResult } from './report.js';

/**
 * Accept a vault-relative POSIX directory that Engine's exclusion matching treats
 * literally: no surrounding whitespace, no leading slash, and no empty, `.`, or `..`
 * segments. Trailing slashes are dropped.
 */
export function parseRelativeDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  const directory = value.replace(/\/+$/, '');
  if (directory.length === 0 || directory.startsWith('/')) return null;
  const segments = directory.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  return directory;
}

/** Validate and normalize caller exclusions; the result is sorted and deduplicated. */
export function parseExclusions(exclude: unknown): AnalyzerResult<string[]> {
  if (exclude === undefined) return { ok: true, data: [] };
  if (!Array.isArray(exclude)) return invalidArguments('exclude must be an array of directories');
  const normalized = new Set<string>();
  for (const entry of exclude) {
    const directory = parseRelativeDirectory(entry);
    if (directory === null) {
      return invalidArguments(`invalid exclude directory: ${JSON.stringify(entry)}`);
    }
    normalized.add(directory);
  }
  return { ok: true, data: [...normalized].sort(compareExact) };
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
