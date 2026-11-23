import type Database from 'better-sqlite3';
import type { Embedder } from './embedder.js';
import type { SearchHit } from './types.js';
import { STOPWORDS } from './stopwords.js';
import { getVaultSettings } from '../settings/vault.js';

const RRF_K = 60;
const VECTOR_LIMIT = 400;
const SNIPPET_CONTEXT = 40; // characters around match

// FTS5 BM25 per-column weights, in nodes_fts column order:
// title, aliases, path, fields, links, body. Alternate titles rank like titles;
// serialized frontmatter (project/tags/people/...) and link targets sit above body.
// Starting values - tuned by the real-vault sweep (see plan Task 7).
const FTS_TITLE_WEIGHT = 10.0;
const FTS_ALIASES_WEIGHT = 10.0;
const FTS_PATH_WEIGHT = 2.0;
const FTS_FIELDS_WEIGHT = 4.0;
const FTS_LINKS_WEIGHT = 3.0;
const FTS_BODY_WEIGHT = 1.0;

// An exact (normalized) title match is a high-precision known-item signal. The bonus
// dwarfs any single RRF lane contribution (max ~1/(RRF_K+1) ≈ 0.0164) so an exact title
// surfaces at the top, while still flowing THROUGH fusion rather than hard-overriding it.
const EXACT_TITLE_BONUS = 1.0;

// Query-adaptive fusion: when FTS has a high-confidence (title-AND) hit, the query is
// navigational and the semantic lane only dilutes precision, so scale its RRF
// contribution down. When there is no such hit (topical query), the weight stays 1.0
// and fusion is unchanged — semantic remains the only signal. Value fixed by the
// real-vault sweep in the plan (see Task 5); 0.3 is the starting candidate.
const SEM_WEIGHT_WHEN_FTS_CONFIDENT = 0.3;
const FTS_TITLE_HIT_TOPK = 5;

// Semantic extraction chunks are useful recall signals, but extracted attachments
// are noisier than first-class node text. Real-vault sweep on 2026-07-07 across
// 0.7/0.5/0.3/0.1 preserved attachment_noise hit@1 and known-item hit@1 at 100%;
// choose the least aggressive sub-parity value.
const EXTRACTION_WEIGHT = 0.7;

// Stopword-pruned OR recall lane (finding #3): broadens conversational queries
// but is noisier than strict-AND, so its RRF contribution is down-weighted and
// it only runs for non-navigational queries (ftsHasTitleHit gate). Real-vault
// sweep 2026-07-07: 0.2/0.3/0.5 tie on every golden bucket (known-item held at
// 100% throughout); 0.7 degrades topical & conceptual recall@5 with no offsetting
// gain — 0.5 is the top of the plateau, so it stays.
const RECALL_WEIGHT = 0.5;

// Fetch node metadata in batches under SQLite's default 999 bind-variable limit.
const NODE_META_BATCH = 900;

// ── Cycle 4: second-stage feature-blend reranker (review lever #6) ──────────
// Rescores the top RERANK_WINDOW fused candidates additively and subsumes the
// Cycle 3/3.5 wiki + duplicate demotion (their logic survives as the two penalty
// features). All swept weights below are STARTING CANDIDATES pending the scripted
// coordinate sweep (scripts/sweep-rerank.ts); every frozen value must cite its
// sweep, as EXTRACTION_WEIGHT / RECALL_WEIGHT do. `base` is the anchor (1.0,
// never swept). `modelScore` is the cross-encoder hook — weight 0 until a model
// cycle benchmarks one; adding it later is one field + one weight, nothing else.
export const RERANK_WINDOW = 50;

export interface RerankWeights {
  base: number;
  titleQueryCoverage: number;
  titlePrecision: number;
  wikiUnnamed: number;
  duplicateLoser: number;
  inboundLinks: number;
  chatterType: number;
  modelScore: number;
}

