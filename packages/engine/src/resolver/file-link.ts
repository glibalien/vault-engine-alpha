// Filename-based link resolution (2026-08-03).
//
// A `[[ref]]` written into a markdown file is resolved by every consumer of that
// file against FILENAMES — Obsidian, Dataview, any other wikilink-aware tool,
// grep, a future client. The engine is the only reader with a title index:
// `resolveTarget` (resolve.ts) matches `nodes.title` at tier 2, BEFORE it ever
// looks at the basename at tier 3.
//
// That makes the engine the outlier, not any one app. When a note is created
// with a filename-illegal character in its title (`:` `/` `?` …),
// `sanitizeFilename` rewrites the FILENAME while `nodes.title` keeps the raw
// title. A link emitted from that title resolves engine-side — resolved_target_id
// is set, so near-miss detection is structurally blind to it — while being
// unresolvable from the files alone. Markdown is supposed to be a faithful
// rendered view of DB state; such a link is a rendering only the DB can read.
//
// This module is the missing predicate: "would a filename-based resolver find
// this?" Used by wiki live-section rendering (render-live.ts) to emit links that
// resolve BOTH ways, and by vault-doctor to report the ones already in the vault.
//
// NOTE ON LENIENCY: the matching below implements Obsidian's rules specifically
// — case-insensitive, vault-relative paths and a trailing `.md` accepted.
// Obsidian is this vault's actual client, and its rules are the most forgiving
// of the filename-based resolvers. Matching leniently is deliberate: anything
// reported here is broken under ANY filename-based reader, so the report is a
// lower bound with no false positives. Aliases are not part of it: Obsidian
// offers `aliases`/`alias` values in link autocomplete but writes
// `[[file|alias]]`, and resolves a bare `[[alias]]` to nothing (#211).

import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import { loadAliases, nameKeys, targetKeys } from './near-miss.js';
import { anchoredLinkName } from './resolve.js';

/** Filename matching folds case and normalizes unicode. */
function fold(s: string): string {
  return s.normalize('NFC').trim().toLowerCase();
}

function stripMd(s: string): string {
  return s.endsWith('.md') ? s.slice(0, -3) : s;
}

/**
 * Would a filename-based resolver match `linkText` to the note at `filePath`?
 *
 * Vault-relative path or bare basename, case-insensitive, optional `.md`.
 * Deliberately NOT title-aware — the title tier is exactly what no consumer
 * other than the engine has — and not alias-aware, like Obsidian. A link to a
 * heading or block (`Note#Heading`) is read by the note name before its `#`,
 * as Obsidian reads it (#613).
 */
export function resolvesByFilename(linkText: string, filePath: string): boolean {
  if (wholeResolvesByFilename(linkText, filePath)) return true;
  const name = anchoredLinkName(linkText);
  return name !== null && wholeResolvesByFilename(name, filePath);
}

function wholeResolvesByFilename(linkText: string, filePath: string): boolean {
  const ref = fold(stripMd(linkText));
  if (ref === '') return false;
  if (ref === fold(stripMd(filePath))) return true;
  return ref === fold(basename(filePath, '.md'));
}

/**
 * Whether some inbound link is bound to `nodeId` only through its stored
 * `title` — one its filename cannot reproduce (the engine's title tier) — so
 * resetting the title would unbind the link. Link repair rewrites such links
 * to name the file; one still here is a link its note could not be re-saved for.
 */
export function linksBoundThroughTitle(db: Database.Database, nodeId: string, title: string, filePath: string): boolean {
  if (resolvesByFilename(title, filePath)) return false;
  if (db.prepare('SELECT 1 FROM relationships WHERE resolved_target_id = ? AND target = ? LIMIT 1').get(nodeId, title) !== undefined) {
    return true;
  }
  // A link to a heading or block names the note before its `#` (#613).
  const anchored = db.prepare(`SELECT target FROM relationships WHERE resolved_target_id = ? AND instr(target, '#') > 0`)
    .all(nodeId) as Array<{ target: string }>;
  return anchored.some(row => anchoredLinkName(row.target) === title);
}

