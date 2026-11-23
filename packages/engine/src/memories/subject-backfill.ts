import type Database from 'better-sqlite3';
import { linkKey } from '../resolver/near-miss.js';
import { EntityIndex, addSubjects, isOneWord, sourceLinks, type ResolvedSubject } from './subjects.js';

/**
 * Subjects for memories written before they had any (#554, slice 2), with no model: the free
 * half of the owner's choice (2026-11-20, "free match, then model"). A model pass in the Curator
 * reads only the memories this leaves without subjects.
 *
 * A memory with no subjects gets:
 * - each note of an entity kind whose title or alias appears in its text, as whole words. A name
 *   several notes answer to is skipped. A one-word name counts only when the memory's source note
 *   is that note or links to it, whatever the kind: words in a text are not a writer's choice of
 *   subject, and "Apple Watch" must not make a memory about an Apple note.
 * - its source note, when that is a note of an entity kind: a memory drawn from a person's note
 *   is about that person.
 * The vault owner's note (`ownerNote`) is never one. Memories that have any subject are left as
 * they are, and what this writes is marked `set_by: 'match'`, so `clearMatchedSubjects` can take
 * it all back out.
 */

/** A memory's text as words, each without the punctuation around it or a possessive `'s`. */
function words(text: string): string[] {
  return text.split(/\s+/).flatMap(raw => {
    // Punctuation first, then a possessive, then what the possessive stood before ("Whitfield's." ; Codex, #693).
    const word = raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').replace(/[’']s$/iu, '').replace(/[^\p{L}\p{N}]+$/u, '');
    return word === '' ? [] : [word];
  });
}

/** A run of words as a key: names and texts are both read through `words`, so their punctuation
 *  is dropped alike ("Acme Inc." in a title and in a sentence; Codex, #693). */
function textKey(text: string): string {
  return linkKey(words(text).join(' '));
}

/**
 * The entity notes by the names a text can hold: titles, then aliases, each normalized as a text
 * is (no vault paths: a root-level note's path key is its title's, and a sentence names notes by
 * title, Codex #693). A name two notes answer to in a tier is ambiguous there.
 */
class TextNames {
  private readonly byTitle = new Map<string, Set<string>>();
  private readonly byAlias = new Map<string, Set<string>>();
  readonly firstWords = new Set<string>();
  longest = 1;

  constructor(index: EntityIndex) {
    for (const entry of index.nameEntries()) {
      const key = textKey(entry.name);
      if (key === '') continue;
      const map = entry.tier === 'title' ? this.byTitle : this.byAlias;
      let ids = map.get(key);
      if (!ids) map.set(key, ids = new Set());
      ids.add(entry.id);
      this.firstWords.add(key.split(' ')[0]!);
      this.longest = Math.max(this.longest, key.split(' ').length);
    }
    this.longest = Math.min(this.longest, 8);
  }

  /** The note a run of words names: a title first, then an alias; null for several. */
  resolve(key: string): { node_id: string | null } | undefined {
    for (const map of [this.byTitle, this.byAlias]) {
      const ids = map.get(key);
      if (!ids || ids.size === 0) continue;
      return { node_id: ids.size === 1 ? [...ids][0]! : null };
    }
    return undefined;
  }
}

interface Matched { node_id: string; title: string }

/** The notes a memory's text names, longest name first at each word, each note once. */
function namedIn(index: EntityIndex, names: TextNames, text: string, allowOneWord: (nodeId: string) => boolean): Matched[] {
  const list = words(text);
  const keys = list.map(word => linkKey(word));
  const found = new Map<string, Matched>();
  let i = 0;
  while (i < list.length) {
    let step = 1;
    if (names.firstWords.has(keys[i]!)) {
      for (let n = Math.min(names.longest, list.length - i); n >= 1; n--) {
        const key = linkKey(list.slice(i, i + n).join(' '));
        const resolved = names.resolve(key);
        if (resolved === undefined) continue;
        // Several notes answer to it: no subject, and the words are spent.
        if (resolved.node_id === null) { step = n; break; }
        if (isOneWord(key) && !allowOneWord(resolved.node_id)) continue;
        if (!found.has(resolved.node_id)) found.set(resolved.node_id, { node_id: resolved.node_id, title: index.title(resolved.node_id) ?? key });
        step = n;
        break;
      }
    }
    i += step;
  }
  return [...found.values()];
}

/**
 * The name each found note is stored under: its title, or its vault path (without `.md`) where
 * another found note has the same title, so the two keep their own subject rows (Codex, #693).
 */
function storedNames(index: EntityIndex, found: readonly Matched[]): ResolvedSubject[] {
  const titleCounts = new Map<string, number>();
  for (const hit of found) titleCounts.set(linkKey(hit.title), (titleCounts.get(linkKey(hit.title)) ?? 0) + 1);
  return found.map(hit => {
    const shared = (titleCounts.get(linkKey(hit.title)) ?? 0) > 1;
    const name = shared ? (index.path(hit.node_id) ?? hit.title).replace(/\.md$/, '') : hit.title;
    return { name, name_key: linkKey(name), node_id: hit.node_id, status: 'linked' as const };
  });
}

/** The subjects the free match gives one memory: its source note when that is a note of an entity
 *  kind, and the entity notes its text names; never the owner's note. */
