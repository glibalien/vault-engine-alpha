import type Database from 'better-sqlite3';
import { linkKey, loadAliases } from '../resolver/near-miss.js';
import { entityKinds, type VaultSettings } from '@vault/settings-registry';
import { getVaultSettings } from '../settings/vault.js';

/**
 * What a memory is about (#554): its subjects, links from the memory to notes of the vault map's
 * entity kinds (`entityKinds`: its `entityTypes` list, else its person, company and project kinds).
 *
 * Owner's decisions (2026-11-20):
 * - A name no note answers to is kept on the memory, unresolved, and is matched once a note of
 *   an entity kind answers to it. Nothing is created for it.
 * - A name several notes answer to is ambiguous: it links to none of them until the owner names
 *   one (by its title or path), never guessed.
 * - A one-word name ("Dana") links to a person note by its title or alias only when the memory's
 *   source note is that note or links to it, whenever it is matched: an old memory about another
 *   Dana must not join a Dana note created later. People only (the vault map's `personType`):
 *   a one-word company or project name ("Acme") almost always means the one the vault has, and
 *   holding it back would keep chat memories out of its set. A path, a note id, and a name the
 *   owner typed in the memory note are not held to this: they are the owner's or caller's own
 *   link. (Slice 2's sweeps are to write full names.)
 *
 * A name is matched by tiers, as a link would be read, the first tier with a match deciding:
 * the note's vault path, its title (the file name), then its aliases. One match links it; two
 * or more in that tier make it ambiguous. A subject linked when it was set keeps its note
 * through renames; one whose note was deleted is read by its name again.
 */

/** How a subject was set: by an MCP caller, by the owner editing the memory note, by the
 *  subject backfill matching names in the memory's text (`subject-backfill.ts`), or by the
 *  Curator's model pass over what the backfill left (`subject-pass.ts`). */
export type SubjectSetBy = 'tool' | 'owner' | 'match' | 'model';

/** A memory's subject as callers see it. */
export interface MemorySubject {
  /** The name as given. */
  name: string;
  /** The note it is about: the note it was linked to, or the one entity note answering to the name now. */
  node_id: string | null;
  /** That note's title. */
  title: string | null;
  /** `linked`: about that note; `unresolved`: no entity note answers to the name yet;
   *  `ambiguous`: several do, and none is picked. */
  status: 'linked' | 'unresolved' | 'ambiguous';
  set_by: SubjectSetBy;
}

/** A subject ready to store: its name, key, and the note it resolved to when it was set. */
export interface ResolvedSubject {
  name: string;
  name_key: string;
  node_id: string | null;
  status: MemorySubject['status'];
  /** A one-word name a note answers to, left unlinked because the memory's source note does not link that note. */
  held?: boolean;
}

/** The tier a name matched in. */
type Tier = 'path' | 'title' | 'alias';

/** A name of one word: its key has no space. */
export function isOneWord(nameKey: string): boolean {
  return !nameKey.includes(' ');
}

/** Whether a name matched in `tier` needs the memory's source note to link the note (the one-word
 *  rule): a one-word name a person note answers to by title or alias, not set by the owner. */
function needsSourceLink(nameKey: string, tier: Tier | null, setBy: string, person: boolean): boolean {
  return person && setBy !== 'owner' && (tier === 'title' || tier === 'alias') && isOneWord(nameKey);
}

/** Whether the memory's source note is the note, or links to it from a field or its text. */
export function sourceLinks(db: Database.Database, evidenceNodeId: string | null | undefined, nodeId: string): boolean {
  if (!evidenceNodeId) return false;
  if (evidenceNodeId === nodeId) return true;
  return db.prepare('SELECT 1 FROM relationships WHERE source_id = ? AND resolved_target_id = ? LIMIT 1').get(evidenceNodeId, nodeId) !== undefined;
}

interface SubjectRow {
  memory_id: number;
  name: string;
  name_key: string;
  node_id: string | null;
  set_by: string;
}

/** The most subjects one memory may be given in one call. */
export const MAX_SUBJECTS = 20;

/**
 * The name a caller means: a link's target (without `[[ ]]`, display text or heading), or the
 * text as written, trimmed.
 */