// Frozen by the 2026-07-09 coordinate sweep (scripts/sweep-rerank.ts, 29 configs,
// 2 rounds, prod snapshot, known-item hard gate held 100%/1.000 at every config):
// - titleQueryCoverage 0.15: 0.3/0.5 tie it on every metric — least-aggressive wins.
// - titlePrecision 0.4: top of its range; carries topical recall@5 85.7%→100% with
//   coverage relaxed (the two title features trade off; precision-heavy won).
// - wikiUnnamed -0.5: load-bearing — -0.3/-0.15 drop canonical hit@1 100%→67%.
// - duplicateLoser -0.15: -0.15/-0.3/-0.5 tie on every metric — least-aggressive.
// - inboundLinks 0.1: 0 drops precision MRR 0.939→0.922 and topical R@5 100%→85.7%;
//   0.2 ties 0.1 — least-aggressive.
// - chatterType 0: -0.1/-0.2 measured ZERO effect on any golden metric — knob
//   removed, as the spec's "disposable knob" framing anticipated.
// Winner objective: canonical hit@1 1.000 / MRR 1.000, precision MRR 0.939,
// topical recall@5 1.000. Sweep table: bench sweep-rerank.json artifact (session).
export const RERANK_WEIGHTS: RerankWeights = Object.freeze({
  base: 1.0,
  titleQueryCoverage: 0.15,
  titlePrecision: 0.4,
  wikiUnnamed: -0.5,
  duplicateLoser: -0.15,
  inboundLinks: 0.1,
  chatterType: 0,
  modelScore: 0,
});

// Sweep/test hook: scripts/sweep-rerank.ts swaps configs in-process so the query
// embedding cache survives across configs. Production code never calls this.
let activeRerankWeights: RerankWeights = RERANK_WEIGHTS;
export function setRerankWeights(w: RerankWeights | null): void {
  activeRerankWeights = w ?? RERANK_WEIGHTS;
}
export function getActiveRerankWeights(): RerankWeights {
  return activeRerankWeights;
}

export interface RerankFeatures {
  base: number;                 // fused score / window max — (0, 1]
  titleQueryCoverage: number;   // |Q ∩ T| / |Q|
  titlePrecision: number;       // |Q ∩ T| / |T|
  wikiUnnamed: 0 | 1;           // isWiki AND NOT (T ⊆ Q) AND not exact-title
  duplicateLoser: 0 | 1;        // non-top member of an in-window same-title group
  inboundLinks: number;         // log1p(n) / log1p(window max n)
  chatterType: 0 | 1;           // vault map's meeting/daily-note/transcript kind AND non-navigational
  modelScore?: number;          // cross-encoder hook — absent in v1
}

export function blendRerankScore(f: RerankFeatures, w: RerankWeights = activeRerankWeights): number {
  return (
    w.base * f.base +
    w.titleQueryCoverage * f.titleQueryCoverage +
    w.titlePrecision * f.titlePrecision +
    w.wikiUnnamed * f.wikiUnnamed +
    w.duplicateLoser * f.duplicateLoser +
    w.inboundLinks * f.inboundLinks +
    w.chatterType * f.chatterType +
    w.modelScore * (f.modelScore ?? 0)
  );
}

export interface RerankCandidate {
  nodeId: string;
  score: number;
}

/**
 * Compute blend features for every member of the rerank window. Window-level on
 * purpose: base/link normalization and duplicate grouping are properties of the
 * window, not of a candidate in isolation. Query side: deduped, lowercased
 * content tokens. Title side: contentTokens over queryTokens(normTitle) — the
 * same pure-stopword fallback as everywhere else this cycle-family.
 */
