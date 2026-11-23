// src/pipeline/relationships.ts
//
// Derive relationships from the final validated state.
// Relationships are derived in Stage 6, not carried in ProposedMutation.

import type { GlobalFieldDefinition } from '../validation/types.js';
import type { ReferenceContext } from '../resolver/relationship-policy.js';
import { extractBodyWikiLinks } from '../parser/wiki-links.js';
import { linksInWritten, renderedRawText } from '../parser/raw-field-texts.js';


/**
 * The link targets of a field as its file shows it: from its raw text, read as the renderer
 * writes it, or else from the value, where a caller wrote the brackets themselves. Each text
 * is read on its own, at any depth, so a link in a list item or inside a map is found, and a
 * target holding a quote is not read through JSON's escapes (#667).
 */
function fieldLinkTargets(value: unknown, raw: string | undefined): string[] {
  return linksInWritten(raw === undefined ? value : renderedRawText(raw, value)).map(link => link.target);
}

export interface DerivedRelationship {
  target: string;
  rel_type: string;
  context: string;
}

export interface ContextualRelationship extends DerivedRelationship {
  referenceContext: ReferenceContext;
}

/**
 * Derive relationships from final field values and body wiki-links.
 */
export function deriveRelationships(
  fields: Record<string, unknown>,
  body: string,
  globalFields: Map<string, GlobalFieldDefinition>,
  orphanRawValues: Record<string, string>,
): DerivedRelationship[] {
  return deriveReferenceContexts(fields, body, globalFields, orphanRawValues, false)
    .map(({ target, rel_type, context }) => ({ target, rel_type, context }));
}

export function deriveReferenceContexts(
  fields: Record<string, unknown>,
  body: string,
  globalFields: Map<string, GlobalFieldDefinition>,
  orphanRawValues: Record<string, string>,
  includeDefinedNonReferenceLinks = true,
): readonly ContextualRelationship[] {
  const rels: ContextualRelationship[] = [];
  const seen = new Set<string>();

  function addRel(target: string, relType: string, context: string, referenceContext: ReferenceContext): void {
    const key = `${target}|${relType}`;
    if (seen.has(key)) return;
    seen.add(key);
    rels.push({ target, rel_type: relType, context, referenceContext });
  }

  // Frontmatter reference fields
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;

    const gf = globalFields.get(fieldName);
    if (gf) {
      if (gf.field_type === 'reference' && typeof value === 'string') {
        addRel(value, fieldName, fieldName, { origin: 'field', field: fieldName, requiredType: gf.reference_target });
      } else if (gf.field_type === 'list' && gf.list_item_type === 'reference' && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            addRel(item, fieldName, fieldName, { origin: 'field', field: fieldName, requiredType: gf.reference_target });
          }
        }
      } else if (includeDefinedNonReferenceLinks) {
        // A defined non-reference field can still contain explicit wiki-links.
        // They remain unconstrained references, with frontmatter origin.
        const raw = Object.hasOwn(orphanRawValues, fieldName) ? orphanRawValues[fieldName] : undefined;
        for (const target of fieldLinkTargets(value, raw)) {
          addRel(target, fieldName, fieldName, { origin: 'orphan', field: fieldName, requiredType: null });
        }
      }
    }

    // Orphan fields — extract wiki-links from raw text or from the value itself
    if (!gf) {
      // Prefer value_raw_text if available (watcher path)
      const raw = Object.hasOwn(orphanRawValues, fieldName) ? orphanRawValues[fieldName] : undefined;
      for (const target of fieldLinkTargets(value, raw)) {
        addRel(target, fieldName, fieldName, { origin: 'orphan', field: fieldName, requiredType: null });
      }
    }
  }

  // Body wiki-links (an empty body has none; parsing one still costs a Markdown parse)
  const bodyLinks = body === '' ? [] : extractBodyWikiLinks(body);
  for (const link of bodyLinks) {
    addRel(link.target, 'wiki-link', link.context, { origin: 'body', field: null, requiredType: null });
  }

  return rels;
}