export function subjectName(input: string): string {
  const text = input.trim();
  const link = /^!?\[\[([^\]]*)\]\]$/.exec(text);
  if (!link) return text;
  const target = link[1]!.split('|')[0]!;
  const hash = target.indexOf('#');
  return (hash > 0 ? target.slice(0, hash) : target).trim();
}

const pathKey = (filePath: string): string => linkKey(filePath);

/**
 * The notes of the entity kinds, by the keys a name can match. Built once per call that needs
 * it, from the vault map's `entityTypes` at that moment.
 */
export class EntityIndex {
  private readonly byPath = new Map<string, Set<string>>();
  private readonly byTitle = new Map<string, Set<string>>();
  private readonly byAlias = new Map<string, Set<string>>();
  private readonly titles = new Map<string, string>();
  private readonly keysById = new Map<string, Set<string>>();
  private readonly people = new Set<string>();
  private readonly paths = new Map<string, string>();
  private readonly names: Array<{ id: string; name: string; tier: 'title' | 'alias' }> = [];
  private owner: string | null = null;

  private constructor() {}

  static build(db: Database.Database, vault: Pick<VaultSettings, 'entityTypes' | 'personType' | 'companyType' | 'projectType' | 'ownerNote'> = getVaultSettings(db)): EntityIndex {
    const index = new EntityIndex();
    const types = entityKinds(vault);
    if (types.length === 0) return index;
    const rows = db.prepare(
      `SELECT DISTINCT n.id, n.title, n.file_path,
          EXISTS (SELECT 1 FROM node_types p WHERE p.node_id = n.id AND p.schema_type = ?) AS person
        FROM nodes n JOIN node_types t ON t.node_id = n.id
        WHERE t.schema_type IN (${types.map(() => '?').join(', ')})`,
    ).all(vault.personType, ...types) as Array<{ id: string; title: string | null; file_path: string; person: number }>;
    for (const row of rows) {
      index.titles.set(row.id, row.title ?? row.file_path);
      index.paths.set(row.id, row.file_path);
      if (row.title) index.names.push({ id: row.id, name: row.title, tier: 'title' });
      if (row.person) index.people.add(row.id);
      index.add(index.byPath, pathKey(row.file_path), row.id);
      if (row.title) index.add(index.byTitle, linkKey(row.title), row.id);
    }
    if (rows.length > 0) {
      for (const [id, aliases] of loadAliases(db)) {
        if (!index.titles.has(id)) continue;
        for (const alias of aliases) {
          index.add(index.byAlias, linkKey(alias), id);
          index.names.push({ id, name: alias, tier: 'alias' });
        }
      }
    }
    // The vault owner's own note (`ownerNote`), read as a subject name is.
    if (vault.ownerNote) index.owner = index.resolveKey(linkKey(subjectName(vault.ownerNote))).node_id;
    return index;
  }

  /** Whether the note is the vault owner's own (`ownerNote`): never made a subject but by the owner. */
  isOwner(nodeId: string): boolean {
    return this.owner !== null && this.owner === nodeId;
  }

  /** The vault owner's own note (`ownerNote`), when one answers to it alone. */
  ownerId(): string | null {
    return this.owner;
  }

  /** The note's title, for a note of an entity kind. */
  title(nodeId: string): string | undefined {
    return this.titles.get(nodeId);
  }

  /** Every title and alias of the entity notes, as written: for matching names in a text. */
  nameEntries(): ReadonlyArray<{ id: string; name: string; tier: 'title' | 'alias' }> {
    return this.names;
  }

  /** The note's vault path, for a note of an entity kind. */
  path(nodeId: string): string | undefined {
    return this.paths.get(nodeId);
  }

  private add(map: Map<string, Set<string>>, key: string, id: string): void {
    if (key === '') return;
    let ids = map.get(key);
    if (!ids) map.set(key, ids = new Set());
    ids.add(id);
    let keys = this.keysById.get(id);
    if (!keys) this.keysById.set(id, keys = new Set());
    keys.add(key);
  }

  /** Whether the note is of an entity kind. */
  isEntity(nodeId: string): boolean {
    return this.titles.has(nodeId);
  }

  /** Whether the note is of the vault map's person kind: the one-word rule's notes. */
  isPerson(nodeId: string): boolean {
    return this.people.has(nodeId);
  }