function matchedSubjects(db: Database.Database, index: EntityIndex, names: TextNames,
  memory: { readonly content: string; readonly evidence_node_id: string | null }): ResolvedSubject[] {
  const found = new Map<string, Matched>();
  const source = memory.evidence_node_id;
  if (source !== null && index.isEntity(source) && !index.isOwner(source)) found.set(source, { node_id: source, title: index.title(source)! });
  for (const hit of namedIn(index, names, memory.content, nodeId => sourceLinks(db, source, nodeId))) {
    if (!index.isOwner(hit.node_id) && !found.has(hit.node_id)) found.set(hit.node_id, hit);
  }
  return found.size === 0 ? [] : storedNames(index, [...found.values()]);
}

/**
 * The free match for one memory just written with no subjects (#738): chat, wiki builds and the
 * memory note's new blocks name none, and the backfill above runs only when someone starts it, so
 * their memories stayed out of every subject set. The same rules, written `set_by: 'match'`;
 * nothing when the memory has any subject. Returns how many it added.
 */
export function matchNewMemorySubjects(db: Database.Database, memoryId: number, now = new Date().toISOString()): number {
  const memory = db.prepare(
    `SELECT id, content, evidence_node_id FROM memories m
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memory_subjects s WHERE s.memory_id = m.id)`,
  ).get(memoryId) as { id: number; content: string; evidence_node_id: string | null } | undefined;
  if (!memory) return 0;
  const index = EntityIndex.build(db);
  const subjects = matchedSubjects(db, index, new TextNames(index), memory);
  return subjects.length === 0 ? 0 : addSubjects(db, memoryId, subjects, 'match', now);
}

export interface SubjectBackfillResult {
  dry_run: boolean;
  /** Memories with no subjects, the ones read. */
  memories_read: number;
  /** Of those, the ones that get subjects. */
  memories_matched: number;
  /** Subjects added, over all of them. */
  subjects: number;
  /** The notes the most memories get as a subject, most first. */
  top_notes: Array<{ node_id: string; title: string; memories: number }>;
  /** A few of the memories and what they get. */
  samples: Array<{ memory_id: number; content: string; subjects: string[] }>;
}

/** Find, and unless `dryRun` write, subjects for every memory that has none. */
export function backfillMemorySubjects(
  db: Database.Database,
  opts: { dryRun: boolean; samples?: number; /** The chat client running it, marked on each memory it changes (#532). */ changedBy?: string | undefined },
): SubjectBackfillResult {
  const index = EntityIndex.build(db);
  const names = new TextNames(index);
  const memories = db.prepare(
    `SELECT id, content, evidence_node_id FROM memories m
      WHERE NOT EXISTS (SELECT 1 FROM memory_subjects s WHERE s.memory_id = m.id) ORDER BY id`,
  ).all() as Array<{ id: number; content: string; evidence_node_id: string | null }>;

  const now = new Date().toISOString();
  const perNote = new Map<string, number>();
  const samples: SubjectBackfillResult['samples'] = [];
  const wanted = opts.samples ?? 10;
  let matched = 0;
  let subjects = 0;
  const plans: Array<{ id: number; subjects: ResolvedSubject[] }> = [];
  for (const memory of memories) {
    const stored = matchedSubjects(db, index, names, memory);
    if (stored.length === 0) continue;
    matched++;
    subjects += stored.length;
    for (const hit of stored) perNote.set(hit.node_id!, (perNote.get(hit.node_id!) ?? 0) + 1);
    if (samples.length < wanted) {
      const content = memory.content.length > 200 ? `${memory.content.slice(0, 199)}…` : memory.content;
      samples.push({ memory_id: memory.id, content, subjects: stored.map(subject => subject.name) });
    }
    plans.push({ id: memory.id, subjects: stored });
  }
  if (!opts.dryRun) {
    db.transaction(() => {
      for (const plan of plans) {
        if (addSubjects(db, plan.id, plan.subjects, 'match', now) > 0 && opts.changedBy !== undefined) {
          db.prepare('UPDATE memories SET changed_by = ? WHERE id = ?').run(opts.changedBy, plan.id);
        }
      }
    })();
  }
  const top = [...perNote.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15);
  return {
    dry_run: opts.dryRun,
    memories_read: memories.length,
    memories_matched: matched,
    subjects,
    top_notes: top.map(([nodeId, count]) => ({ node_id: nodeId, title: index.title(nodeId) ?? nodeId, memories: count })),
    samples,
  };
}

/** Take back out every subject the backfill wrote (`set_by: 'match'`), and say how many. */
export function clearMatchedSubjects(
  db: Database.Database,
  opts: { dryRun: boolean; /** The chat client running it, marked on each memory it changes (#532). */ changedBy?: string | undefined },
): { dry_run: boolean; memories: number; subjects: number } {
  const counts = db.prepare(
    "SELECT COUNT(DISTINCT memory_id) AS memories, COUNT(*) AS subjects FROM memory_subjects WHERE set_by = 'match'",
  ).get() as { memories: number; subjects: number };
  if (!opts.dryRun && counts.subjects > 0) {
    const now = new Date().toISOString();
    db.transaction(() => {
      // Each memory's revision moves, as for any subject change.
      db.prepare(`UPDATE memories SET updated_at = ? WHERE updated_at < ?
        AND id IN (SELECT memory_id FROM memory_subjects WHERE set_by = 'match')`).run(now, now);
      if (opts.changedBy !== undefined) {
        db.prepare("UPDATE memories SET changed_by = ? WHERE id IN (SELECT memory_id FROM memory_subjects WHERE set_by = 'match')").run(opts.changedBy);
      }
      db.prepare("DELETE FROM memory_subjects WHERE set_by = 'match'").run();
    })();
  }
  return { dry_run: opts.dryRun, ...counts };
}
