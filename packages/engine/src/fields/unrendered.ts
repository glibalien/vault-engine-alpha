// src/fields/unrendered.ts
//
// Fields the Engine stores and returns but never writes to a note's file (#547).
// They are the wiki build fingerprints: the Engine and the Curator read them to
// decide whether a wiki needs rebuilding, and they mean nothing to a reader.
//
// The renderer leaves them out of the frontmatter. Because the file never holds
// them, a reader of the file (the watcher, the startup index) keeps the stored
// value rather than treating its absence as a removal, and a write that changes
// only one of them commits to the database without rewriting the file.
//
// A file written before #547 may still carry one; a reader takes it only when the
// node has no stored value (a database rebuilt from the files). The line goes the
// next time the Engine writes that note.

export const UNRENDERED_FIELDS: ReadonlySet<string> = new Set([
  'wiki_evidence_hash',
  'wiki_topology_hash',
  'wiki_reconcile_key',
]);

export function isUnrenderedField(name: string): boolean {
  return UNRENDERED_FIELDS.has(name);
}
