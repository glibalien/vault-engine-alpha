// Link counts per node (#611): how many notes link to a node, how many it links
// to, and how many of its links point at notes that don't exist.
//
// One definition serves every reader — query-nodes' filter, sort and columns, and
// get-node — so a count shown beside a row is always the count a filter tests.
//
// What counts:
// - Every stored relationship: body wiki-links and reference-field links alike.
//   An optional rel_type narrows a filter to some of them.
// - Distinct linked nodes, not link rows: a note linking the same note from a
//   field and from its body counts once.
// - Self-links never count.
// - inlinks and outlinks use the stored resolved_target_id binding.
// - unresolved counts outgoing links with no binding, by the note they name:
//   heading/block anchors are dropped, a same-note `[[#Heading]]` and a link to
//   an attachment (`![[diagram.png]]`) are not counted, and links that name the
//   same missing note up to near-miss spelling (case, `.md`, separators) count
//   once.

import type Database from 'better-sqlite3';
import { linkKey } from '../resolver/near-miss.js';

export type LinkCountKind = 'incoming' | 'outgoing' | 'unresolved';
export const LINK_COUNT_KINDS: readonly LinkCountKind[] = ['incoming', 'outgoing', 'unresolved'];

/** query-nodes column (and sort_by value) for each kind. */
export const LINK_COUNT_COLUMNS = {
  inlink_count: 'incoming',
  outlink_count: 'outgoing',
  unresolved_link_count: 'unresolved',
} as const satisfies Record<string, LinkCountKind>;
export type LinkCountColumn = keyof typeof LINK_COUNT_COLUMNS;
export const LINK_COUNT_COLUMN_NAMES = Object.keys(LINK_COUNT_COLUMNS) as LinkCountColumn[];

export type CountOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type CountPredicate = Partial<Record<CountOp, number>>;
export interface LinkCountsFilter {
  rel_type?: string | string[];
  incoming?: CountPredicate;
  outgoing?: CountPredicate;
  unresolved?: CountPredicate;
}

export interface LinkCounts {
  incoming: number;
  outgoing: number;
  unresolved: number;
}

const SQL_OPS: Record<CountOp, string> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/**
 * A link target names an attachment when, after any anchor, it ends in a short
 * file extension with a letter in it (`.png`, `.pdf`, `.3gp`, `.canvas`).
 * `Version 2.0` and `Dr. Smith` stay note names, and so does anything written
 * with an explicit `.md` (`Report.v2.md`, a dotted note name).
 */
const ATTACHMENT_EXTENSION = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,6}$/;

/** The missing note an unresolved link names, as a dedup key; null when it names no note. */
export function missingLinkKey(target: string): string | null {
  const name = target.split('#')[0]!.trim();
  if (name === '') return null; // [[#Heading]] points into the same note
  if (!name.endsWith('.md') && ATTACHMENT_EXTENSION.test(name)) return null;
  const key = linkKey(name);
  return key === '' ? null : key;
}

const MISSING_LINK_KEY_FN = 've_missing_link_key';
const registered = new WeakSet<Database.Database>();

/** Registers the SQL function the unresolved count uses; idempotent per connection. */
export function ensureLinkCountFunctions(db: Database.Database): void {
  if (registered.has(db)) return;
  db.function(MISSING_LINK_KEY_FN, { deterministic: true }, (target: unknown) =>
    typeof target === 'string' ? missingLinkKey(target) : null);
  registered.add(db);
}

function relTypeList(relType: string | string[] | undefined): string[] {
  if (relType === undefined) return [];
  return Array.isArray(relType) ? relType : [relType];
}

/**
 * A correlated scalar subquery counting `kind` for the node at `alias`. Its
 * placeholders are the rel_types, in order. Callers that use `unresolved` must
 * have called ensureLinkCountFunctions on the connection that runs it.
 */
export function linkCountSql(kind: LinkCountKind, alias: string, relType?: string | string[]): { sql: string; params: string[] } {
  const types = relTypeList(relType);
  const typeClause = types.length === 0 ? ''
    : types.length === 1 ? ' AND lc.rel_type = ?'
      : ` AND lc.rel_type IN (${types.map(() => '?').join(', ')})`;
  let sql: string;
  if (kind === 'outgoing') {
    sql = `(SELECT COUNT(DISTINCT lc.resolved_target_id) FROM relationships lc WHERE lc.source_id = ${alias}.id AND lc.resolved_target_id IS NOT NULL AND lc.resolved_target_id != ${alias}.id${typeClause})`;
  } else if (kind === 'incoming') {
    sql = `(SELECT COUNT(DISTINCT lc.source_id) FROM relationships lc WHERE lc.resolved_target_id = ${alias}.id AND lc.source_id != ${alias}.id${typeClause})`;
  } else {
    sql = `(SELECT COUNT(DISTINCT ${MISSING_LINK_KEY_FN}(lc.target)) FROM relationships lc WHERE lc.source_id = ${alias}.id AND lc.resolved_target_id IS NULL${typeClause})`;
  }
  return { sql, params: types };
}

/** WHERE predicates for a link_counts filter at `alias`: one per (kind, operator). */
export function linkCountClauses(
  filter: LinkCountsFilter,
  alias: string,
  db: Database.Database | undefined,
): { whereClauses: string[]; whereParams: unknown[] } {
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];
  for (const kind of LINK_COUNT_KINDS) {
    const predicate = filter[kind];
    if (!predicate) continue;
    if (kind === 'unresolved') {
      if (!db) throw new Error('db is required for an unresolved link-count filter');
      ensureLinkCountFunctions(db);
    }
    for (const [op, value] of Object.entries(predicate) as Array<[CountOp, number | undefined]>) {
      if (value === undefined) continue;
      const sqlOp = SQL_OPS[op];
      if (!sqlOp) throw new Error(`INVALID_PARAMS: unknown link-count operator '${op}'`);
      const count = linkCountSql(kind, alias, filter.rel_type);
      whereClauses.push(`${count.sql} ${sqlOp} ?`);
      whereParams.push(...count.params, value);
    }
  }
  return { whereClauses, whereParams };
}

/** All three counts for each node id; ids that match no node are absent. */
export function readLinkCounts(db: Database.Database, ids: readonly string[]): Map<string, LinkCounts> {
  const counts = new Map<string, LinkCounts>();
  if (ids.length === 0) return counts;
  ensureLinkCountFunctions(db);
  const select = LINK_COUNT_KINDS.map(kind => `${linkCountSql(kind, 'n').sql} AS ${kind}`).join(', ');
  // Chunked well under SQLite's bound-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT n.id, ${select} FROM nodes n WHERE n.id IN (${chunk.map(() => '?').join(', ')})`)
      .all(...chunk) as Array<{ id: string } & LinkCounts>;
    for (const row of rows) counts.set(row.id, { incoming: row.incoming, outgoing: row.outgoing, unresolved: row.unresolved });
  }
  return counts;
}