export function extractRerankFeatures(
  window: RerankCandidate[],
  nodeMeta: Map<string, NodeMeta>,
  queryContentTokens: Set<string>,
  exactTitleIds: Set<string>,
  navigational: boolean,
): Map<string, RerankFeatures> {
  let maxScore = 0;
  let maxLinks = 0;
  for (const c of window) {
    if (c.score > maxScore) maxScore = c.score;
    const links = nodeMeta.get(c.nodeId)?.inboundLinks ?? 0;
    if (links > maxLinks) maxLinks = links;
  }

  // Duplicate groups within the window; exact-title members never participate
  // (a genuine known-item collision stays intact — Cycle 3 semantics).
  const groups = new Map<string, RerankCandidate[]>();
  for (const c of window) {
    if (exactTitleIds.has(c.nodeId)) continue;
    const t = nodeMeta.get(c.nodeId)?.normTitle;
    if (!t) continue;
    let g = groups.get(t);
    if (!g) {
      g = [];
      groups.set(t, g);
    }
    g.push(c);
  }
  const losers = new Set<string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let top = g[0];
    for (const c of g) {
      if (c.score > top.score || (c.score === top.score && c.nodeId < top.nodeId)) top = c;
    }
    for (const c of g) if (c.nodeId !== top.nodeId) losers.add(c.nodeId);
  }

  const out = new Map<string, RerankFeatures>();
  for (const c of window) {
    const meta = nodeMeta.get(c.nodeId);
    const exact = exactTitleIds.has(c.nodeId);
    const titleTokens = meta ? contentTokens([...queryTokens(meta.normTitle)]) : [];
    let inter = 0;
    for (const t of titleTokens) if (queryContentTokens.has(t)) inter++;
    const named = titleTokens.length > 0 && inter === titleTokens.length;
    out.set(c.nodeId, {
      base: maxScore > 0 ? c.score / maxScore : 1,
      titleQueryCoverage: queryContentTokens.size > 0 ? inter / queryContentTokens.size : 0,
      titlePrecision: titleTokens.length > 0 ? inter / titleTokens.length : 0,
      wikiUnnamed: meta?.isWiki && !named && !exact ? 1 : 0,
      duplicateLoser: losers.has(c.nodeId) ? 1 : 0,
      inboundLinks: maxLinks > 0 ? Math.log1p(meta?.inboundLinks ?? 0) / Math.log1p(maxLinks) : 0,
      chatterType: meta?.isChatter && !navigational ? 1 : 0,
    });
  }
  return out;
}

/** Normalize a string into a set of lowercased, alphanumeric tokens (Unicode-aware). */
export function queryTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

/** Split into ordered alphanumeric tokens (Unicode-aware), preserving order + duplicates. */
function ftsTokens(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Filter stopwords (function words) out of a token list, case-insensitively.
 * Falls back to the input unchanged when pruning would leave nothing — a
 * pure-stopword query ("to do") keeps today's behavior at every call site.
 */
export function contentTokens(tokens: string[]): string[] {
  const content = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  return content.length > 0 ? content : tokens;
}

/**
 * Build a safe FTS5 MATCH expression from a raw user query for the ranked lane.
 *  - Double-quoted segments become FTS5 phrase queries (adjacent-term match), e.g.
 *    `"machine learning"` matches the two terms in sequence.
 *  - Everything else is tokenized and each token is wrapped as an FTS5 string literal,
 *    so punctuation/operators in user input (`/`, `-`, `'`, `AND`, unbalanced `"`) can't
 *    raise a syntax error or be interpreted as an FTS5 operator.
 * Loose tokens are stopword-pruned (Cycle 3.5, finding #3 tail): the implicit-AND lane
 * must not REQUIRE function words — "planning a trip to northstar coast" must also match
 * short notes that never say "a"/"to". Quoted phrases keep their stopwords verbatim
 * (quoting is an explicit exactness request), and a pure-stopword query falls back to
 * its unpruned tokens rather than silently emptying the lane. Returns '' when the
 * query has no searchable tokens — the caller then skips the FTS lane.
 */
export function buildFtsMatchQuery(query: string): string {
  const parts: string[] = [];
  const unpruned: string[] = [];
  const pushLoose = (segment: string): void => {
    for (const tok of ftsTokens(segment)) {
      unpruned.push(`"${tok}"`);
      if (!STOPWORDS.has(tok.toLowerCase())) parts.push(`"${tok}"`);
    }
  };
  const phraseRe = /"([^"]*)"/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(query)) !== null) {
    pushLoose(query.slice(lastIndex, m.index));
    const phraseTokens = ftsTokens(m[1]);
    if (phraseTokens.length) {
      const phrase = `"${phraseTokens.join(' ')}"`;
      parts.push(phrase);
      unpruned.push(phrase);
    }
    lastIndex = phraseRe.lastIndex;
  }
  pushLoose(query.slice(lastIndex));
  return (parts.length > 0 ? parts : unpruned).join(' ');
}

