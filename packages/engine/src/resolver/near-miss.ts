// Near-miss detection for unresolved references (2026-06-12 triage).
//
// The resolver (resolve.ts) is deliberately exact: file_path → title →
// basename → case-folded → NFC. It never guesses. But four real damage
// classes produce unresolved edges whose targets are one mechanical
// transform away from an existing note:
//   1. filename-illegal characters — links written with a display title
//      ("A / B", "A -> B", "A: B") while the file was created with the
//      sanitized name ("A - B");
//   2. unicode whitespace variants (U+202F narrow no-break space, U+00A0)
//      pasted into link text;
//   3. exact-match stragglers awaiting the startup backfill;
//   4. a bare `[[alias]]` — a note's `aliases`/`alias` value written as the
//      link target. Obsidian offers aliases in autocomplete but writes
//      `[[file|alias]]`; a bare `[[alias]]` resolves for no reader, Obsidian
//      included (clicking it creates a new note named after the alias).
// This module finds them for reporting (vault-doctor) and repair tooling.
// It never mutates: matching here is heuristic, so fixes flow through the
// normal mutation pipeline against the raw link text, not the resolver.

import { basename } from 'node:path';
import type Database from 'better-sqlite3';

/**
 * Canonical key for "would this link text and that note name be the same
 * after filename sanitization?". Maps `->` and filename-illegal characters
 * to dashes, canonicalizes all unicode whitespace and dash spacing,
 * NFC-normalizes, and case-folds.
 */
export function normalizeRefKey(s: string): string {
  return s
    .normalize('NFC')
    .replace(/->/g, '-')
    .replace(/[/\\<>:|?*"]/g, '-')
    .replace(/\s+/g, ' ') // \s covers U+202F, U+00A0, etc.
    .replace(/\s*-\s*/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .toLowerCase();
}

const stripMd = (s: string) => s.endsWith('.md') ? s.slice(0, -3) : s;

/** The near-miss key a link target is matched by; a `.md` suffix is dropped, as every resolver drops it. */
export function linkKey(target: string): string {
  return normalizeRefKey(stripMd(target));
}

/**
 * The keys to look `target` up by in a `nameKeys` index: its names', and its
 * aliases' unless the target has a file extension — `![[report.pdf]]` names
 * an attachment for every reader, so a note's alias never captures it.
 */
export function targetKeys(target: string): string[] {
  const key = linkKey(target);
  if (key === '') return [];
  return /\.[A-Za-z0-9]+$/.test(stripMd(target).trim()) ? [key] : [key, `alias:${key}`];
}

/** `aliases`/`alias` frontmatter values, keyed by the declaring node's id — only `nodeId`'s when given. */
export function loadAliases(db: Database.Database, nodeId?: string): Map<string, string[]> {
  const rows = db.prepare(
    `SELECT node_id, value_text, value_json FROM node_fields
      WHERE field_name IN ('aliases', 'alias')${nodeId === undefined ? '' : ' AND node_id = ?'}`
  ).all(...(nodeId === undefined ? [] : [nodeId])) as Array<{ node_id: string; value_text: string | null; value_json: string | null }>;
  const aliases = new Map<string, string[]>();
  for (const row of rows) {
    const list = aliases.get(row.node_id) ?? [];
    if (row.value_text) list.push(row.value_text);
    if (row.value_json) {
      try {
        const parsed: unknown = JSON.parse(row.value_json);
        for (const alias of Array.isArray(parsed) ? parsed : [parsed]) {
          // An empty `- ` item parses to null: no alias, not one named "null".
          if (typeof alias === 'string' || typeof alias === 'number') list.push(String(alias));
        }
      } catch {
        // A non-JSON alias value is simply not an alias we can honour.
      }
    }
    aliases.set(row.node_id, list);
  }
  return aliases;
}

/**
 * The near-miss keys a link may mean `node` by: its basename and title, and
 * its aliases as `alias:` keys (`normalizeRefKey` never leaves a `:`). Look a
 * link up with `targetKeys`.
 */
export function nameKeys(node: { file_path: string; title: string | null }, aliases: readonly string[] = []): Set<string> {
  const keys = new Set([normalizeRefKey(basename(node.file_path, '.md'))]);
  if (node.title !== null) keys.add(normalizeRefKey(node.title));
  keys.delete('');
  for (const alias of aliases) {
    const key = linkKey(alias);
    if (key !== '') keys.add(`alias:${key}`);
  }
  return keys;
}

export interface NearMissGroup {
  target: string;
  edge_count: number;
  matches: Array<{ id: string; file_path: string }>;
}

/**
 * Groups NULL-resolved relationships by raw target and reports every group
 * whose normalized target key matches an existing node (by basename, title
 * or alias). Ordered by edge_count descending. O(nodes + unresolved rows).
 */
export function findNearMissTargets(db: Database.Database): NearMissGroup[] {
  const unresolved = db
    .prepare(
      'SELECT target, COUNT(*) AS n FROM relationships WHERE resolved_target_id IS NULL GROUP BY target'
    )
    .all() as Array<{ target: string; n: number }>;
  if (unresolved.length === 0) return [];

  type NodeRow = { id: string; file_path: string; title: string | null };
  const nodes = db.prepare('SELECT id, file_path, title FROM nodes').all() as NodeRow[];
  const aliases = loadAliases(db);
  const byKey = new Map<string, Array<{ id: string; file_path: string }>>();
  for (const n of nodes) {
    for (const key of nameKeys(n, aliases.get(n.id))) {
      const list = byKey.get(key);
      const entry = { id: n.id, file_path: n.file_path };
      if (list) list.push(entry);
      else byKey.set(key, [entry]);
    }
  }

  const groups: NearMissGroup[] = [];
  for (const row of unresolved) {
    const matches = new Map<string, { id: string; file_path: string }>();
    for (const key of targetKeys(row.target)) {
      for (const match of byKey.get(key) ?? []) matches.set(match.id, match);
    }
    if (matches.size > 0) {
      groups.push({ target: row.target, edge_count: row.n, matches: [...matches.values()] });
    }
  }
  groups.sort((a, b) => b.edge_count - a.edge_count);
  return groups;
}

/**
 * Notes holding an unresolved link that names `nodeId` up to near-miss
 * normalization — links written before the note existed under its filename
 * (`[[Ping Tomas on vendor/onboarding status]]` ahead of `... vendor-onboarding
 * status.md`) or as one of its aliases, including the note's own links to
 * itself, which its first write could not canonicalize. The write pipeline
 * re-saves these with link canonicalization.
 */
export function nearMissLinkSources(db: Database.Database, nodeId: string): string[] {
  const node = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(nodeId) as
    | { file_path: string; title: string | null }
    | undefined;
  if (!node) return [];
  const keys = nameKeys(node, loadAliases(db, nodeId).get(nodeId));

  const rows = db.prepare(
    'SELECT DISTINCT source_id, target FROM relationships WHERE resolved_target_id IS NULL'
  ).all() as Array<{ source_id: string; target: string }>;
  const sources = new Set<string>();
  for (const row of rows) {
    if (targetKeys(row.target).some(key => keys.has(key))) sources.add(row.source_id);
  }
  return [...sources];
}
