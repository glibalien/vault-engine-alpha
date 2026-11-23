import type Database from 'better-sqlite3';

export interface FtsRow {
  title: string;
  aliases: string;
  path: string;
  fields: string;
  links: string;
  body: string;
}

/** Recursively collect string leaves from a parsed JSON value. */
function jsonStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const v of value) jsonStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) jsonStrings(v, out);
  }
}

/** Human-readable strings for one node_fields row (value_text, else json string leaves, else date/number). */
function fieldValues(row: FieldRow): string[] {
  if (row.value_text && row.value_text.trim()) return [row.value_text.trim()];
  if (row.value_json) {
    try {
      const out: string[] = [];
      jsonStrings(JSON.parse(row.value_json), out);
      if (out.length) return out;
    } catch {
      /* ignore malformed json */
    }
  }
  if (row.value_date) return [row.value_date];
  if (row.value_number !== null && row.value_number !== undefined) return [String(row.value_number)];
  return [];
}

interface FieldRow {
  field_name: string;
  value_text: string | null;
  value_json: string | null;
  value_date: string | null;
  value_number: number | null;
}

/** Tokenize a file path into space-separated folder + filename words (no slashes, no `.md`). */
function pathTokens(filePath: string): string {
  return filePath
    .replace(/\.md$/i, '')
    .split(/[/\\\-_.]+/)
    .filter(Boolean)
    .join(' ');
}

function dedupeJoin(values: string[]): string {
  return [...new Set(values.map((s) => s.trim()).filter(Boolean))].join(' ');
}

/**
 * Derive the six FTS columns for a node from data already in the DB. Best-effort:
 * missing fields/links contribute empty text, never an error. `links` reflects
 * resolved_target_id at call time (self-heals on the node's next reindex).
 * FTS-only - deliberately NOT wired into assembleContent (that is finding #4b).
 */
export function buildFtsRow(db: Database.Database, nodeId: string): FtsRow {
  const node = db
    .prepare('SELECT title, body, file_path FROM nodes WHERE id = ?')
    .get(nodeId) as { title: string | null; body: string | null; file_path: string } | undefined;
  if (!node) return { title: '', aliases: '', path: '', fields: '', links: '', body: '' };

  const fieldRows = db
    .prepare('SELECT field_name, value_text, value_json, value_date, value_number FROM node_fields WHERE node_id = ?')
    .all(nodeId) as FieldRow[];

  const aliasVals: string[] = [];
  const fieldVals: string[] = [];
  for (const fr of fieldRows) {
    if (fr.field_name === 'aliases') aliasVals.push(...fieldValues(fr));
    else fieldVals.push(...fieldValues(fr));
  }

  const linkRows = db
    .prepare(
      `SELECT r.target AS target, n.title AS resolved_title
         FROM relationships r
         LEFT JOIN nodes n ON n.id = r.resolved_target_id
        WHERE r.source_id = ?`
    )
    .all(nodeId) as { target: string; resolved_title: string | null }[];
  const linkVals = linkRows.map((lr) => (lr.resolved_title && lr.resolved_title.trim() ? lr.resolved_title : lr.target));

  return {
    title: node.title ?? '',
    aliases: dedupeJoin(aliasVals),
    path: pathTokens(node.file_path),
    fields: dedupeJoin(fieldVals),
    links: dedupeJoin(linkVals),
    body: node.body ?? '',
  };
}
