import { classificationSql } from '../classification/filter.js';
import type { ClassificationReadContext } from '../classification/read.js';
import { assertExpressionBudget, type FilterExpression } from '../filters/expression.js';
import type Database from 'better-sqlite3';
import { resolveTarget } from '../resolver/resolve.js';
import { LIKE_ESCAPE, literalContainsPattern, literalPrefixPattern } from '../db/like-pattern.js';
import { linkCountClauses, type LinkCountsFilter } from './link-counts.js';

export interface FieldFilter {
  in_group?: {schema:string;group:string};
  is_unclassified?: {schema:string};
  eq?: unknown;
  ne?: unknown;
  gt?: unknown;
  lt?: unknown;
  gte?: unknown;
  lte?: unknown;
  contains?: string;
  includes?: unknown;
  one_of?: unknown[];
  exists?: boolean;
}

export interface ReferenceFilter {
  target: string;
  rel_type?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
}

export interface JoinFilter {
  direction?: 'outgoing' | 'incoming';
  rel_type?: string | string[];
  target?: QueryTargetFilter;
}

export interface NodeQueryFilterLeaf {
  node_ids?: string[];
  without_node_ids?: string[];
  types?: string[];
  without_types?: string[];
  fields?: Record<string, FieldFilter>;
  without_fields?: string[];
  references?: ReferenceFilter;
  title_eq?: string;
  title_contains?: string;
  without_titles?: string[];
  /** Excludes nodes whose title contains the text, or any of the texts (#559). */
  without_title_contains?: string | string[];
  full_text?: string;
  /** The text's words, as whole words in this order, in the title or body (any case). */
  full_text_words?: string;
  path_prefix?: string;
  without_path_prefix?: string;
  path_dir?: string;
  modified_since?: string;
  /** Nodes the Engine first indexed at or after this ISO time (`nodes.created_at`, #332). */
  created_since?: string;
  /** Distinct linked-node counts (#611); see link-counts.ts. Not accepted inside join targets. */
  link_counts?: LinkCountsFilter;
  join_filters?: JoinFilter[];
  without_joins?: JoinFilter[];
}

export interface NodeQueryFilter extends NodeQueryFilterLeaf { where?: FilterExpression<NodeQueryFilterLeaf> }
export type QueryTargetLeaf = Omit<NodeQueryFilterLeaf,'full_text'|'full_text_words'|'join_filters'|'without_joins'|'link_counts'>;
export interface QueryTargetFilter extends QueryTargetLeaf { where?: FilterExpression<QueryTargetLeaf> }

export interface NodeQueryResult {
  sql: string;
  countSql: string;
  /** The matching node ids alone, for use as a subquery; takes the same params. */
  idSql: string;
  params: unknown[];
}

export interface FilterClauses {
  joins: string[];
  joinParams: unknown[];
  whereClauses: string[];
  whereParams: unknown[];
}

/**
 * Compiles a NodeQueryFilter into JOINs and WHEREs at a given alias.
 * Used by buildNodeQuery for the outer `n`, and recursively by
 * buildJoinExistsClauses for target nodes (aliased `tN`).
 *
 * The `idx` counter is passed by reference (via object wrapper) so nested
 * invocations don't collide on alias names. Generated aliases get a
 * `_${alias}` suffix so outer `t0_n` and inner `t0_t0_n` don't collide.
 *
 * NOTE: This helper does NOT handle `filter.join_filters` or
 * `filter.without_joins` — those are composed by the caller
 * (`buildNodeQuery`) at the outer level only.
 */