/**
 * Build the recall-lane MATCH expression (finding #3): drop stopwords, OR the
 * surviving content tokens. Returns '' when fewer than 2 content tokens survive
 * - with 0 there is nothing to match; with 1 the OR query is byte-identical to
 * the strict-AND query, so the recall lane would only add a redundant term. The
 * caller skips the lane on ''. Tokens are alphanumeric-only, so quoting is safe.
 */
export function buildRecallMatchQuery(query: string): string {
  const content = ftsTokens(query).filter((t) => !STOPWORDS.has(t.toLowerCase()));
  if (content.length < 2) return '';
  return content.map((t) => `"${t}"`).join(' OR ');
}

/**
 * High-confidence navigational signal: true iff one of the first `k` FTS hits has a
 * title whose token set contains EVERY query token (a "title-AND" match). This means
 * the best FTS matches are *title* matches (e.g. "ev 6" -> "Nimbus EV 6
 * Replacement"), not body mentions — the case where the semantic lane only dilutes.
 * Reworded topical queries carry extra tokens absent from any title and return false.
 */
export function ftsHasTitleHit(ftsHits: { title: string | null }[], query: string, k: number): boolean {
  // Cycle 3.5: compare content tokens only — "the northstar coast trip" must register
  // as navigational against the title "Northstar Coast Trip". contentTokens falls back
  // to the full set for pure-stopword queries. Title tokens stay unpruned: a
  // title's own stopwords only enlarge the containment superset, which is harmless.
  const qTokens = new Set(contentTokens([...queryTokens(query)]));
  if (qTokens.size === 0) return false;
  for (const hit of ftsHits.slice(0, k)) {
    if (!hit.title) continue;
    const titleTokens = queryTokens(hit.title);
    let containsAll = true;
    for (const t of qTokens) {
      if (!titleTokens.has(t)) {
        containsAll = false;
        break;
      }
    }
    if (containsAll) return true;
  }
  return false;
}

/**
 * Build a simple highlighted snippet from text, wrapping matched CONTENT terms with
 * <mark> at Unicode word boundaries (stopwords are pruned by the caller; a substring
 * match inside a longer word never marks). Since nodes_fts uses content=''
 * (contentless), SQLite highlight() returns null, so we generate snippets in JS.
 */
function buildSnippet(text: string | null, queryTerms: string[]): string | null {
  if (!text) return null;

  let result = text;
  // Escape terms and wrap with <mark>
  for (const term of queryTerms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      // Unicode-aware word boundary: JS \b is ASCII-only and vault text carries
      // Unicode. Tokens are alphanumeric, so letter/number lookarounds are exact.
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
      result = result.replace(re, (match) => `<mark>${match}</mark>`);
    } catch {
      // Ignore regex errors for unusual terms
    }
  }

  // If no marks were inserted, return null to signal no match in this field
  if (!result.includes('<mark>')) return null;

  // Trim to a reasonable length around the first match
  const firstMark = result.indexOf('<mark>');
  const start = Math.max(0, firstMark - SNIPPET_CONTEXT);
  const end = Math.min(result.length, firstMark + SNIPPET_CONTEXT * 3);
  let snippet = result.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < result.length) snippet = snippet + '...';

  return snippet;
}

export interface HybridSearchOptions {
  candidateIds?: string[];
  limit?: number;
  mode?: 'fts' | 'semantic' | 'hybrid';
  /** Invoked if the FTS5 MATCH throws (invalid query syntax). The FTS leg then
   *  contributes zero hits; callers can surface this rather than silently dropping it. */
  onFtsError?: (err: unknown) => void;
}

interface FtsHit {
  node_id: string;
  title: string | null;
  body: string | null;
}

interface VecHit {
  meta_id: number;
  node_id: string;
  source_type: 'node' | 'extraction';
  extraction_ref: string | null;
  chunk_index: number;
  distance: number;
}