/**
 * Render a wikilink to `filePath` that displays `title`.
 *
 * When the title already resolves by filename (the overwhelming majority),
 * emits the plain `[[title]]` so healthy notes never churn. When it does not — a
 * sanitized filename, or a title that drifted from its file — emits
 * `[[basename|title]]`, which resolves for any filename-based reader AND at tier
 * 3 of the engine resolver, while the alias half keeps the true title visible.
 * Strictly more portable than emitting the bare title, which resolves only here.
 *
 * The target is always the BASENAME, never the vault-relative path. (Before #592
 * the engine's resolver had no tier matching a directory-qualified ref without
 * `.md`; it has now, but the basename stays the shorter, more readable target.)
 */
export function wikilinkTo(title: string, filePath?: string): string {
  const display = title.replace(/\|/g, '-');
  if (filePath === undefined) return `[[${display}]]`;
  const name = basename(filePath, '.md');
  // A pipe in the filename cannot be used as a link target — it would be parsed
  // as the alias delimiter. Nothing better than the plain title is available.
  if (name.includes('|')) return `[[${display}]]`;
  if (resolvesByFilename(title, filePath)) return `[[${display}]]`;
  return `[[${name}|${display}]]`;
}

export interface FilenameUnresolvableGroup {
  /** The raw link text as written in the vault. */
  target: string;
  /** The note it resolves to engine-side — the file the author meant. */
  file_path: string;
  edge_count: number;
  /** Files containing the unresolvable link text. */
  sources: string[];
  /** Node IDs of those files. */
  source_ids: string[];
}

/**
 * Finds edges that resolve engine-side but cannot be resolved from the files.
 *
 * The complement of `findNearMissTargets`, which only inspects
 * `resolved_target_id IS NULL`. An edge written from a title whose filename was
 * sanitized resolves at tier 2, so near-miss detection can never see it while it
 * is a dead link everywhere else. Ordered by edge_count descending. Repair the
 * raw link text via the mutation pipeline — never the resolver.
 */