export function buildFilterClauses(
  filter: NodeQueryFilter,
  alias: string,
  idx: { n: number },
  db?: Database.Database,
  classification?: ClassificationReadContext,
): FilterClauses {
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  // Identity filters
  if (filter.node_ids && filter.node_ids.length > 0) {
    const placeholders = filter.node_ids.map(() => '?').join(', ');
    whereClauses.push(`${alias}.id IN (${placeholders})`);
    whereParams.push(...filter.node_ids);
  }

  if (filter.without_node_ids && filter.without_node_ids.length > 0) {
    const placeholders = filter.without_node_ids.map(() => '?').join(', ');
    whereClauses.push(`${alias}.id NOT IN (${placeholders})`);
    whereParams.push(...filter.without_node_ids);
  }

  // Type filter (intersection: node must have ALL specified types)
  if (filter.types && filter.types.length > 0) {
    for (const t of filter.types) {
      const a = `t${idx.n++}_${alias}`;
      joins.push(`INNER JOIN node_types ${a} ON ${a}.node_id = ${alias}.id AND ${a}.schema_type = ?`);
      joinParams.push(t);
    }
  }

  // Negation type filter (node must NOT have any of the specified types)
  if (filter.without_types && filter.without_types.length > 0) {
    for (const t of filter.without_types) {
      whereClauses.push(`${alias}.id NOT IN (SELECT node_id FROM node_types WHERE schema_type = ?)`);
      whereParams.push(t);
    }
  }

  // Field filters
  if (filter.fields) {
    for (const [fieldName, ops] of Object.entries(filter.fields)) {
      if (ops.in_group || ops.is_unclassified) {
        const c = classificationSql(db,fieldName,ops,alias,classification);
        whereClauses.push(c.sql); whereParams.push(...c.params); continue;
      }
      const a = `f${idx.n++}_${alias}`;

      // Check for exists: false (LEFT JOIN + IS NULL pattern)
      if ('exists' in ops && ops.exists === false) {
        joins.push(`LEFT JOIN node_fields ${a} ON ${a}.node_id = ${alias}.id AND ${a}.field_name = ?`);
        joinParams.push(fieldName);
        whereClauses.push(`${a}.node_id IS NULL`);
        continue;
      }

      // Normal: INNER JOIN
      joins.push(`INNER JOIN node_fields ${a} ON ${a}.node_id = ${alias}.id AND ${a}.field_name = ?`);
      joinParams.push(fieldName);

      for (const [op, value] of Object.entries(ops)) {
        if (op === 'exists') {
          // exists: true is handled by the INNER JOIN itself
          continue;
        }
        if (op === 'contains') {
          // Search both value_text (scalar strings) and value_json (arrays/objects). The text is
          // read literally (#649): `in_progress` does not match `in-progress`.
          const pattern = literalContainsPattern(String(value));
          whereClauses.push(`(${a}.value_text LIKE ? ${LIKE_ESCAPE} OR ${a}.value_json LIKE ? ${LIKE_ESCAPE})`);
          whereParams.push(pattern, pattern);
        } else if (op === 'includes') {
          // Array membership: check if value_json (a JSON array) contains the given element
          whereClauses.push(
            `EXISTS (SELECT 1 FROM json_each(${a}.value_json) WHERE json_each.value = ?)`
          );
          whereParams.push(value);
        } else if (op === 'one_of') {
          if (!Array.isArray(value) || value.length === 0) {
            throw new Error('INVALID_PARAMS: one_of requires a non-empty array');
          }
          const col = typeof value[0] === 'number' ? 'value_number' : 'value_text';
          const placeholders = value.map(() => '?').join(', ');
          whereClauses.push(`${a}.${col} IN (${placeholders})`);
          whereParams.push(...value);
        } else if (op === 'eq') {
          if (typeof value === 'number') {
            whereClauses.push(`${a}.value_number = ?`);
          } else {
            // Date-typed fields are stored in value_date (see classifyValue);
            // string-typed fields land in value_text. COALESCE compares against
            // whichever column actually holds the value — both are ISO/lex-safe.
            whereClauses.push(`COALESCE(${a}.value_date, ${a}.value_text) = ?`);
          }
          whereParams.push(value);
        } else if (op === 'ne') {
          if (typeof value === 'number') {
            whereClauses.push(`${a}.value_number != ?`);
          } else {
            whereClauses.push(`COALESCE(${a}.value_date, ${a}.value_text) != ?`);
          }
          whereParams.push(value);
        } else if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
          const sqlOp = op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';
          if (typeof value === 'number') {
            whereClauses.push(`${a}.value_number ${sqlOp} ?`);
          } else {
            whereClauses.push(`COALESCE(${a}.value_date, ${a}.value_text) ${sqlOp} ?`);
          }
          whereParams.push(value);
        }
      }
    }
  }

  // Negation field filter (node must NOT have any of the specified field names)
  if (filter.without_fields && filter.without_fields.length > 0) {
    for (const fieldName of filter.without_fields) {
      whereClauses.push(`${alias}.id NOT IN (SELECT node_id FROM node_fields WHERE field_name = ?)`);
      whereParams.push(fieldName);
    }
  }

  // Reference filter
  if (filter.references) {
    const ref = filter.references;
    const dir = ref.direction ?? 'outgoing';

    if (dir === 'outgoing' || dir === 'both') {
      const a = `r${idx.n++}_${alias}`;
      let joinCond = `INNER JOIN relationships ${a} ON ${a}.source_id = ${alias}.id AND ${a}.target = ?`;
      joinParams.push(ref.target);
      if (ref.rel_type) {
        joinCond += ` AND ${a}.rel_type = ?`;
        joinParams.push(ref.rel_type);
      }
      joins.push(joinCond);
    }

    if (dir === 'incoming' || dir === 'both') {
      if (!db) {
        throw new Error('db is required for incoming reference filter (resolveTarget lookup)');
      }
      // With resolved_target_id pre-populated on every relationship row
      // (see src/resolver/refresh.ts + startup backfill in src/index.ts),
      // the incoming branch is a single-key join — no variant IN-list needed.
      const resolved = resolveTarget(db, ref.target);
      if (!resolved) {
        whereClauses.push('1 = 0');
      } else {
        const a = `r${idx.n++}_${alias}`;
        let joinCond = `INNER JOIN relationships ${a} ON ${a}.source_id = ${alias}.id AND ${a}.resolved_target_id = ?`;
        joinParams.push(resolved.id);
        if (ref.rel_type) {
          joinCond += ` AND ${a}.rel_type = ?`;
          joinParams.push(ref.rel_type);
        }
        joins.push(joinCond);
      }
    }
  }

  // Title filters
  if (filter.title_eq !== undefined) {
    whereClauses.push(`${alias}.title = ? COLLATE NOCASE`);
    whereParams.push(filter.title_eq);
  }
  // Substring title matches are literal: `_` and `%` match themselves (#559).
  // SQLite LIKE folds ASCII case on this connection, so both are case-insensitive.
  if (filter.title_contains !== undefined) {
    whereClauses.push(`${alias}.title LIKE ? ESCAPE '\\'`);
    whereParams.push(literalContainsPattern(filter.title_contains));
  }
  if (filter.without_titles && filter.without_titles.length > 0) {
    const placeholders = filter.without_titles.map(() => '?').join(', ');
    whereClauses.push(`${alias}.title COLLATE NOCASE NOT IN (${placeholders})`);
    whereParams.push(...filter.without_titles);
  }
  if (filter.without_title_contains !== undefined) {
    for (const text of [filter.without_title_contains].flat()) {
      whereClauses.push(`${alias}.title NOT LIKE ? ESCAPE '\\'`);
      whereParams.push(literalContainsPattern(text));
    }
  }

  // Full-text substring filter: literal LIKE match across title + body.
  // Distinct from the RRF-ranked `query` param — this is exact substring, not
  // tokenized FTS, so a literal multi-word phrase (e.g. "alone against the town")
  // matches predictably and stopwords aren't dropped. LIKE wildcards are escaped
  // so the match stays literal. Case-insensitive: SQLite LIKE folds ASCII by
  // default (case_sensitive_like is not enabled on this connection).
  if (filter.full_text !== undefined && filter.full_text !== '') {
    const pattern = literalContainsPattern(filter.full_text);
    whereClauses.push(
      `(${alias}.title LIKE ? ESCAPE '\\' OR ${alias}.body LIKE ? ESCAPE '\\')`,
    );
    whereParams.push(pattern, pattern);
  }

  // Whole-word filter: the text's words, in order, as words of the title or body. It reads the
  // full-text index (`nodes_fts`, the ranked search's tokens, any case), so a name is not found
  // inside a longer word: "Ark" matches "Ark" and "Ark's", never "market" (#687). Text with no
  // word in it, the empty text included, matches nothing: a bulk write given one is never widened
  // to every note (Codex, #688). Combining marks stay inside a word, as the index keeps them, so a
  // decomposed accent does not split it (Codex, #688).
  if (filter.full_text_words !== undefined) {
    const words = filter.full_text_words.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
    if (words.length === 0) {
      whereClauses.push('0');
    } else {
      whereClauses.push(`${alias}.rowid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)`);
      whereParams.push(`{title body} : "${words.join(' ')}"`);
    }
  }

  // The path filters read the caller's text literally (#649): a `_` or `%` in a folder name is
  // not a wildcard, so a filter never reaches a folder the caller did not name.

  // Path prefix filter
  if (filter.path_prefix) {
    whereClauses.push(`${alias}.file_path LIKE ? ${LIKE_ESCAPE}`);
    whereParams.push(literalPrefixPattern(filter.path_prefix));
  }

  // Negation path prefix filter
  if (filter.without_path_prefix) {
    whereClauses.push(`${alias}.file_path NOT LIKE ? ${LIKE_ESCAPE}`);
    whereParams.push(literalPrefixPattern(filter.without_path_prefix));
  }

  // Exact directory filter (matches files whose immediate parent is the given dir)
  if (filter.path_dir !== undefined) {
    if (filter.path_dir === '' || filter.path_dir === '.') {
      whereClauses.push(`${alias}.file_path NOT LIKE '%/%'`);
    } else {
      const inside = literalPrefixPattern(`${filter.path_dir}/`);
      whereClauses.push(`${alias}.file_path LIKE ? ${LIKE_ESCAPE} AND ${alias}.file_path NOT LIKE ? ${LIKE_ESCAPE}`);
      whereParams.push(inside);
      whereParams.push(`${inside}/%`);
    }
  }

  // Modified since filter — file_mtime is stored in milliseconds (see indexer
  // and watcher: Math.floor(st.mtimeMs)), so the cutoff must also be in ms.
  if (filter.modified_since) {
    whereClauses.push(`${alias}.file_mtime >= ?`);
    whereParams.push(new Date(filter.modified_since).getTime());
  }

  if (filter.created_since) {
    whereClauses.push(`${alias}.created_at >= ?`);
    whereParams.push(new Date(filter.created_since).getTime());
  }

  if (filter.link_counts) {
    const counts = linkCountClauses(filter.link_counts, alias, db);
    whereClauses.push(...counts.whereClauses);
    whereParams.push(...counts.whereParams);
  }

  return { joins, joinParams, whereClauses, whereParams };
}