  /** What a name key resolves to: the first tier with a match decides. */
  resolveKey(key: string): { node_id: string | null; status: MemorySubject['status']; tier: Tier | null } {
    for (const [tier, map] of [['path', this.byPath], ['title', this.byTitle], ['alias', this.byAlias]] as const) {
      const ids = map.get(key);
      if (!ids || ids.size === 0) continue;
      if (ids.size > 1) return { node_id: null, status: 'ambiguous', tier };
      return { node_id: [...ids][0]!, status: 'linked', tier };
    }
    return { node_id: null, status: 'unresolved', tier: null };
  }

  /** The keys that resolve to this note, and to it alone, with the tier each matches in: what a
   *  name stored without a note matches it by. */
  keysResolvingTo(nodeId: string): Array<{ key: string; tier: Tier }> {
    return [...(this.keysById.get(nodeId) ?? [])].flatMap(key => {
      const resolved = this.resolveKey(key);
      return resolved.node_id === nodeId && resolved.tier !== null ? [{ key, tier: resolved.tier }] : [];
    });
  }
}

/**
 * Resolve caller input to subjects: each name once, an entity note's id taken as that note.
 * Empty names are dropped. Two names for one note keep the first. A one-word name is held to
 * the one-word rule unless the owner set it: `evidenceNodeId` is the memory's source note. A
 * name resolving to the vault owner's note (`ownerNote`) is left out unless the owner set it.
 */
export function resolveSubjects(
  db: Database.Database, index: EntityIndex, inputs: readonly string[],
  opts: { setBy: SubjectSetBy; evidenceNodeId?: string | null | undefined } = { setBy: 'tool' },
): ResolvedSubject[] {
  const out: ResolvedSubject[] = [];
  const seenKeys = new Set<string>();
  const seenNodes = new Set<string>();
  const titleOf = db.prepare<[string], { title: string | null; file_path: string }>('SELECT title, file_path FROM nodes WHERE id = ?');
  for (const input of inputs) {
    const raw = subjectName(input);
    if (raw === '') continue;
    let subject: ResolvedSubject;
    if (index.isEntity(raw)) {
      // A note id: the subject is that note, under its title.
      const note = titleOf.get(raw);
      const name = note?.title ?? note?.file_path ?? raw;
      subject = { name, name_key: linkKey(name), node_id: raw, status: 'linked' };
    } else {
      const key = linkKey(raw);
      if (key === '') continue;
      const resolved = index.resolveKey(key);
      // The owner is left out before anything else, so a held one-word name of theirs is not kept (#693).
      if (resolved.node_id !== null && opts.setBy !== 'owner' && index.isOwner(resolved.node_id)) continue;
      subject = resolved.node_id !== null && needsSourceLink(key, resolved.tier, opts.setBy, index.isPerson(resolved.node_id))
        && !sourceLinks(db, opts.evidenceNodeId, resolved.node_id)
        ? { name: raw, name_key: key, node_id: null, status: 'unresolved', held: true }
        : { name: raw, name_key: key, node_id: resolved.node_id, status: resolved.status };
    }
    if (seenKeys.has(subject.name_key) || (subject.node_id !== null && seenNodes.has(subject.node_id))) continue;
    // Memories are the owner's: the owner's own note is no subject unless the owner names it (#554).
    if (subject.node_id !== null && opts.setBy !== 'owner' && index.isOwner(subject.node_id)) continue;
    seenKeys.add(subject.name_key);
    if (subject.node_id !== null) seenNodes.add(subject.node_id);
    out.push(subject);
  }
  return out;
}

function rowsOf(db: Database.Database, memoryId: number): SubjectRow[] {
  return db.prepare<[number], SubjectRow>(
    'SELECT memory_id, name, name_key, node_id, set_by FROM memory_subjects WHERE memory_id = ? ORDER BY rowid',
  ).all(memoryId);
}

/** The names a memory's subjects were given, in the order they were set: what the memory note shows. */
export function subjectNames(db: Database.Database, memoryId: number): string[] {
  return rowsOf(db, memoryId).map(row => row.name);
}

/**
 * Whether the database has the subjects table. Startup creates it before anything reads
 * memories; a database opened without the startup migrations (a script, an older copy) has
 * no subjects, and reads say so instead of failing.
 */
function hasSubjectsTable(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_subjects'").get() !== undefined;
}

