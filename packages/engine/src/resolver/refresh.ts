import type Database from 'better-sqlite3';
import { candidateKeysForNode, targetMatchesKeys, type CandidateKeys } from './candidate-keys.js';
import { ResolutionLookup, anchoredLinkName, resolveTarget } from './resolve.js';
import { readReferencePolicyVersion } from '../db/reference-policy-version.js';
import type { ReferenceDiagnostic } from '../pipeline/diagnostics.js';
import { TYPED_REFERENCE_EDGE_SQL, readNodeResolutionIdentity, refreshTypedReferences, type NodeResolutionIdentity } from './typed-refresh.js';

function legacyEdges(db: Database.Database): string {
  return readReferencePolicyVersion(db) === 2 ? ` AND NOT (${TYPED_REFERENCE_EDGE_SQL})` : '';
}

/**
 * Bind still-unresolved links to a heading or block in this note (`[[Name#Heading]]`, #613):
 * those whose name before the `#` names it, after the whole-target tiers have run.
 */
function bindAnchoredLinks(db: Database.Database, nodeId: string, keys: CandidateKeys, legacy: string): void {
  const rows = db
    .prepare(`SELECT id, target FROM relationships WHERE resolved_target_id IS NULL AND instr(target, '#') > 0${legacy}`)
    .all() as Array<{ id: number; target: string }>;
  const upd = db.prepare(`UPDATE relationships SET resolved_target_id = ? WHERE id = ?${legacy}`);
  for (const row of rows) {
    const name = anchoredLinkName(row.target);
    if (name !== null && targetMatchesKeys(name, keys)) upd.run(nodeId, row.id);
  }
}

/**
 * Called after a node is created. Resolves any existing NULL-resolved
 * relationships whose raw `target` matches one of the new node's
 * candidate keys (file_path, title, basename, case-folded basename,
 * NFC-normalized basename).
 *
 * Legacy/unconstrained edges do not supersede existing bindings. Under v2,
 * typed edges are recomputed first, including existing non-null bindings.
 * Returns the typed edges the new node unbound (now ambiguous, for example).
 */
