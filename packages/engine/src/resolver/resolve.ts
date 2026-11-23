// Legacy, unconstrained target lookup. Structured relationships also store a
// derived resolved_target_id; typed field references use relationship-policy.ts
// to populate and refresh that binding. Graph readers use the stored binding.

import type Database from 'better-sqlite3';
import { basename } from 'node:path';

export interface ResolvedTarget {
  id: string;
  title: string | null;
}

/**
 * The note path a target names when it is written as a vault path without `.md`
 * (`Projects/Alpha` for `Projects/Alpha.md`), as Obsidian resolves it (#592); null for any
 * other target. A target with no folder is a bare name, which the title and basename tiers
 * handle, so it is not read as a path here.
 */
export function pathTargetWithMd(rawTarget: string): string | null {
  return rawTarget.includes('/') && !rawTarget.endsWith('.md') ? `${rawTarget}.md` : null;
}

/**
 * The note a link to a heading or block names (#613): `Alpha` for `Alpha#Intro` or
 * `Alpha#^block`, read up to the first `#` as Obsidian reads it. Null when the target has no
 * `#`, or nothing before it (`#Intro` is a heading in the same note). Resolvers try the whole
 * target first and this only when nothing matches it, so a note whose name holds a `#`
 * still matches by that name.
 */
export function anchoredLinkName(rawTarget: string): string | null {
  const hash = rawTarget.indexOf('#');
  if (hash < 0) return null;
  const name = rawTarget.slice(0, hash).trim();
  return name === '' ? null : name;
}

/** The `#…` part of an anchored target, which a rewrite carries over; '' when it has none. */
export function linkAnchor(rawTarget: string): string {
  return anchoredLinkName(rawTarget) === null ? '' : rawTarget.slice(rawTarget.indexOf('#'));
}

export function resolveTarget(db: Database.Database, rawTarget: string): ResolvedTarget | null {
  const whole = resolveWholeTarget(db, rawTarget);
  if (whole) return whole;
  const name = anchoredLinkName(rawTarget);
  return name === null ? null : resolveWholeTarget(db, name);
}

/** `resolveTarget` without the anchored-name fallback: what the whole text names, if anything. */
export function resolveWholeTarget(db: Database.Database, rawTarget: string): ResolvedTarget | null {
  // Tier 1: Exact file_path match, written with or without `.md`
  const byPath = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?');
  const exact = byPath.get(rawTarget) as ResolvedTarget | undefined;
  if (exact) return exact;
  const withMd = pathTargetWithMd(rawTarget);
  const exactWithMd = withMd !== null ? byPath.get(withMd) as ResolvedTarget | undefined : undefined;
  if (exactWithMd) return exactWithMd;

  // Tier 2: Exact title match
  const byTitle = db.prepare('SELECT id, file_path, title FROM nodes WHERE title = ?')
    .all(rawTarget) as { id: string; file_path: string; title: string | null }[];
  if (byTitle.length === 1) return { id: byTitle[0].id, title: byTitle[0].title };
  if (byTitle.length > 1) return pickShortest(byTitle);

  const allNodes = db.prepare('SELECT id, file_path, title FROM nodes')
    .all() as { id: string; file_path: string; title: string | null }[];

  const target = rawTarget.endsWith('.md') ? rawTarget.slice(0, -3) : rawTarget;

  // Tier 3: Exact basename match (strip directory and .md)
  const exactBasename = allNodes.filter(n => basename(n.file_path, '.md') === target);
  if (exactBasename.length === 1) return { id: exactBasename[0].id, title: exactBasename[0].title };
  if (exactBasename.length > 1) return pickShortest(exactBasename);

  // Tier 4: Case-insensitive basename match
  const targetLower = target.toLowerCase();
  const caseInsensitive = allNodes.filter(n => basename(n.file_path, '.md').toLowerCase() === targetLower);
  if (caseInsensitive.length === 1) return { id: caseInsensitive[0].id, title: caseInsensitive[0].title };
  if (caseInsensitive.length > 1) return pickShortest(caseInsensitive);

  // Tier 5: Unicode NFC-normalized case-insensitive basename match
  const targetNormalized = target.normalize('NFC').toLowerCase();
  const normalized = allNodes.filter(n =>
    basename(n.file_path, '.md').normalize('NFC').toLowerCase() === targetNormalized
  );
  if (normalized.length === 1) return { id: normalized[0].id, title: normalized[0].title };
  if (normalized.length > 1) return pickShortest(normalized);

  return null;
}