/** Every memory's subject names, for the memory note's snapshot. */
export function allSubjectNames(db: Database.Database): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!hasSubjectsTable(db)) return out;
  const rows = db.prepare('SELECT memory_id, name FROM memory_subjects ORDER BY memory_id, rowid').all() as Array<{ memory_id: number; name: string }>;
  for (const row of rows) {
    const list = out.get(row.memory_id);
    if (list) list.push(row.name);
    else out.set(row.memory_id, [row.name]);
  }
  return out;
}

/**
 * A change to a memory's subjects is a change to the memory: its `updated_at` moves, as the
 * memory note's revision check needs (a block rendered before the change is then stale, not a
 * tampered snapshot).
 */
function touch(db: Database.Database, memoryId: number, now: string): void {
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ? AND updated_at < ?').run(now, memoryId, now);
}

/** Add subjects to a memory, keeping those it has. Call inside the write's transaction. */
export function addSubjects(db: Database.Database, memoryId: number, subjects: readonly ResolvedSubject[], setBy: SubjectSetBy, now: string): number {
  const existing = rowsOf(db, memoryId);
  const keys = new Set(existing.map(row => row.name_key));
  const nodes = new Set(existing.flatMap(row => (row.node_id !== null ? [row.node_id] : [])));
  const insert = db.prepare(
    'INSERT OR IGNORE INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  for (const subject of subjects) {
    if (keys.has(subject.name_key) || (subject.node_id !== null && nodes.has(subject.node_id))) continue;
    insert.run(memoryId, subject.name, subject.name_key, subject.node_id, setBy, now);
    keys.add(subject.name_key);
    if (subject.node_id !== null) nodes.add(subject.node_id);
    added++;
  }
  if (added > 0) touch(db, memoryId, now);
  return added;
}

/**
 * Make a memory's subjects exactly these: a subject it already has (same note, or same name)
 * stays as it was set, the rest are removed, and new ones are added. A name kept for the same
 * name gives way to a given note that differs from its own (a note id or path picking one of
 * several notes that share the title, or another note of that title): the given note wins.
 * Returns the names it had when anything changed, else null. Call inside the write's transaction.
 */
export function replaceSubjects(
  db: Database.Database, memoryId: number, subjects: readonly ResolvedSubject[], setBy: SubjectSetBy, now: string,
): string[] | null {
  const existing = rowsOf(db, memoryId);
  const wantedByKey = new Map(subjects.map(subject => [subject.name_key, subject]));
  const wantedNodes = new Set(subjects.flatMap(subject => (subject.node_id !== null ? [subject.node_id] : [])));
  const kept = existing.filter(row => {
    if (row.node_id !== null && wantedNodes.has(row.node_id)) return true;
    const wanted = wantedByKey.get(row.name_key);
    // Same name: kept, unless the caller named a different note under it (#691).
    return wanted !== undefined && (wanted.node_id === null || wanted.node_id === row.node_id);
  });
  const removed = existing.filter(row => !kept.includes(row));
  const remove = db.prepare('DELETE FROM memory_subjects WHERE memory_id = ? AND name_key = ?');
  for (const row of removed) remove.run(memoryId, row.name_key);
  const added = addSubjects(db, memoryId, subjects, setBy, now);
  if (removed.length > 0) touch(db, memoryId, now);
  return removed.length > 0 || added > 0 ? existing.map(row => row.name) : null;
}

/**
 * Give `toId` the subjects of `fromId` it lacks: a memory that replaces another is about what that
 * one was about. Each goes over as it reads on `fromId` now: a subject that reaches its note only
 * by name (a one-word person's name through `fromId`'s source note, say) is linked to that note on
 * the copy, since `toId` may have another source note and the name alone could match nothing
 * there (Codex, #691).
 */
