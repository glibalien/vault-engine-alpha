// src/renderer/field-order.ts
//
// Frontmatter key order for a render. Claimed fields follow their schemas'
// order. Fields no schema claims keep the order they have in the note on disk;
// ones the note does not hold yet follow, in Unicode codepoint order (#447).
//
// The note itself is the only record of that order: Engine stores field values,
// not their position. Reading it back from the current file keeps a re-render
// of an unchanged note byte-stable, and the order a person gave their fields
// survives every Engine write.

import { parseFrontmatterMapping } from '../parser/frontmatter.js';
import type { EffectiveFieldSet } from '../validation/types.js';
import type { FieldOrderEntry } from './types.js';

/**
 * Top-level frontmatter keys of a note's content, in file order. Empty when
 * there is no content, no frontmatter, or frontmatter that does not parse.
 */
export function frontmatterKeyOrder(content: string | null): string[] {
  if (content === null) return [];
  const mapping = parseFrontmatterMapping(content);
  return mapping.parseError === null ? Object.keys(mapping.data) : [];
}

/**
 * Claimed fields first, by resolved schema order (ties by codepoint name).
 * Then unclaimed fields, including keys held empty (`explicitNullFields` no
 * schema claims, which the renderer writes in place): those in
 * `existingKeyOrder` (the note's current keys) in that order, then the rest in
 * codepoint order. Then any remaining field (a merge-conflicted one with a
 * value), in map order.
 */
export function computeFieldOrdering(
  effectiveFields: EffectiveFieldSet,
  orphanFieldNames: Iterable<string>,
  finalFields: Record<string, unknown>,
  existingKeyOrder: readonly string[] = [],
  explicitNullFields: Iterable<string> = [],
): FieldOrderEntry[] {
  const ordering: FieldOrderEntry[] = [];
  const placed = new Set<string>();

  const claimed = Array.from(effectiveFields.entries())
    .filter(([name]) => Object.hasOwn(finalFields, name))
    .sort((a, b) => {
      const orderDiff = a[1].resolved_order - b[1].resolved_order;
      if (orderDiff !== 0) return orderDiff;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  for (const [name] of claimed) {
    ordering.push({ field: name, category: 'claimed' });
    placed.add(name);
  }

  const orphans = new Set([
    ...[...orphanFieldNames].filter(name => Object.hasOwn(finalFields, name)),
    ...[...explicitNullFields].filter(name => !effectiveFields.has(name)),
  ].filter(name => !placed.has(name)));
  for (const name of existingKeyOrder) {
    if (!orphans.has(name) || placed.has(name)) continue;
    ordering.push({ field: name, category: 'orphan' });
    placed.add(name);
  }
  for (const name of [...orphans].filter(name => !placed.has(name)).sort()) {
    ordering.push({ field: name, category: 'orphan' });
    placed.add(name);
  }

  for (const name of Object.keys(finalFields)) {
    if (placed.has(name)) continue;
    ordering.push({ field: name, category: 'claimed' });
    placed.add(name);
  }

  return ordering;
}
