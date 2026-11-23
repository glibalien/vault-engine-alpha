import type Database from 'better-sqlite3';
import { entityKinds, type VaultSettings } from '@vault/settings-registry';
import { getVaultSettings } from '../settings/vault.js';
import { EntityIndex, subjectsOf, type ResolvedSubject } from './subjects.js';

/**
 * Subjects that keep two memories apart (#718, the #554 issue's item 6): two memories about
 * different things of the same kind are different facts, however alike they read, so neither
 * may replace the other. Create, the consolidation replay and the Curator's nightly reconcile
 * (through `list-memory-near-pairs`' `subjects_apart`) all ask this one rule before any merge
 * (duplicate or noop, update, contradict).
 *
 * Owner's decision (2026-11-21), after measuring on production:
 * - The owner's own companies (the companies the vault map's `ownerNote` links in the company
 *   field) do not count: such a company is a subject on a large share of memories, so
 *   look-alike facts about different things ("the X order through <company> is worth…")
 *   all shared it and were never kept apart.
 * - Only linked subjects count (a name no note answers to, or a held one-word name, does not).
 * - Both must then have a subject of the same kind (company and company, person and person,
 *   project and project) and share no subject. Subjects are often partial: a memory tagged only
 *   with a person and a look-alike tagged only with that person's company are not kept apart (a
 *   side agent's point, 2026-11-21). On 136 past merges the first rule ("share none") would have
 *   blocked 4, 2 wrongly; this one, 1 (a project against its own sub-projects, harmless).
 */
export class SubjectGuard {
  private readonly kindsById = new Map<string, Set<string>>();
  private readonly kindStmt: Database.Statement<[string], { schema_type: string }>;

  private constructor(
    private readonly db: Database.Database,
    private readonly kinds: readonly string[],
    private readonly ownerCompanies: ReadonlySet<string>,
  ) {
    this.kindStmt = db.prepare<[string], { schema_type: string }>('SELECT schema_type FROM node_types WHERE node_id = ?');
  }

  static build(db: Database.Database,
    vault: Pick<VaultSettings, 'entityTypes' | 'personType' | 'companyType' | 'projectType' | 'ownerNote' | 'companyField'> = getVaultSettings(db)): SubjectGuard {
    const kinds = entityKinds(vault);
    const owner = vault.ownerNote ? EntityIndex.build(db, vault).ownerId() : null;
    const companies = new Set<string>();
    if (owner !== null && vault.companyField) {
      const rows = db.prepare<[string, string], { id: string }>(
        `SELECT DISTINCT resolved_target_id AS id FROM relationships
          WHERE source_id = ? AND rel_type = ? AND resolved_target_id IS NOT NULL`,
      ).all(owner, vault.companyField);
      for (const row of rows) companies.add(row.id);
    }
    return new SubjectGuard(db, kinds, companies);
  }

  /** The owner's own companies, which never keep memories apart. */
  get ownCompanies(): ReadonlySet<string> {
    return this.ownerCompanies;
  }

  private kindsOf(nodeId: string): Set<string> {
    let found = this.kindsById.get(nodeId);
    if (!found) {
      found = new Set(this.kindStmt.all(nodeId).map(row => row.schema_type).filter(type => this.kinds.includes(type)));
      this.kindsById.set(nodeId, found);
    }
    return found;
  }

  /** Whether memories about these notes are about different things of one kind. */
  apart(a: Iterable<string>, b: Iterable<string>): boolean {
    const left = [...new Set(a)].filter(id => !this.ownerCompanies.has(id));
    const right = [...new Set(b)].filter(id => !this.ownerCompanies.has(id));
    if (left.length === 0 || right.length === 0) return false;
    if (left.some(id => right.includes(id))) return false;
    const leftKinds = new Set(left.flatMap(id => [...this.kindsOf(id)]));
    return right.some(id => [...this.kindsOf(id)].some(kind => leftKinds.has(kind)));
  }

  /** The linked notes of stored memories, by memory id, as `subjectsOf` reads them now. */
  linkedOf(memoryIds: readonly number[]): Map<number, string[]> {
    return linkedNotesOf(this.db, memoryIds);
  }

  /** The candidates a memory about `subjects` must not merge with. */
  keptApart(subjects: readonly string[], candidateIds: readonly number[]): Set<number> {
    const apart = new Set<number>();
    if (subjects.length === 0 || candidateIds.length === 0) return apart;
    for (const [id, linked] of this.linkedOf(candidateIds)) if (this.apart(subjects, linked)) apart.add(id);
    return apart;
  }
}

/** The linked notes of stored memories, by memory id, as `subjectsOf` reads them now. */
export function linkedNotesOf(db: Database.Database, memoryIds: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [id, subjects] of subjectsOf(db, memoryIds)) {
    out.set(id, subjects.flatMap(subject => subject.node_id !== null && subject.status === 'linked' ? [subject.node_id] : []));
  }
  return out;
}

/** The linked notes of subjects a caller gave, as create resolved them. */
export function linkedSubjects(subjects: readonly ResolvedSubject[] | undefined): string[] {
  return (subjects ?? []).flatMap(subject => subject.node_id !== null && subject.status === 'linked' && !subject.held ? [subject.node_id] : []);
}