/**
 * Compiles JoinFilter[] into EXISTS (or NOT EXISTS) subqueries on relationships.
 *
 * Each join filter becomes a correlated subquery against `relationships rN`
 * joined (optionally) to `nodes tN`, where tN is the target node. The target's
 * own NodeQueryFilter is compiled recursively via buildFilterClauses at the
 * tN alias, so arbitrarily nested cross-node predicates are supported.
 *
 * Semantics:
 *   - direction='outgoing' (default): rN.source_id = parent.id
 *   - direction='incoming':           rN.resolved_target_id = parent.id
 *   - Unresolved edges (resolved_target_id IS NULL) are invisible to join filters.
 *   - rel_type: string => `= ?`, string[] => `IN (?, ?, ...)`.
 *   - target is optional; if absent, we only check edge existence.
 *   - Rejects empty JoinFilter (neither rel_type nor target) with INVALID_PARAMS.
 */
function buildJoinExistsClauses(
  filters: JoinFilter[] | undefined,
  parentAlias: string,
  idx: { n: number },
  db: Database.Database | undefined,
  negated: boolean,
  classification?: ClassificationReadContext,
): { whereClauses: string[]; whereParams: unknown[] } {
  if (!filters || filters.length === 0) {
    return { whereClauses: [], whereParams: [] };
  }
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  for (const filter of filters) {
    if (!filter.rel_type && !filter.target) {
      throw new Error('INVALID_PARAMS: JoinFilter requires at least one of rel_type or target');
    }

    const direction = filter.direction ?? 'outgoing';
    const relAlias = `r${idx.n++}_${parentAlias}`;
    const targetAlias = `t${idx.n++}_${parentAlias}`;

    const outerCol = direction === 'outgoing' ? 'source_id' : 'resolved_target_id';
    const innerJoinCol = direction === 'outgoing' ? 'resolved_target_id' : 'source_id';

    const subJoins: string[] = [];
    const subJoinParams: unknown[] = [];
    const subWheres: string[] = [
      `${relAlias}.${outerCol} = ${parentAlias}.id`,
      `${relAlias}.resolved_target_id IS NOT NULL`,
    ];
    const subWhereParams: unknown[] = [];

    if (filter.rel_type) {
      const types = Array.isArray(filter.rel_type) ? filter.rel_type : [filter.rel_type];
      if (types.length === 1) {
        subWheres.push(`${relAlias}.rel_type = ?`);
        subWhereParams.push(types[0]);
      } else {
        subWheres.push(`${relAlias}.rel_type IN (${types.map(() => '?').join(', ')})`);
        subWhereParams.push(...types);
      }
    }

    // Build target's own clauses (recursive) at targetAlias.
    let innerJoin = '';
    if (filter.target) {
      if ('join_filters' in filter.target || 'without_joins' in filter.target) {
        throw new Error('INVALID_PARAMS: nested join_filters/without_joins inside target are not supported (multi-hop joins deferred)');
      }
      innerJoin = `INNER JOIN nodes ${targetAlias} ON ${targetAlias}.id = ${relAlias}.${innerJoinCol}`;
      const targetClauses = buildFilterClauses(filter.target, targetAlias, idx, db, classification);
      subJoins.push(...targetClauses.joins);
      subJoinParams.push(...targetClauses.joinParams);
      subWheres.push(...targetClauses.whereClauses);
      subWhereParams.push(...targetClauses.whereParams);
      if(filter.target.where) { const expression=compileExpression(filter.target.where,targetAlias,idx,db,classification); subWheres.push(expression.sql); subWhereParams.push(...expression.params); }
    }

    const existsSql =
      `SELECT 1 FROM relationships ${relAlias}` +
      (innerJoin ? ` ${innerJoin}` : '') +
      (subJoins.length ? ' ' + subJoins.join(' ') : '') +
      ' WHERE ' + subWheres.join(' AND ');

    whereClauses.push(`${negated ? 'NOT EXISTS' : 'EXISTS'} (${existsSql})`);
    // Within the EXISTS subquery, SQL placeholders appear in order:
    //   1. INNER JOIN nodes tN (no params)
    //   2. target's JOIN clauses (subJoinParams)
    //   3. WHERE clauses (subWhereParams)
    whereParams.push(...subJoinParams, ...subWhereParams);
  }

  return { whereClauses, whereParams };
}
/** Isolate each leaf's joins so an OR never requires another branch's fields. */
function compileExpression(expression: FilterExpression<NodeQueryFilterLeaf>, parentAlias: string, idx: {
  n: number;
}, db?: Database.Database, classification?: ClassificationReadContext): {
  sql: string;
  params: unknown[];
} {
  if ('all' in expression || 'any' in expression) {
    const all = 'all' in expression;
    const children = (all ? expression.all : (expression as {
      any: FilterExpression<NodeQueryFilterLeaf>[];
    }).any).map(child => compileExpression(child, parentAlias, idx, db, classification));
    return { sql: `(${children.map(c => c.sql).join(all ? ' AND ' : ' OR ')})`, params: children.flatMap(c => c.params) };
  }
  const alias = `b${idx.n++}`;
  const c = buildFilterClauses(expression, alias, idx, db, classification);
  const joins = buildJoinExistsClauses(expression.join_filters, alias, idx, db, false, classification);
  const without = buildJoinExistsClauses(expression.without_joins, alias, idx, db, true, classification);
  const predicates = [`${alias}.id = ${parentAlias}.id`, ...c.whereClauses, ...joins.whereClauses, ...without.whereClauses];
  return { sql: `EXISTS (SELECT 1 FROM nodes ${alias} ${c.joins.join(' ')} WHERE ${predicates.join(' AND ')})`, params: [...c.joinParams, ...c.whereParams, ...joins.whereParams, ...without.whereParams] };
}