export function carrySubjects(db: Database.Database, fromId: number, toId: number, now: string): void {
  if (fromId === toId) return;
  const from = rowsOf(db, fromId);
  if (from.length === 0) return;
  const reads = new Map((subjectsOf(db, [fromId]).get(fromId) ?? []).map(subject => [subject.name, subject]));
  const existing = rowsOf(db, toId);
  const keys = new Set(existing.map(row => row.name_key));
  const nodes = new Set(existing.flatMap(row => (row.node_id !== null ? [row.node_id] : [])));
  // The survivor's own reading of its names, to tell a name it holds unlinked from one it links.
  const ownReads = new Map((subjectsOf(db, [toId]).get(toId) ?? []).map(subject => [subject.name, subject]));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_subjects (memory_id, name, name_key, node_id, set_by, created_at)
     SELECT ?, name, name_key, ?, set_by, created_at FROM memory_subjects WHERE memory_id = ? AND name_key = ?`,
  );
  const link = db.prepare('UPDATE memory_subjects SET node_id = ? WHERE memory_id = ? AND name_key = ?');
  let carried = 0;
  for (const row of from) {
    const read = reads.get(row.name);
    const nodeId = read?.status === 'linked' ? read.node_id : row.node_id;
    if (keys.has(row.name_key)) {
      // The survivor holds the same name but reaches no note by it: it takes the note this one reaches (#691).
      const same = existing.find(other => other.name_key === row.name_key)!;
      if (nodeId !== null && !nodes.has(nodeId) && ownReads.get(same.name)?.status !== 'linked') {
        link.run(nodeId, toId, row.name_key);
        nodes.add(nodeId);
        carried++;
      }
      continue;
    }
    if (nodeId !== null && nodes.has(nodeId)) continue;
    insert.run(toId, nodeId, fromId, row.name_key);
    keys.add(row.name_key);
    if (nodeId !== null) nodes.add(nodeId);
    carried++;
  }
  if (carried > 0) touch(db, toId, now);
}

/** Remove a memory's subjects (a purge). */
export function deleteSubjects(db: Database.Database, memoryId: number): void {
  db.prepare('DELETE FROM memory_subjects WHERE memory_id = ?').run(memoryId);
}

/** Point the subjects linked to merged notes at the kept note (merge-nodes). */
export function moveSubjects(db: Database.Database, keptId: string, mergedId: string, now: string = new Date().toISOString()): void {
  // A memory about both notes keeps one subject for the kept note. That drops a name from it,
  // so its revision moves, as for any subject change (#691).
  const both = db.prepare(
    `SELECT DISTINCT memory_id FROM memory_subjects WHERE node_id = ? AND memory_id IN (SELECT memory_id FROM memory_subjects WHERE node_id = ?)`,
  ).all(mergedId, keptId) as Array<{ memory_id: number }>;
  const remove = db.prepare('DELETE FROM memory_subjects WHERE memory_id = ? AND node_id = ?');
  for (const { memory_id } of both) {
    remove.run(memory_id, mergedId);
    touch(db, memory_id, now);
  }
  db.prepare('UPDATE memory_subjects SET node_id = ? WHERE node_id = ?').run(keptId, mergedId);
}

/**
 * The subjects of these memories as callers see them. A subject linked to a note that still
 * exists is that note; any other is read by its name against the entity notes now.
 */
export function subjectsOf(db: Database.Database, memoryIds: readonly number[]): Map<number, MemorySubject[]> {
  const out = new Map<number, MemorySubject[]>();
  if (memoryIds.length === 0 || !hasSubjectsTable(db)) return out;
  const rows: SubjectRow[] = [];
  const ids = [...new Set(memoryIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...db.prepare(
      `SELECT memory_id, name, name_key, node_id, set_by FROM memory_subjects WHERE memory_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY memory_id, rowid`,
    ).all(...chunk) as SubjectRow[]);
  }
  if (rows.length === 0) return out;
  const noteOf = db.prepare<[string], { title: string | null; file_path: string }>('SELECT title, file_path FROM nodes WHERE id = ?');
  const sourceOf = db.prepare<[number], { evidence_node_id: string | null }>('SELECT evidence_node_id FROM memories WHERE id = ?');
  let index: EntityIndex | null = null;
  for (const row of rows) {
    let subject: MemorySubject;
    const note = row.node_id !== null ? noteOf.get(row.node_id) : undefined;
    if (row.node_id !== null && note) {
      subject = { name: row.name, node_id: row.node_id, title: note.title ?? note.file_path, status: 'linked', set_by: row.set_by as SubjectSetBy };
    } else {
      index ??= EntityIndex.build(db);
      const found = index.resolveKey(row.name_key);
      let resolved: { node_id: string | null; status: MemorySubject['status'] } = found;
      if (found.node_id !== null && ((index.isOwner(found.node_id) && row.set_by !== 'owner')
        || (needsSourceLink(row.name_key, found.tier, row.set_by, index.isPerson(found.node_id))
          && !sourceLinks(db, sourceOf.get(row.memory_id)?.evidence_node_id, found.node_id)))) {
        // The owner only by the owner's own edit; a one-word person only through the source note.
        resolved = { node_id: null, status: 'unresolved' };
      }
      const title = resolved.node_id !== null ? noteOf.get(resolved.node_id) : undefined;
      subject = {
        name: row.name, node_id: resolved.node_id, title: title ? title.title ?? title.file_path : null,
        status: resolved.status, set_by: row.set_by as SubjectSetBy,
      };
    }
    const list = out.get(row.memory_id);
    if (list) list.push(subject);
    else out.set(row.memory_id, [subject]);
  }
  return out;
}

/**
 * A condition on a subject row `s`: stored without a note (or its note is gone), with a name that
 * now resolves to this note alone. A one-word name matching a person's note by title or alias
 * also needs the one-word rule: set by the owner, or the memory's source note is the note or links
 * to it. Null when no name resolves to the note.
 */
function nameMatch(db: Database.Database, nodeId: string, index: EntityIndex = EntityIndex.build(db)): { sql: string; args: unknown[] } | null {
  const keys = index.keysResolvingTo(nodeId);
  const person = index.isPerson(nodeId);
  const free = keys.filter(({ key, tier }) => !needsSourceLink(key, tier, 'tool', person)).map(({ key }) => key);
  const held = keys.filter(({ key, tier }) => needsSourceLink(key, tier, 'tool', person)).map(({ key }) => key);
  const marks = (list: readonly string[]) => list.map(() => '?').join(', ');
  const byName: string[] = [];
  const args: unknown[] = [];
  if (free.length > 0) {
    byName.push(`s.name_key IN (${marks(free)})`);
    args.push(...free);
  }
  if (held.length > 0) {
    byName.push(`(s.name_key IN (${marks(held)}) AND (s.set_by = 'owner' OR EXISTS (SELECT 1 FROM memories mm WHERE mm.id = s.memory_id
      AND (mm.evidence_node_id = ? OR EXISTS (SELECT 1 FROM relationships r WHERE r.source_id = mm.evidence_node_id AND r.resolved_target_id = ?)))))`);
    args.push(...held, nodeId, nodeId);
  }
  if (byName.length === 0) return null;
  // The owner's note is reached by name only through a name the owner gave (#693).
  const ownerOnly = index.isOwner(nodeId) ? " AND s.set_by = 'owner'" : '';
  return {
    sql: `((s.node_id IS NULL OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = s.node_id)) AND (${byName.join(' OR ')})${ownerOnly})`,
    args,
  };
}

/**
 * A `list-memories subject_of` condition on memories `m`: memories with a subject linked to the
 * note, or a subject whose name now resolves to it (`nameMatch`).
 */
export function subjectOfCondition(db: Database.Database, nodeId: string): { sql: string; args: unknown[] } {
  const byName = nameMatch(db, nodeId);
  return {
    sql: `EXISTS (SELECT 1 FROM memory_subjects s WHERE s.memory_id = m.id AND (s.node_id = ?${byName ? ` OR ${byName.sql}` : ''}))`,
    args: [nodeId, ...(byName?.args ?? [])],
  };
}

/**
 * Link to these notes the subjects that resolve to them only by name now, before an operation
 * takes the notes away (merge-nodes): a merge moves linked subjects to the kept note, and a
 * name-only subject would otherwise be left behind, matching nothing once the note is gone and
 * its name is not kept as an alias (Codex, #691). The names are unchanged, so the memories'
 * revisions are too.
 */
export function bindNameMatches(db: Database.Database, nodeIds: readonly string[]): void {
  if (nodeIds.length === 0 || !hasSubjectsTable(db)) return;
  const index = EntityIndex.build(db);
  for (const id of nodeIds) {
    const byName = nameMatch(db, id, index);
    if (byName) db.prepare(`UPDATE memory_subjects AS s SET node_id = ? WHERE ${byName.sql}`).run(id, ...byName.args);
  }
}
