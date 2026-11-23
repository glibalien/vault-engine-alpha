// src/pipeline/shared-catalogs.ts
//
// Node catalogs shared by a run of writes (#575, #589). A write resolves and
// canonicalizes its links against catalogs of every note's identity, and builds
// them for itself alone unless its caller passes them. A run of writes that
// leaves those identities as they are (a rename's reference rewrites, an undo's
// restores) shares one set instead, so it costs its writes plus one pass over
// the vault rather than its writes times the vault.

import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { LinkCanonicalizer } from '../resolver/file-link.js';
import { loadAliases } from '../resolver/near-miss.js';
import { buildReferenceCatalog, type ReferenceCatalog } from '../resolver/relationship-policy.js';
import { ResolutionLookup } from '../resolver/resolve.js';
import { readNodeResolutionIdentity } from '../resolver/typed-refresh.js';

/** The catalogs a write takes from its caller (ProposedMutation), each loaded when first needed. */
export interface SharedCatalogs {
  /** Link canonicalization, which tool writes run. */
  linkCanonicalizer: LinkCanonicalizer;
  /** Reference resolution under policy 2. */
  referenceCatalog: () => ReferenceCatalog;
  /** Reference resolution under policy 1. */
  targetLookup: () => ResolutionLookup;
}

export function shareCatalogs(db: Database.Database): SharedCatalogs {
  let catalog: ReferenceCatalog | null = null;
  let lookup: ResolutionLookup | null = null;
  return {
    linkCanonicalizer: new LinkCanonicalizer(db),
    referenceCatalog: () => catalog ??= buildReferenceCatalog(db),
    targetLookup: () => lookup ??= new ResolutionLookup(db),
  };
}

/** What a note puts in those catalogs: its path, title, types and aliases. */
export interface CatalogIdentity {
  file_path: string;
  title: string | null;
  /** Sorted. */
  types: readonly string[];
  aliases: readonly string[];
}

export function catalogIdentity(db: Database.Database, nodeId: string): CatalogIdentity | null {
  const identity = readNodeResolutionIdentity(db, nodeId);
  if (identity === null) return null;
  return {
    file_path: identity.file_path,
    title: identity.title,
    types: identity.types,
    aliases: loadAliases(db, nodeId).get(nodeId) ?? [],
  };
}

/** Whether a note is in the catalogs as it was: shared catalogs built before stay current. */
export function sameCatalogIdentity(before: CatalogIdentity | null, after: CatalogIdentity | null): boolean {
  return before !== null && after !== null && isDeepStrictEqual(before, after);
}
