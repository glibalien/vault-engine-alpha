import type Database from 'better-sqlite3';
import { linkKey } from '../resolver/near-miss.js';
import { getVaultSettings } from '../settings/vault.js';
import { EntityIndex, addSubjects, resolveSubjects, subjectName, subjectNames, type MemorySubject } from './subjects.js';
import { markChangedBy } from './service.js';

/**
 * The Curator's model pass over memories (#554, slice 2): the second half of the owner's "free
 * match, then model" (2026-11-20). The free match (`subject-backfill.ts`) gives a memory the notes
 * its text names in full; the model pass asks a model about the live memories it leaves with none
 * (a first name, a missed one-word company, someone with no note yet), and about the ones whose
 * only subjects are its own, for the names it missed there ("Dana Whitfield is the Acme account
 * lead" got Dana Whitfield and not Acme; owner, 2026-11-20). It adds; it never takes a subject away.
 *
 * The Curator lists them here with what the model needs to write names in full (the source note's
 * title, and the people, companies and projects that note is or links to), asks the model, and
 * writes its names back here. They resolve as any caller's names do (`resolveSubjects`: the
 * one-word rule for people, the owner left out), are marked `set_by: 'model'`, and are written
 * only to a memory that is still live and still has no subjects but the free match's, and only
 * where a name is not one it has already. `clearModelSubjects` takes one
 * write back out, by memory id and the time it was written, which is the run's undo.
 */

export const SUBJECT_PASS_LIMITS = {
  /** Memories one listing returns by default, and at most. */
  page: 100,
  maxPage: 500,
  /** Names of the source note's entities sent with a memory. */
  sourceNames: 40,
  /** Memories one write or clear takes. */
  maxItems: 200,
} as const;

/** A memory the model pass asks about. */
export interface SubjectPassMemory {
  id: number;
  content: string;
  category: string | null;
  /** The title of the note it was drawn from; null for a chat, or a note since deleted. */
  source_title: string | null;
  /** The people, companies and projects its source note is or links to, by title (the owner left out): names to write in full. */
  source_names: string[];
  /** The subjects it has, as named: the free match's, the only ones a memory in scope can have. */
  subjects: string[];
}

/** A memory the pass may add to: live, with no subject but the free match's (`set_by: 'match'`). */
const IN_SCOPE = `m.expired_at IS NULL AND m.superseded_by IS NULL
  AND NOT EXISTS (SELECT 1 FROM memory_subjects s WHERE s.memory_id = m.id AND s.set_by <> 'match')`;

/**
 * The live memories with no subjects but the free match's, in id order, after `afterId`: what the
 * model pass asks about. `total` counts every such memory after `afterId`, beyond this page too.
 */