function pickShortest(
  candidates: { id: string; file_path: string; title: string | null }[],
): ResolvedTarget {
  const sorted = candidates.slice().sort((a, b) => a.file_path.length - b.file_path.length);
  return { id: sorted[0].id, title: sorted[0].title };
}

interface LookupRow { rowid: number; id: string; file_path: string; title: string | null }

/**
 * `resolveTarget` over in-memory maps, for callers that resolve many targets
 * against a nodes table that does not change meanwhile (the startup index's
 * link binding, the startup backfill). Each answer equals
 * `resolveTarget(db, target)`: same tiers, the same fallback to an anchored link's note name
 * (#613), and an ambiguous tier picks the
 * shortest path, ties going to the lower rowid, which is the order
 * resolveTarget's table scans return rows in.
 *
 * The maps load from `nodes` once, on first use.
 */
export class ResolutionLookup {
  private loaded = false;
  private readonly byPath = new Map<string, LookupRow>();
  private readonly byTitle = new Map<string, LookupRow[]>();
  private readonly byBase = new Map<string, LookupRow[]>();
  private readonly byBaseLower = new Map<string, LookupRow[]>();
  private readonly byBaseNfcLower = new Map<string, LookupRow[]>();

  constructor(private readonly db: Database.Database) {}

  resolve(rawTarget: string): ResolvedTarget | null {
    const whole = this.resolveWhole(rawTarget);
    if (whole) return whole;
    const name = anchoredLinkName(rawTarget);
    return name === null ? null : this.resolveWhole(name);
  }

  private resolveWhole(rawTarget: string): ResolvedTarget | null {
    this.load();
    const withMd = pathTargetWithMd(rawTarget);
    const exact = this.byPath.get(rawTarget) ?? (withMd !== null ? this.byPath.get(withMd) : undefined);
    if (exact) return { id: exact.id, title: exact.title };
    const target = rawTarget.endsWith('.md') ? rawTarget.slice(0, -3) : rawTarget;
    const found = pick(this.byTitle.get(rawTarget))
      ?? pick(this.byBase.get(target))
      ?? pick(this.byBaseLower.get(target.toLowerCase()))
      ?? pick(this.byBaseNfcLower.get(target.normalize('NFC').toLowerCase()));
    return found ? { id: found.id, title: found.title } : null;
  }

  private load(): void {
    if (this.loaded) return;
    for (const row of this.db.prepare('SELECT rowid, id, file_path, title FROM nodes').all() as LookupRow[]) {
      const base = basename(row.file_path, '.md');
      this.byPath.set(row.file_path, row);
      if (row.title !== null) push(this.byTitle, row.title, row);
      push(this.byBase, base, row);
      push(this.byBaseLower, base.toLowerCase(), row);
      push(this.byBaseNfcLower, base.normalize('NFC').toLowerCase(), row);
    }
    this.loaded = true;
  }
}

function push(map: Map<string, LookupRow[]>, key: string, row: LookupRow): void {
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

/** pickShortest over rows in any order: shortest path, then lowest rowid (scan order). */
function pick(list: LookupRow[] | undefined): LookupRow | null {
  if (!list || list.length === 0) return null;
  let best = list[0];
  for (const row of list) {
    if (row.file_path.length < best.file_path.length
      || (row.file_path.length === best.file_path.length && row.rowid < best.rowid)) best = row;
  }
  return best;
}