/** Execute a prebuilt FTS5 MATCH expression against nodes_fts (bm25-ranked). */
function ftsSearchWith(
  db: Database.Database,
  match: string,
  candidateIds?: string[],
  onError?: (err: unknown) => void,
): FtsHit[] {
  try {
    if (candidateIds !== undefined && candidateIds.length === 0) return [];
    if (!match) return [];

    let sql: string;
    let params: unknown[];
    const bm25 = `bm25(nodes_fts, ${FTS_TITLE_WEIGHT}, ${FTS_ALIASES_WEIGHT}, ${FTS_PATH_WEIGHT}, ${FTS_FIELDS_WEIGHT}, ${FTS_LINKS_WEIGHT}, ${FTS_BODY_WEIGHT})`;
    if (candidateIds !== undefined && candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => '?').join(', ');
      sql = `
        SELECT n.id as node_id, n.title, n.body
        FROM nodes_fts
        INNER JOIN nodes n ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?
          AND n.id IN (${placeholders})
        ORDER BY ${bm25}
      `;
      params = [match, ...candidateIds];
    } else {
      sql = `
        SELECT n.id as node_id, n.title, n.body
        FROM nodes_fts
        INNER JOIN nodes n ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?
        ORDER BY ${bm25}
      `;
      params = [match];
    }
    return db.prepare(sql).all(...params) as FtsHit[];
  } catch (err) {
    onError?.(err);
    return [];
  }
}

/** Strict-AND lane: build a phrase-aware AND MATCH from the raw query, then execute. */
function ftsSearch(
  db: Database.Database,
  query: string,
  candidateIds?: string[],
  onError?: (err: unknown) => void,
): FtsHit[] {
  return ftsSearchWith(db, buildFtsMatchQuery(query), candidateIds, onError);
}

function vectorSearch(
  db: Database.Database,
  queryVec: Float32Array,
  candidateIds?: string[],
): VecHit[] {
  if (candidateIds !== undefined && candidateIds.length === 0) {
    return [];
  }

  const queryBytes = new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

  // sqlite-vec may not support complex WHERE clauses on the virtual table,
  // so we do candidate filtering in JS afterward.
  const sql = `
    SELECT v.id as meta_id, m.node_id, m.source_type, m.extraction_ref, m.chunk_index, v.distance
    FROM embedding_vec v
    INNER JOIN embedding_meta m ON m.id = v.id
    WHERE v.vector MATCH ? AND k = ?
  `;

  const rows = db.prepare(sql).all(queryBytes, VECTOR_LIMIT) as VecHit[];

  if (candidateIds !== undefined) {
    const candidateSet = new Set(candidateIds);
    return rows.filter(r => candidateSet.has(r.node_id));
  }

  return rows;
}

/** Per-node ranking metadata for the Cycle 4 rerank blend (formerly the demotion pass). */
export interface NodeMeta {
  isWiki: boolean;
  normTitle: string;
  inboundLinks: number;
  isChatter: boolean;
}

/** Duplicate-group key: lowercased, trimmed title. Matches the known-item collision
 *  key in bench/golden.ts so the two views of "same title" agree. */
function normalizeTitle(title: string | null): string {
  return (title ?? '').trim().toLowerCase();
}

/**
 * Fetch per-node ranking metadata (wiki-type flag, normalized title, inbound-link
 * count, chatter-type flag) for a set of candidate node ids, batched under SQLite's
 * bind-variable limit. Feeds both the hybrid canonical-demotion pass and the Cycle 4
 * rerank blend. A node absent from `nodes` simply won't appear in the map, so callers
 * skip it.
 */