export function refreshOnCreate(db: Database.Database, nodeId: string): ReferenceDiagnostic[] {
  const row = db
    .prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
    .get(nodeId) as { id: string; file_path: string; title: string | null } | undefined;
  if (!row) return [];
  const keys = candidateKeysForNode(row);

  const legacy = legacyEdges(db);
  let unbound: ReferenceDiagnostic[] = [];
  const tx = db.transaction(() => {
    unbound = refreshTypedReferences(db, { kind: 'node', before: null, after: readNodeResolutionIdentity(db, nodeId) }).unbound ?? [];
    // Tier 1: exact file_path, written with or without `.md` (#592)
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND target = ?${legacy}`
    ).run(nodeId, keys.file_path);
    if (keys.pathStem !== null) {
      db.prepare(
        `UPDATE relationships SET resolved_target_id = ?
           WHERE resolved_target_id IS NULL AND target = ?${legacy}`
      ).run(nodeId, keys.pathStem);
    }

    // Tier 2: exact title (when present)
    if (keys.title !== null) {
      db.prepare(
        `UPDATE relationships SET resolved_target_id = ?
           WHERE resolved_target_id IS NULL AND target = ?${legacy}`
      ).run(nodeId, keys.title);
    }

    // Tier 3: exact basename
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND target = ?${legacy}`
    ).run(nodeId, keys.basename);

    // Tier 4: case-folded basename (compare lowercased target to basenameLower)
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND LOWER(target) = ?${legacy}`
    ).run(nodeId, keys.basenameLower);

    // Tier 5: NFC-normalized, case-folded basename.
    // SQLite has no NFC normalization; handle with a scan restricted to NULL rows.
    const nullRows = db
      .prepare(`SELECT id, target FROM relationships WHERE resolved_target_id IS NULL${legacy}`)
      .all() as Array<{ id: number; target: string }>;
    const upd = db.prepare(`UPDATE relationships SET resolved_target_id = ? WHERE id = ?${legacy}`);
    for (const r of nullRows) {
      if (r.target.normalize('NFC').toLowerCase() === keys.basenameNfcLower) {
        upd.run(nodeId, r.id);
      }
    }

    bindAnchoredLinks(db, nodeId, keys, legacy);
  });
  tx();
  return unbound;
}

/**
 * Called after a node's file_path or title changes.
 * Step 1: null out every relationship whose resolved_target_id = nodeId.
 * Step 2: for each unique raw target in those rows, call resolveTarget and
 *         repopulate. (Deduping keeps N resolver calls down to U unique
 *         targets.)
 * Step 3: run refreshOnCreate-equivalent over still-NULL rows — rows whose
 *         raw target now matches the renamed node's new keys.
 */
export function refreshOnRename(db: Database.Database, nodeId: string, before?: NodeResolutionIdentity | null, options: { deferTypedReferences?: boolean } = {}): ReferenceDiagnostic[] {
  const legacy = legacyEdges(db);
  let unbound: ReferenceDiagnostic[] = [];
  const tx = db.transaction(() => {
    const after = readNodeResolutionIdentity(db, nodeId);
    if (!options.deferTypedReferences) unbound = refreshTypedReferences(db, { kind: 'node', before: before ?? null, after }).unbound ?? [];
    const affected = db
      .prepare(
        `SELECT DISTINCT target FROM relationships WHERE resolved_target_id = ?${legacy}`
      )
      .all(nodeId) as Array<{ target: string }>;

    db.prepare(`UPDATE relationships SET resolved_target_id = NULL WHERE resolved_target_id = ?${legacy}`).run(nodeId);

    const upd = db.prepare(`UPDATE relationships SET resolved_target_id = ? WHERE target = ? AND resolved_target_id IS NULL${legacy}`);
    for (const { target } of affected) {
      const resolved = resolveTarget(db, target);
      if (resolved) {
        upd.run(resolved.id, target);
      }
    }

    // Step 3: cover edges whose raw target matches the new name.
    // Inline the create-logic rather than nesting transactions.
    const row = db
      .prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
      .get(nodeId) as { id: string; file_path: string; title: string | null } | undefined;
    if (!row) return;
    const keys = candidateKeysForNode(row);

    db.prepare(
      `UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?${legacy}`
    ).run(nodeId, keys.file_path);
    if (keys.pathStem !== null) {
      db.prepare(
        `UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?${legacy}`
      ).run(nodeId, keys.pathStem);
    }
    if (keys.title !== null) {
      db.prepare(
        `UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?${legacy}`
      ).run(nodeId, keys.title);
    }
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?${legacy}`
    ).run(nodeId, keys.basename);
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND LOWER(target) = ?${legacy}`
    ).run(nodeId, keys.basenameLower);

    const nullRows = db
      .prepare(`SELECT id, target FROM relationships WHERE resolved_target_id IS NULL${legacy}`)
      .all() as Array<{ id: number; target: string }>;
    const updById = db.prepare(`UPDATE relationships SET resolved_target_id = ? WHERE id = ?${legacy}`);
    for (const r of nullRows) {
      if (r.target.normalize('NFC').toLowerCase() === keys.basenameNfcLower) {
        updById.run(nodeId, r.id);
      }
    }

    bindAnchoredLinks(db, nodeId, keys, legacy);
  });
  tx();
  return unbound;
}

/**
 * v1: no-op. FK `ON DELETE SET NULL` handles the row-level nulling.
 * Exported so callers can wire in advance; future versions may promote
 * runner-up resolutions for affected rows.
 */
export function refreshOnDelete(_db: Database.Database, _nodeId: string): void {
  // Intentionally empty. See spec: "Re-resolution on delete ... documented v1 limitation."
}

export interface BackfillStats {
  scanned: number;
  uniqueTargets: number;
  updated: number;
}

/**
 * Walks every NULL-resolved relationship, dedupes by raw target, resolves
 * each unique string, and UPDATEs in chunks. Runs after every fullIndex
 * (startup), so files created while the engine was down still resolve
 * inbound pending edges — indexFile alone never refreshes those.
 *
 * Resolves through one ResolutionLookup (one pass over nodes) instead of a
 * full table scan per unique target. Tier order and pickShortest ambiguity
 * semantics are resolveTarget's (pinned in refresh.test.ts).
 */
export function backfillResolvedTargets(db: Database.Database): BackfillStats {
  const legacy = legacyEdges(db);
  const nullRows = db
    .prepare(`SELECT id, target FROM relationships WHERE resolved_target_id IS NULL${legacy}`)
    .all() as Array<{ id: number; target: string }>;

  const scanned = nullRows.length;
  if (scanned === 0) {
    return { scanned: 0, uniqueTargets: 0, updated: 0 };
  }

  // Dedupe by raw target.
  const byTarget = new Map<string, number[]>();
  for (const r of nullRows) {
    const list = byTarget.get(r.target);
    if (list) list.push(r.id);
    else byTarget.set(r.target, [r.id]);
  }

  const lookup = new ResolutionLookup(db);
  let updated = 0;
  const upd = db.prepare(`UPDATE relationships SET resolved_target_id = ? WHERE id = ?${legacy}`);
  const tx = db.transaction(() => {
    for (const [target, ids] of byTarget) {
      const resolved = lookup.resolve(target);
      if (!resolved) continue;
      for (const id of ids) {
        upd.run(resolved.id, id);
        updated++;
      }
    }
  });
  tx();

  return { scanned, uniqueTargets: byTarget.size, updated };
}
