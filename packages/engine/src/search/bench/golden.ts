// packages/engine/src/search/bench/golden.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type Database from 'better-sqlite3';

export type ConceptualGroup = 'precision' | 'topical' | 'attachment_noise' | 'field_recall' | 'canonical';

export interface GoldenCase {
  query: string;
  expectedIds: string[];
  kind: 'known-item' | 'conceptual';
  topK: number;
  flags: string[];
  note?: string;
  group?: ConceptualGroup;
}

const SHORT_TITLE_MAX = 3;

interface TitleRow {
  id: string;
  title: string;
}

export type UnresolvedConceptualTarget = {
  readonly query: string;
  readonly title: string;
};

export class UnresolvedConceptualTargetsError extends Error {
  readonly name = 'UnresolvedConceptualTargetsError';

  constructor(readonly targets: readonly UnresolvedConceptualTarget[]) {
    super(`Conceptual benchmark has ${targets.length} unresolved expected title(s)`);
  }
}

/**
 * One rank-1 case per distinct (case-insensitive) node title. Collisions merge
 * into a single case that accepts any colliding node within top-K. Person/entity
 * names ARE titles, so this covers the "Zora Wren" class directly. Optional
 * aliasFields adds extra queries from list/text fields (no-op if none present).
 */
export function generateKnownItem(db: Database.Database, opts: { aliasFields?: string[] } = {}): GoldenCase[] {
  const rows = db
    .prepare("SELECT id, title FROM nodes WHERE title IS NOT NULL AND TRIM(title) <> ''")
    .all() as TitleRow[];

  const byKey = new Map<string, { title: string; ids: string[] }>();
  for (const r of rows) {
    const title = r.title.trim();
    const key = title.toLowerCase();
    const entry = byKey.get(key);
    if (entry) entry.ids.push(r.id);
    else byKey.set(key, { title, ids: [r.id] });
  }

  const cases: GoldenCase[] = [];
  for (const { title, ids } of byKey.values()) {
    const flags: string[] = [];
    if (ids.length > 1) flags.push('collision');
    if (title.length <= SHORT_TITLE_MAX) flags.push('short-title');
    cases.push({ query: title, expectedIds: ids.slice(), kind: 'known-item', topK: ids.length, flags });
  }

  for (const field of opts.aliasFields ?? []) {
    const fieldRows = db
      .prepare('SELECT node_id, value_text, value_json FROM node_fields WHERE field_name = ?')
      .all(field) as { node_id: string; value_text: string | null; value_json: string | null }[];
    for (const fr of fieldRows) {
      const aliases = aliasValues(fr.value_text, fr.value_json);
      for (const alias of aliases) {
        cases.push({ query: alias, expectedIds: [fr.node_id], kind: 'known-item', topK: 1, flags: ['alias'] });
      }
    }
  }

  return cases;
}

function aliasValues(valueText: string | null, valueJson: string | null): string[] {
  const out: string[] = [];
  if (valueJson) {
    try {
      const parsed = JSON.parse(valueJson);
      if (Array.isArray(parsed)) out.push(...parsed.filter((x): x is string => typeof x === 'string'));
    } catch {
      /* ignore malformed json */
    }
  }
  if (valueText && valueText.trim()) out.push(valueText.trim());
  return out.map((s) => s.trim()).filter(Boolean);
}

interface RawConceptual {
  query: string;
  expected_titles: string[];
  note?: string;
  group?: ConceptualGroup;
}

/**
 * The conceptual cases file in a bench directory. The cases name notes by title, so they
 * only resolve against the vault they were written for: an untracked
 * `golden-conceptual.local.yaml` beside the tracked file wins when it exists.
 */
export function conceptualGoldenPath(benchDir: string): string {
  const local = join(benchDir, 'golden-conceptual.local.yaml');
  return existsSync(local) ? local : join(benchDir, 'golden-conceptual.yaml');
}

export function loadConceptual(
  db: Database.Database,
  yamlPath: string,
): GoldenCase[] {
  const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as { cases?: RawConceptual[] } | null;
  const raw = doc?.cases ?? [];

  const titleToIds = new Map<string, string[]>();
  for (const r of db.prepare("SELECT id, title FROM nodes WHERE title IS NOT NULL AND TRIM(title) <> ''").all() as TitleRow[]) {
    const key = r.title.trim().toLowerCase();
    const entry = titleToIds.get(key);
    if (entry) entry.push(r.id);
    else titleToIds.set(key, [r.id]);
  }

  const cases: GoldenCase[] = [];
  const unresolved: UnresolvedConceptualTarget[] = [];
  for (const rc of raw) {
    const expectedIds: string[] = [];
    for (const t of rc.expected_titles) {
      const ids = titleToIds.get(t.trim().toLowerCase());
      if (ids && ids.length > 0) expectedIds.push(...ids);
      else unresolved.push({ query: rc.query, title: t });
    }
    cases.push({ query: rc.query, expectedIds, kind: 'conceptual', topK: 10, flags: [], note: rc.note, group: rc.group });
  }
  if (unresolved.length > 0) throw new UnresolvedConceptualTargetsError(unresolved);
  return cases;
}