export function buildNodeMeta(db: Database.Database, ids: string[]): Map<string, NodeMeta> {
  const meta = new Map<string, NodeMeta>();
  // Kinds come from the vault map: wiki pages are its wikiType, chatter its meeting,
  // transcript and daily-note kinds (#572). A kind that is none flags nothing.
  const vault = getVaultSettings(db);
  const wikiType = vault.wikiType;
  const chatterTypes = [...new Set([vault.dailyNoteType, vault.meetingType, vault.transcriptType])]
    .filter((type): type is string => type !== null);
  for (let i = 0; i < ids.length; i += NODE_META_BATCH) {
    const batch = ids.slice(i, i + NODE_META_BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT n.id AS id, n.title AS title,
                ${wikiType === null ? '0' : 'EXISTS(SELECT 1 FROM node_types t WHERE t.node_id = n.id AND t.schema_type = ?)'} AS is_wiki,
                EXISTS(SELECT 1 FROM node_types t WHERE t.node_id = n.id
                       AND t.schema_type IN (${chatterTypes.map(() => '?').join(', ')})) AS is_chatter
         FROM nodes n
         WHERE n.id IN (${placeholders})`,
      )
      .all(...(wikiType === null ? [] : [wikiType]), ...chatterTypes, ...batch) as { id: string; title: string | null; is_wiki: number; is_chatter: number }[];
    // Inbound-link counts in one grouped pass per batch. relationships has no
    // index on resolved_target_id today; if this proves slow on the real vault
    // (measure during the sweep), add a plain index via a migration — never in
    // createSchema (CREATE TABLE IF NOT EXISTS no-ops on existing DBs).
    const linkRows = db
      .prepare(
        `SELECT resolved_target_id AS id, COUNT(*) AS n
         FROM relationships
         WHERE resolved_target_id IN (${placeholders})
         GROUP BY resolved_target_id`,
      )
      .all(...batch) as { id: string; n: number }[];
    const links = new Map(linkRows.map((r) => [r.id, r.n]));
    for (const r of rows) {
      meta.set(r.id, {
        isWiki: r.is_wiki === 1,
        normTitle: normalizeTitle(r.title),
        inboundLinks: links.get(r.id) ?? 0,
        isChatter: r.is_chatter === 1,
      });
    }
  }
  return meta;
}

function fuseResults(
  ftsHits: FtsHit[],
  vecHits: VecHit[],
  limit: number,
  queryTerms: string[],
  exactTitleIds: Set<string> = new Set(),
  semanticWeight = 1.0,
  recallHits: FtsHit[] = [],
  recallWeight = 0,
  nodeMeta?: Map<string, NodeMeta>,
  navigational = false,
): SearchHit[] {
  // Map from node_id to accumulated score and metadata
  const nodeMap = new Map<
    string,
    {
      score: number;
      match_sources: Set<'fts' | 'semantic'>;
      snippet?: string;
      matched_embed?: string;
      matched_chunk_index?: number;
    }
  >();

  function getOrCreate(nodeId: string) {
    let entry = nodeMap.get(nodeId);
    if (!entry) {
      entry = { score: 0, match_sources: new Set() };
      nodeMap.set(nodeId, entry);
    }
    return entry;
  }

  // Apply FTS ranks (rank 1-based)
  for (let i = 0; i < ftsHits.length; i++) {
    const hit = ftsHits[i];
    const rank = i + 1;
    const entry = getOrCreate(hit.node_id);
    entry.score += 1 / (RRF_K + rank);
    entry.match_sources.add('fts');
    // Build snippet from FTS hit content (highlight/snippet doesn't work on contentless FTS5)
    if (!entry.snippet) {
      const text = [hit.title, hit.body].filter(Boolean).join(' ');
      entry.snippet = buildSnippet(text, queryTerms) ?? undefined;
    }
  }

  // Recall lane (finding #3): a down-weighted RRF list. Marked 'fts' (it IS an FTS
  // lane) so the SearchHit wire shape is unchanged. A node in both lists accrues
  // both terms; recallWeight keeps the recall term small vs. a strict-AND hit.
  for (let i = 0; i < recallHits.length; i++) {
    const hit = recallHits[i];
    const rank = i + 1;
    const entry = getOrCreate(hit.node_id);
    entry.score += recallWeight * (1 / (RRF_K + rank));
    entry.match_sources.add('fts');
    if (!entry.snippet) {
      const text = [hit.title, hit.body].filter(Boolean).join(' ');
      entry.snippet = buildSnippet(text, queryTerms) ?? undefined;
    }
  }

  const nodeTextCandidates = new Map<string, { rankScore: number; hit: VecHit }>();
  const extractionCandidates = new Map<string, { rankScore: number; hit: VecHit }>();
  let nodeTextRank = 0;
  let extractionRank = 0;

  // Collapse vector chunks to one semantic contribution per node. Dense ranks are
  // assigned independently in the node-text and extraction lanes so many chunks
  // from the same node cannot accumulate extra RRF credit.
  for (const hit of vecHits) {
    if (hit.source_type === 'extraction') {
      if (extractionCandidates.has(hit.node_id)) continue;
      extractionRank += 1;
      extractionCandidates.set(hit.node_id, { rankScore: 1 / (RRF_K + extractionRank), hit });
      continue;
    }

    if (nodeTextCandidates.has(hit.node_id)) continue;
    nodeTextRank += 1;
    nodeTextCandidates.set(hit.node_id, { rankScore: 1 / (RRF_K + nodeTextRank), hit });
  }

  const semanticNodeIds = new Set([...nodeTextCandidates.keys(), ...extractionCandidates.keys()]);
  for (const nodeId of semanticNodeIds) {
    const nodeTextCandidate = nodeTextCandidates.get(nodeId);
    const extractionCandidate = extractionCandidates.get(nodeId);
    const nodeTextScore = nodeTextCandidate?.rankScore ?? 0;
    const extractionScore = extractionCandidate ? EXTRACTION_WEIGHT * extractionCandidate.rankScore : 0;
    const winningCandidate = nodeTextScore >= extractionScore ? nodeTextCandidate : extractionCandidate;

    if (!winningCandidate) continue;

    const entry = getOrCreate(nodeId);
    entry.score += semanticWeight * Math.max(nodeTextScore, extractionScore);
    entry.match_sources.add('semantic');
    entry.matched_chunk_index = winningCandidate.hit.chunk_index;

    if (winningCandidate.hit.source_type === 'extraction' && winningCandidate.hit.extraction_ref !== null) {
      entry.matched_embed = winningCandidate.hit.extraction_ref;
    }
  }

  // Cycle 4 second-stage rerank (review lever #6): rescore the top RERANK_WINDOW
  // fused candidates with the feature blend (subsumes the Cycle 3/3.5 wiki +
  // duplicate demotion — see RERANK_WEIGHTS), then affine-remap the blended order
  // back into the window's raw score envelope so the global score scale — and the
  // calibrated EXACT_TITLE_BONUS added below — stay meaningful. Hybrid-only:
  // nodeMeta is built only there; fts/semantic modes and legacy callers are
  // byte-identical. Below-window candidates keep raw scores and order.
  if (nodeMeta) {
    const ranked = [...nodeMap.entries()].sort((a, b) => b[1].score - a[1].score);
    const window: RerankCandidate[] = ranked
      .slice(0, RERANK_WINDOW)
      .map(([nodeId, e]) => ({ nodeId, score: e.score }));
    if (window.length > 1) {
      const queryContentTokens = new Set(queryTerms.map((t) => t.toLowerCase()));
      const feats = extractRerankFeatures(window, nodeMeta, queryContentTokens, exactTitleIds, navigational);
      const rawMax = window[0].score;
      const rawMin = window[window.length - 1].score;
      const blended = window
        .map((c) => ({ nodeId: c.nodeId, final: blendRerankScore(feats.get(c.nodeId)!) }))
        .sort((a, b) => b.final - a.final || (a.nodeId < b.nodeId ? -1 : 1));
      const fMax = blended[0].final;
      const fMin = blended[blended.length - 1].final;
      if (fMax > fMin && rawMax > rawMin) {
        for (const b of blended) {
          nodeMap.get(b.nodeId)!.score = rawMin + ((b.final - fMin) * (rawMax - rawMin)) / (fMax - fMin);
        }
      }
      // Degenerate windows (all-equal finals or all-equal raws) keep raw scores.
    }
  }

  // Apply exact-title precision bonus (after RRF accumulation, before sort).
  // Note: an exact-title-only hit (one that FTS and vector both missed) will surface with an
  // empty match_sources array — this is intentional; consumers treat match_sources as optional.
  for (const id of exactTitleIds) {
    getOrCreate(id).score += EXACT_TITLE_BONUS;
  }

  // Convert to SearchHit array
  const hits: SearchHit[] = [];
  for (const [node_id, entry] of nodeMap) {
    const hit: SearchHit = {
      node_id,
      score: entry.score,
      match_sources: Array.from(entry.match_sources),
    };
    if (entry.snippet !== undefined) {
      hit.snippet = entry.snippet;
    }
    if (entry.matched_embed !== undefined) {
      hit.matched_embed = entry.matched_embed;
    }
    if (entry.matched_chunk_index !== undefined) {
      hit.matched_chunk_index = entry.matched_chunk_index;
    }
    hits.push(hit);
  }

  // Sort by score descending, slice to limit
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export async function hybridSearch(
  db: Database.Database,
  embedder: Embedder | null,
  query: string,
  options: HybridSearchOptions,
): Promise<SearchHit[]> {
  const mode = options.mode ?? 'hybrid';
  if (mode !== 'fts' && !embedder) throw new Error(`search_mode=${mode} requires an embedder`);
  const vector = mode === 'fts' ? null : await embedder!.embedQuery(query);
  return hybridSearchPrepared(db,query,options,vector);
}
export function hybridSearchPrepared(db: Database.Database, query: string, options: HybridSearchOptions, queryVector: Float32Array | null): SearchHit[] {
  const limit = options.limit ?? 20;
  const candidateIds = options.candidateIds;
  const mode = options.mode ?? 'hybrid';
  // Snippet highlight terms (Cycle 3.5): tokenized + stopword-pruned. The raw
  // whitespace split marked "a"/"to" — as boundless substrings — in every snippet.
  const queryTerms = contentTokens(ftsTokens(query));

  // Exact/near-exact title precision lane (respects candidate filter).
  // Both sides use SQL lower(trim()) so casefold is always identical.
  // JS toLowerCase() is Unicode-aware (Ü→ü) but SQLite lower() is ASCII-only (Ü stays Ü);
  // binding the raw query and letting SQLite fold both sides avoids the divergence.
  // Guard: skip the lookup for whitespace-only queries — trim() → '' would match empty/whitespace titles.
  const exactRows = query.trim()
    ? (db
        .prepare('SELECT id FROM nodes WHERE lower(trim(title)) = lower(trim(?))')
        .all(query) as { id: string }[])
    : [];
  const candidateSet = candidateIds ? new Set(candidateIds) : null;
  const exactTitleIds = new Set(
    exactRows.map((r) => r.id).filter((id) => !candidateSet || candidateSet.has(id)),
  );

  if (mode === 'fts') {
    return fuseResults(ftsSearch(db, query, candidateIds, options.onFtsError), [], limit, queryTerms, exactTitleIds);
  }
  if (mode === 'semantic') {
    if (!queryVector) throw new Error('search_mode=semantic requires an embedder');
    const vec = vectorSearch(db, queryVector, candidateIds);
    return fuseResults([], vec, limit, queryTerms, exactTitleIds);
  }
  // hybrid (default)
  if (!queryVector) throw new Error('search_mode=hybrid requires an embedder');
  const ftsHits = ftsSearch(db, query, candidateIds, options.onFtsError);
  const vec = vectorSearch(db, queryVector, candidateIds);
  // Query-adaptive: a high-confidence FTS title hit means the query is navigational,
  // so down-weight the diluting semantic lane AND suppress the recall lane entirely.
  const navigational = ftsHasTitleHit(ftsHits, query, FTS_TITLE_HIT_TOPK);
  const semanticWeight = navigational ? SEM_WEIGHT_WHEN_FTS_CONFIDENT : 1.0;
  const recallHits = navigational
    ? []
    : ftsSearchWith(db, buildRecallMatchQuery(query), candidateIds, options.onFtsError);
  // The Cycle 4 rerank blend needs per-node metadata over the fused candidate
  // set; build it once from the union of lane hits. Wiki/duplicate handling are
  // blend features now (see RERANK_WEIGHTS); `navigational` governs the semantic
  // down-weight, the recall-lane skip, and the chatterType feature gate.
  const metaIds = new Set<string>();
  for (const h of ftsHits) metaIds.add(h.node_id);
  for (const h of recallHits) metaIds.add(h.node_id);
  for (const h of vec) metaIds.add(h.node_id);
  for (const id of exactTitleIds) metaIds.add(id);
  const nodeMeta = buildNodeMeta(db, [...metaIds]);
  return fuseResults(
    ftsHits,
    vec,
    limit,
    queryTerms,
    exactTitleIds,
    semanticWeight,
    recallHits,
    RECALL_WEIGHT,
    nodeMeta,
    navigational,
  );
}
