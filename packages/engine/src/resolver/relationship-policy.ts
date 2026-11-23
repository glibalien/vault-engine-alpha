import type Database from 'better-sqlite3';
import { candidateKeysForNode } from './candidate-keys.js';
import { anchoredLinkName, pathTargetWithMd } from './resolve.js';

export type ReferencePolicyVersion = 1 | 2;
export interface ReferenceContext {
  origin: 'field' | 'body' | 'orphan';
  field: string | null;
  requiredType: string | null;
}
export interface ReferenceRequest {
  rawTarget: string;
  context: ReferenceContext;
}
export interface Candidate {
  id: string;
  file_path: string;
  title: string | null;
  types: readonly string[];
}
export type MatchTier = 1 | 2 | 3 | 4 | 5;
interface ResolutionBase {
  tier: MatchTier | null;
  candidateCount: number;
  candidates: readonly Candidate[];
  candidatesTruncated: boolean;
}
export type Resolution =
  | (ResolutionBase & { status: 'resolved'; targetId: string })
  | (ResolutionBase & { status: 'unresolved'; reason: 'missing' | 'type_mismatch' | 'ambiguous' });

export interface ReferenceCatalog {
  readonly byPath: ReadonlyMap<string, readonly Candidate[]>;
  readonly byTitle: ReadonlyMap<string, readonly Candidate[]>;
  readonly byBasename: ReadonlyMap<string, readonly Candidate[]>;
  readonly byLower: ReadonlyMap<string, readonly Candidate[]>;
  readonly byNfcLower: ReadonlyMap<string, readonly Candidate[]>;
}

const MAX_CANDIDATES = 10;

function append(map: Map<string, Candidate[]>, key: string | null, candidate: Candidate): void {
  if (key === null) return;
  const values = map.get(key) ?? [];
  values.push(candidate);
  map.set(key, values);
}

export function buildReferenceCatalog(db: Database.Database): ReferenceCatalog {
  const rows = db.prepare('SELECT id, file_path, title FROM nodes').all() as Array<Omit<Candidate, 'types'>>;
  const typeRows = db.prepare('SELECT node_id, schema_type FROM node_types ORDER BY schema_type').all() as Array<{ node_id: string; schema_type: string }>;
  const types = new Map<string, string[]>();
  for (const row of typeRows) {
    const list = types.get(row.node_id) ?? [];
    list.push(row.schema_type);
    types.set(row.node_id, list);
  }
  const byPath = new Map<string, Candidate[]>();
  const byTitle = new Map<string, Candidate[]>();
  const byBasename = new Map<string, Candidate[]>();
  const byLower = new Map<string, Candidate[]>();
  const byNfcLower = new Map<string, Candidate[]>();
  for (const row of rows) {
    const candidate: Candidate = { ...row, types: types.get(row.id) ?? [] };
    const keys = candidateKeysForNode(row);
    append(byPath, keys.file_path, candidate);
    append(byTitle, keys.title, candidate);
    append(byBasename, keys.basename, candidate);
    append(byLower, keys.basenameLower, candidate);
    append(byNfcLower, keys.basenameNfcLower, candidate);
  }
  return { byPath, byTitle, byBasename, byLower, byNfcLower };
}

function details(candidates: readonly Candidate[], tier: MatchTier | null): ResolutionBase {
  const ordered = [...candidates].sort((a, b) =>
    a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    tier,
    candidateCount: ordered.length,
    candidates: ordered.slice(0, MAX_CANDIDATES),
    candidatesTruncated: ordered.length > MAX_CANDIDATES,
  };
}

function legacyWinner(candidates: readonly Candidate[]): Candidate {
  // Stable tie-breaking mirrors resolveTarget's SQL row order and pickShortest.
  return candidates.reduce((best, next) => next.file_path.length < best.file_path.length ? next : best);
}

/**
 * Resolve one reference. A target that matches no note at any tier and links to a heading or
 * block (`Alpha#Intro`) resolves by the note name before the `#` (#613); one that matches a
 * note, even of the wrong type, is decided by that match.
 */
export function resolveRelationship(
  catalog: ReferenceCatalog,
  request: ReferenceRequest,
  version: ReferencePolicyVersion,
): Resolution {
  const whole = resolveWholeRelationship(catalog, request, version);
  if (whole.status === 'resolved' || whole.reason !== 'missing') return whole;
  const name = anchoredLinkName(request.rawTarget);
  return name === null ? whole : resolveWholeRelationship(catalog, { ...request, rawTarget: name }, version);
}

function resolveWholeRelationship(
  catalog: ReferenceCatalog,
  request: ReferenceRequest,
  version: ReferencePolicyVersion,
): Resolution {
  const raw = request.rawTarget;
  const target = raw.endsWith('.md') ? raw.slice(0, -3) : raw;
  const withMd = pathTargetWithMd(raw);
  const tiers: Array<[MatchTier, readonly Candidate[]]> = [
    // An exact path, written with or without `.md` (#592).
    [1, catalog.byPath.get(raw) ?? (withMd !== null ? catalog.byPath.get(withMd) : undefined) ?? []],
    [2, catalog.byTitle.get(raw) ?? []],
    [3, catalog.byBasename.get(target) ?? []],
    [4, catalog.byLower.get(target.toLowerCase()) ?? []],
    [5, catalog.byNfcLower.get(target.normalize('NFC').toLowerCase()) ?? []],
  ];
  const requiredType = version === 2 ? request.context.requiredType : null;
  let firstWrongType: ResolutionBase | null = null;
  for (const [tier, all] of tiers) {
    if (all.length === 0) continue;
    if (requiredType === null) {
      return { status: 'resolved', targetId: legacyWinner(all).id, ...details(all, tier) };
    }
    const eligible = all.filter(candidate => candidate.types.includes(requiredType));
    if (eligible.length === 1) {
      return { status: 'resolved', targetId: eligible[0].id, ...details(eligible, tier) };
    }
    if (eligible.length > 1) {
      return { status: 'unresolved', reason: 'ambiguous', ...details(eligible, tier) };
    }
    const mismatch = details(all, tier);
    if (tier === 1) return { status: 'unresolved', reason: 'type_mismatch', ...mismatch };
    firstWrongType ??= mismatch;
  }
  return firstWrongType
    ? { status: 'unresolved', reason: 'type_mismatch', ...firstWrongType }
    : { status: 'unresolved', reason: 'missing', ...details([], null) };
}