export function listSubjectPassMemories(
  db: Database.Database, opts: { afterId?: number | undefined; limit?: number | undefined } = {},
): { memories: SubjectPassMemory[]; total: number; next_after_id: number | null } {
  const afterId = opts.afterId ?? 0;
  const limit = Math.min(opts.limit ?? SUBJECT_PASS_LIMITS.page, SUBJECT_PASS_LIMITS.maxPage);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM memories m WHERE ${IN_SCOPE} AND m.id > ?`).get(afterId) as { total: number };
  const rows = db.prepare(
    `SELECT m.id, m.content, m.category, m.evidence_node_id, n.title AS source_title
       FROM memories m LEFT JOIN nodes n ON n.id = m.evidence_node_id
      WHERE ${IN_SCOPE} AND m.id > ? ORDER BY m.id LIMIT ?`,
  ).all(afterId, limit + 1) as Array<{ id: number; content: string; category: string | null; evidence_node_id: string | null; source_title: string | null }>;
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const index = EntityIndex.build(db);
  const linked = db.prepare<[string], { id: string }>(
    'SELECT DISTINCT resolved_target_id AS id FROM relationships WHERE source_id = ? AND resolved_target_id IS NOT NULL ORDER BY rowid',
  );
  const namesOf = new Map<string, string[]>();
  const sourceNames = (sourceId: string | null): string[] => {
    if (sourceId === null) return [];
    let names = namesOf.get(sourceId);
    if (names !== undefined) return names;
    const ids = [sourceId, ...linked.all(sourceId).map(row => row.id)];
    names = [...new Set(ids.filter(id => index.isEntity(id) && !index.isOwner(id)).map(id => index.title(id)!))]
      .slice(0, SUBJECT_PASS_LIMITS.sourceNames);
    namesOf.set(sourceId, names);
    return names;
  };
  return {
    memories: page.map(row => ({
      id: row.id,
      content: row.content,
      category: row.category,
      source_title: row.source_title,
      source_names: sourceNames(row.evidence_node_id),
      subjects: subjectNames(db, row.id),
    })),
    total,
    next_after_id: more ? page[page.length - 1]!.id : null,
  };
}

/** What became of one memory's names. */
export interface SubjectPassResult {
  memory_id: number;
  /**
   * `written` (or would be, in a dry run): `subjects` are the names added; `none`: no name was
   * left to add (none given, only the owner's, or only names it has already); `has_subjects`,
   * `not_live`, `not_found`: the memory gained subjects other than the free match's, was retired or
   * went away since it was listed, and nothing was written.
   */
  outcome: 'written' | 'none' | 'has_subjects' | 'not_live' | 'not_found';
  subjects: Array<{ name: string; status: MemorySubject['status']; title: string | null; held?: true }>;
  /** For `written`: when, the `created_at` of its rows. With the memory id it names this write, for `clearModelSubjects`. */
  written_at?: string;
}

/** The owner's own names a model may write: the vault map's `ownerNote`, and its first word alone. */
function ownerKeys(db: Database.Database): Set<string> {
  const keys = new Set<string>();
  const title = subjectName(getVaultSettings(db).ownerNote ?? '');
  if (title === '') return keys;
  keys.add(linkKey(title));
  const first = title.split(/\s+/)[0];
  if (first) keys.add(linkKey(first));
  return keys;
}

/**
 * Add the model's names to memories that still have no subjects but the free match's. Each resolves
 * as `resolveSubjects` reads it with the memory's source note, and is stored `set_by: 'model'`
 * where the memory has no subject of that name or note yet. A name the owner's note
 * answers to is left out there; here so is the owner's first name alone or their title given as a
 * name no note answers to, which `resolveSubjects` would otherwise keep as an unmatched name.
 */
export function writeModelSubjects(
  db: Database.Database, items: ReadonlyArray<{ memory_id: number; subjects: readonly string[] }>,
  opts: { dryRun: boolean; changedBy?: string | undefined },
): { results: SubjectPassResult[]; memories: number; subjects: number } {
  const index = EntityIndex.build(db);
  const owner = ownerKeys(db);
  const memory = db.prepare<[number], { expired_at: string | null; superseded_by: number | null; evidence_node_id: string | null }>(
    'SELECT expired_at, superseded_by, evidence_node_id FROM memories WHERE id = ?',
  );
  const setOtherwise = db.prepare<[number], { one: number }>("SELECT 1 AS one FROM memory_subjects WHERE memory_id = ? AND set_by <> 'match' LIMIT 1");
  const existing = db.prepare<[number], { name_key: string; node_id: string | null }>('SELECT name_key, node_id FROM memory_subjects WHERE memory_id = ?');
  const now = new Date().toISOString();
  const results: SubjectPassResult[] = [];
  let memories = 0;
  let subjects = 0;
  db.transaction(() => {
    for (const item of items) {
      const row = memory.get(item.memory_id);
      const result = (outcome: SubjectPassResult['outcome'], shown: SubjectPassResult['subjects'] = []): void => {
        results.push({ memory_id: item.memory_id, outcome, subjects: shown, ...(outcome === 'written' ? { written_at: now } : {}) });
      };
      if (row === undefined) { result('not_found'); continue; }
      if (row.expired_at !== null || row.superseded_by !== null) { result('not_live'); continue; }
      if (setOtherwise.get(item.memory_id) !== undefined) { result('has_subjects'); continue; }
      const names = item.subjects.filter(name => !owner.has(linkKey(subjectName(name))));
      // Only what the memory has not got: the free match's subjects stay, and are not named twice.
      const had = existing.all(item.memory_id);
      const keys = new Set(had.map(subject => subject.name_key));
      const nodes = new Set(had.flatMap(subject => (subject.node_id === null ? [] : [subject.node_id])));
      const resolved = resolveSubjects(db, index, names, { setBy: 'model', evidenceNodeId: row.evidence_node_id })
        .filter(subject => !keys.has(subject.name_key) && (subject.node_id === null || !nodes.has(subject.node_id)));
      if (resolved.length === 0) { result('none'); continue; }
      const added = opts.dryRun ? resolved.length : addSubjects(db, item.memory_id, resolved, 'model', now);
      if (!opts.dryRun && added > 0 && opts.changedBy !== undefined) markChangedBy(db, item.memory_id, opts.changedBy);
      memories++;
      subjects += added;
      result('written', resolved.map(subject => ({
        name: subject.name,
        status: subject.status,
        title: subject.node_id === null ? null : (index.title(subject.node_id) ?? null),
        ...(subject.held ? { held: true as const } : {}),
      })));
    }
    // A dry run writes nothing: the transaction only reads.
  })();
  return { results, memories, subjects };
}

/**
 * Take back out the subjects of these writes: each memory's `set_by: 'model'` rows written at
 * that time (`written_at` from `writeModelSubjects`), a run's undo. Subjects set any other way,
 * and a later write's (the owner removed this run's, and another run gave the memory new ones;
 * Codex, #695), stay. Returns the memories that had any left, and how many went.
 */
export function clearModelSubjects(
  db: Database.Database, writes: ReadonlyArray<{ memory_id: number; written_at: string }>,
  opts: { dryRun: boolean; changedBy?: string | undefined },
): { cleared: number[]; subjects: number } {
  const count = db.prepare<[number, string], { n: number }>(
    "SELECT COUNT(*) AS n FROM memory_subjects WHERE memory_id = ? AND set_by = 'model' AND created_at = ?",
  );
  const remove = db.prepare<[number, string]>("DELETE FROM memory_subjects WHERE memory_id = ? AND set_by = 'model' AND created_at = ?");
  const touch = db.prepare<[string, number, string]>('UPDATE memories SET updated_at = ? WHERE id = ? AND updated_at < ?');
  const now = new Date().toISOString();
  const cleared: number[] = [];
  let subjects = 0;
  db.transaction(() => {
    const seen = new Set<string>();
    for (const { memory_id: id, written_at: at } of writes) {
      if (seen.has(`${id}@${at}`)) continue;
      seen.add(`${id}@${at}`);
      const { n } = count.get(id, at)!;
      if (n === 0) continue;
      cleared.push(id);
      subjects += n;
      if (opts.dryRun) continue;
      remove.run(id, at);
      // Each memory's revision moves, as for any subject change.
      touch.run(now, id, now);
      if (opts.changedBy !== undefined) markChangedBy(db, id, opts.changedBy);
    }
  })();
  return { cleared, subjects };
}