export function buildNodeQuery(filter: NodeQueryFilter, db?: Database.Database, classification?: ClassificationReadContext): NodeQueryResult {
  assertExpressionBudget([{filter,profile:'query',path:'query'}]);
  const idx = { n: 0 };
  const base = buildFilterClauses(filter, 'n', idx, db, classification);

  const joinsFilterClauses = buildJoinExistsClauses(filter.join_filters, 'n', idx, db, false, classification);
  const withoutJoinsClauses = buildJoinExistsClauses(filter.without_joins, 'n', idx, db, true, classification);

  const joins = base.joins;
  const joinParams = base.joinParams;
  const whereClauses = [
    ...base.whereClauses,
    ...joinsFilterClauses.whereClauses,
    ...withoutJoinsClauses.whereClauses,
  ];
  const whereParams = [
    ...base.whereParams,
    ...joinsFilterClauses.whereParams,
    ...withoutJoinsClauses.whereParams,
  ];

  if(filter.where) { const expression=compileExpression(filter.where,'n',idx,db,classification); whereClauses.push(expression.sql); whereParams.push(...expression.params); }
  const joinSql = joins.join('\n');
  const whereSql = whereClauses.length > 0
    ? 'WHERE ' + whereClauses.join(' AND ')
    : '';

  // Params must match SQL placeholder order: all outer JOIN params first, then all WHERE params
  // (EXISTS subquery params are included in whereParams since the EXISTS predicate is in WHERE).
  const params = [...joinParams, ...whereParams];

  const baseFrom = `FROM nodes n`;
  const countSql = `SELECT COUNT(DISTINCT n.id) as total ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();
  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body, n.version ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();

  const idSql = `SELECT DISTINCT n.id ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();

  return { sql, countSql, idSql, params };
}
