// src/schema/paths.ts
//
// Shared directory-resolution helper used by create-node and batch-mutate.
// Single source of truth for "where does this node live
// given its types + optional caller override".

import type Database from 'better-sqlite3';
import { createFieldMap } from '../fields/field-map.js';
import { calendarDate, hostTimeZone, wikiTimeZone } from '../wiki/today.js';

export interface ResolveDirectoryInput {
  types: string[];
  directory: string | undefined;
  override_default_directory: boolean;
}

export type ResolveDirectoryResult =
  | { ok: true; directory: string; source: 'explicit' | 'schema_default' | 'root' }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

export function resolveDirectory(
  db: Database.Database,
  input: ResolveDirectoryInput,
): ResolveDirectoryResult {
  if (input.directory !== undefined && input.directory.endsWith('.md')) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      message: '"directory" must be a folder path, not a filename. The filename is always derived from the node title.',
    };
  }

  let schemaDefaultDir: string | null = null;
  if (input.types.length >= 1) {
    const schema = db
      .prepare('SELECT default_directory FROM schemas WHERE name = ?')
      .get(input.types[0]) as { default_directory: string | null } | undefined;
    schemaDefaultDir = schema?.default_directory ?? null;
  }

  if (input.directory !== undefined && schemaDefaultDir && !input.override_default_directory) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      message: `Type "${input.types[0]}" routes to "${schemaDefaultDir}/" via schema. Pass override_default_directory: true to place this node elsewhere.`,
    };
  }

  if (input.directory !== undefined) return { ok: true, directory: input.directory, source: 'explicit' };
  if (schemaDefaultDir) return { ok: true, directory: schemaDefaultDir, source: 'schema_default' };
  return { ok: true, directory: '', source: 'root' };
}

export interface ResolveFilenameInput {
  types: string[];
  title: string;
  fields: Record<string, unknown>;
}

export type ResolveFilenameResult =
  | { ok: true; fileName: string }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

/**
 * Resolve a node's pre-sanitization filename from the first type's schema
 * `filename_template` (falling back to `${title}.md`). Shared by create-node
 * and batch-mutate so both honor templates identically. The caller still runs
 * `sanitizeFilename` on the result (it owns the sanitization warning).
 */
export function resolveFilename(
  db: Database.Database,
  input: ResolveFilenameInput,
): ResolveFilenameResult {
  let fileName = `${input.title}.md`;
  if (input.types.length >= 1) {
    const schema = db
      .prepare('SELECT filename_template FROM schemas WHERE name = ?')
      .get(input.types[0]) as { filename_template: string | null } | undefined;
    if (schema?.filename_template) {
      // `{date}` is today in the owner's zone (Curator's `tz`, empty = host), as the wiki's today (#497).
      const today = calendarDate(Date.now(), wikiTimeZone(db));
      const derived = evaluateTemplate(schema.filename_template, input.title, input.fields, today);
      if (derived === null) {
        return { ok: false, code: 'INVALID_PARAMS', message: 'Filename template has unresolved variables' };
      }
      fileName = derived;
    }
  }
  return { ok: true, fileName };
}

/**
 * Expand a `filename_template` against `{title}`, `{date}` (`today`, YYYY-MM-DD;
 * defaults to today in this host's zone), and string-valued fields. Returns null
 * if any `{var}` is unresolved.
 */
export function evaluateTemplate(
  template: string,
  title: string,
  fields: Record<string, unknown>,
  today: string = calendarDate(Date.now(), hostTimeZone()),
): string | null {
  const vars = createFieldMap<string>({ title, date: today });
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') vars[k] = v;
  }

  let result = template;
  const missing = template.match(/\{(\w+)\}/g);
  if (missing) {
    for (const m of missing) {
      const varName = m.slice(1, -1);
      if (!Object.hasOwn(vars, varName)) return null;
      result = result.replace(m, vars[varName]);
    }
  }
  return result;
}