export function findFilenameUnresolvableLinks(db: Database.Database): FilenameUnresolvableGroup[] {
  const rows = db.prepare(
    `SELECT r.target AS target, n.file_path AS file_path, r.source_id AS source_id, src.file_path AS source_path
       FROM relationships r
       JOIN nodes n ON n.id = r.resolved_target_id
       LEFT JOIN nodes src ON src.id = r.source_id
      WHERE r.resolved_target_id IS NOT NULL`
  ).all() as Array<{ target: string; file_path: string; source_id: string; source_path: string | null }>;
  if (rows.length === 0) return [];

  const groups = new Map<string, FilenameUnresolvableGroup>();
  for (const row of rows) {
    if (resolvesByFilename(row.target, row.file_path)) continue;
    const key = `${row.target} ${row.file_path}`;
    const group = groups.get(key);
    if (group) {
      group.edge_count++;
      if (row.source_path && !group.sources.includes(row.source_path)) group.sources.push(row.source_path);
      if (!group.source_ids.includes(row.source_id)) group.source_ids.push(row.source_id);
    } else {
      groups.set(key, {
        target: row.target,
        file_path: row.file_path,
        edge_count: 1,
        sources: row.source_path ? [row.source_path] : [],
        source_ids: [row.source_id],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.edge_count - a.edge_count);
}

export interface LinkTargetNode {
  id: string;
  file_path: string;
  title: string | null;
}

/**
 * Write-side repair for the two link-damage classes vault-doctor reports.
 *
 * `match` answers "which note does this link text mean, when no filename-based
 * reader can resolve it?" — the note whose title is exactly the text (a title
 * that drifted from its filename), or whose name or alias equals it under the
 * near-miss normalization (`normalizeRefKey`: filename sanitization, unicode
 * whitespace, dash spacing). Writers then emit `[[basename|text]]`, which
 * resolves for every reader and keeps the text as written visible — for an
 * alias, the link Obsidian itself writes when one is picked in autocomplete.
 * `linkTarget` picks that name: the basename, or the vault path when another
 * note also answers to the basename.
 *
 * Deliberately conservative: text that already resolves by filename is left
 * alone, and anything but exactly one candidate is not a match. Never used by
 * the resolver itself — this rewrites raw link text, which is the only repair
 * vault-doctor has ever prescribed. `aliases: false` leaves aliases out, for
 * callers that look a note up by name rather than repair a link.
 *
 * Loads the node catalog lazily, once per instance; create one per write.
 */
export class LinkCanonicalizer {
  private nodeRows: LinkTargetNode[] | null = null;
  private filenameRefs: Set<string> | null = null;
  private candidates: Map<string, LinkTargetNode[]> | null = null;
  private holders: Map<string, Set<string>> | null = null;

  constructor(private readonly db: Database.Database, private readonly options: { aliases?: boolean } = {}) {}

  /**
   * Whether `target` as a whole names some note: by filename, title, name or alias. Repair
   * reads only the name before a `#` (#613) when it does not, so a note whose filename holds a
   * `#` is never taken for a heading link.
   */
  namesAnyNote(target: string): boolean {
    const ref = stripMd(target);
    if (fold(ref) === '') return false;
    if (this.loadFilenameRefs().has(fold(ref))) return true;
    const candidates = this.loadCandidates();
    return [`title:${target}`, ...targetKeys(target).map(key => `key:${key}`)].some(key => (candidates.get(key)?.length ?? 0) > 0);
  }

  /** The one note `target` means when it does not resolve by filename, else null. */
  match(target: string, requiredType: string | null = null): LinkTargetNode | null {
    const ref = stripMd(target);
    if (fold(ref) === '') return null;
    if (this.loadFilenameRefs().has(fold(ref))) return null;

    const byId = new Map<string, LinkTargetNode>();
    const candidates = this.loadCandidates();
    for (const key of [`title:${target}`, ...targetKeys(target).map(key => `key:${key}`)]) {
      for (const node of candidates.get(key) ?? []) byId.set(node.id, node);
    }
    let matches = [...byId.values()];
    if (requiredType !== null) {
      const hasType = this.db.prepare('SELECT 1 FROM node_types WHERE node_id = ? AND schema_type = ?');
      matches = matches.filter(node => hasType.get(node.id, requiredType) !== undefined);
    }
    if (matches.length !== 1) return null;
    // A name that cannot sit inside [[...]] is no better a target than the text.
    if (/[[\]|#^]/.test(this.linkTarget(matches[0]))) return null;
    return matches[0];
  }

  /**
   * The link target that names `node` for every reader: its basename, unless
   * another note answers to that name too (a same-named file elsewhere, or a
   * title — the engine matches titles first), in which case its vault path
   * with `.md`, which both the engine's path tier and filename readers match
   * exactly.
   */
  linkTarget(node: LinkTargetNode): string {
    const name = basename(node.file_path, '.md');
    const holders = this.loadHolders().get(fold(name));
    return holders?.size === 1 && holders.has(node.id) ? name : node.file_path;
  }

  /** Every string a filename-based reader resolves: paths and basenames. */
  private loadFilenameRefs(): Set<string> {
    if (this.filenameRefs) return this.filenameRefs;
    const refs = new Set<string>();
    for (const node of this.nodes()) {
      refs.add(fold(stripMd(node.file_path)));
      refs.add(fold(basename(node.file_path, '.md')));
    }
    this.filenameRefs = refs;
    return refs;
  }

  /** Folded name → the notes a link with that text could reach, by any reader. */
  private loadHolders(): Map<string, Set<string>> {
    if (this.holders) return this.holders;
    const holders = new Map<string, Set<string>>();
    const add = (key: string, id: string) => {
      const set = holders.get(key);
      if (set) set.add(id);
      else holders.set(key, new Set([id]));
    };
    for (const node of this.nodes()) {
      add(fold(basename(node.file_path, '.md')), node.id);
      if (node.title !== null) add(fold(node.title), node.id);
    }
    this.holders = holders;
    return holders;
  }

  private loadCandidates(): Map<string, LinkTargetNode[]> {
    if (this.candidates) return this.candidates;
    const candidates = new Map<string, LinkTargetNode[]>();
    const add = (key: string, node: LinkTargetNode) => {
      const list = candidates.get(key);
      if (list) list.push(node);
      else candidates.set(key, [node]);
    };
    const aliases = this.options.aliases === false ? new Map<string, string[]>() : loadAliases(this.db);
    for (const node of this.nodes()) {
      if (node.title !== null) add(`title:${node.title}`, node);
      for (const key of nameKeys(node, aliases.get(node.id))) add(`key:${key}`, node);
    }
    this.candidates = candidates;
    return candidates;
  }

  private nodes(): LinkTargetNode[] {
    this.nodeRows ??= this.db.prepare('SELECT id, file_path, title FROM nodes').all() as LinkTargetNode[];
    return this.nodeRows;
  }
}
