// src/renderer/render.ts
//
// Deterministic renderer: DB state → canonical markdown file content.
// Pure function — no DB dependency. The caller provides all inputs.

import { createFieldMap } from '../fields/field-map.js';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import type { KeptFieldText, RenderInput } from './types.js';
import { typeKey } from '../parser/type-key.js';
import { renderedRawText } from '../parser/raw-field-texts.js';
import { isUnrenderedField } from '../fields/unrendered.js';

const YAML_OPTIONS = {
  indent: 2,
  lineWidth: 0,             // no line wrapping
  defaultKeyType: 'PLAIN' as const,
  defaultStringType: 'PLAIN' as const,
  nullStr: '',               // null → implicit empty (bare `key:`) not `key: null`
};

/**
 * Wrap a value in [[wiki-link]] brackets.
 */
function wrapRef(value: unknown): unknown {
  if (typeof value === 'string') return `[[${value}]]`;
  return value;
}

/**
 * Wrap each element in a list in [[wiki-link]] brackets.
 */
function wrapListRef(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapRef);
  return value;
}

/**
 * Render a node's DB state to canonical markdown file content.
 *
 * The output is deterministic: same input always produces same bytes.
 * This is the invariant that makes the write lock and hash check safe.
 */
export function renderNode(input: RenderInput): string {
  const {
    types,
    fields,
    body,
    fieldOrdering,
    referenceFields,
    listReferenceFields,
    orphanRawValues,
    explicitNullFields,
    keptFields,
  } = input;

  // Build frontmatter object with insertion-order keys
  const fm = createFieldMap<unknown>();

  // types always first, under the designated key (`types` unless VAULT_TYPE_KEY names
  // another) — non-empty as block sequence, empty as implicit null.
  // Empty arrays serialize as flow-notation `types: []` which Obsidian
  // can't edit: adding items produces `types: []\n  - x` (invalid YAML).
  // Implicit null (`types:`) lets Obsidian append `\n  - person` cleanly.
  fm[typeKey()] = types.length > 0 ? types : null;

  // Fields kept as they are in the file (#501) get a placeholder value here; their
  // own lines replace its line once the frontmatter is serialized.
  const placeholders: KeptPlaceholder[] = [];

  // Fields in ordering. Unrendered fields (wiki build fingerprints, #547) stay in the
  // database only.
  for (const entry of fieldOrdering) {
    const { field, category } = entry;
    if (isUnrenderedField(field)) continue;
    const kept = keptFields?.get(field);
    if (kept !== undefined) {
      if (kept.text === null) {
        fm[field] = kept.raw;
      } else {
        const token = `ve-kept-field-${placeholders.length}-end`;
        placeholders.push({ field, token, kept });
        fm[field] = token;
      }
      continue;
    }
    const value = Object.hasOwn(fields, field) ? fields[field] : undefined;

    // Null values are omitted from frontmatter. An unclaimed key the note
    // holds empty (`key:`) keeps its place; claimed ones follow at the end.
    if (value === null || value === undefined) {
      if (category === 'orphan' && explicitNullFields.has(field)) fm[field] = null;
      continue;
    }

    if (category === 'orphan' && Object.hasOwn(orphanRawValues, field)) {
      // Orphan with raw text — use verbatim for wiki-link preservation
      // A list's or a map's raw text is JSON; a map's is read as one only beside a map value (#667).
      fm[field] = renderedRawText(orphanRawValues[field], value);
    } else if (referenceFields.has(field)) {
      fm[field] = wrapRef(value);
    } else if (listReferenceFields.has(field)) {
      fm[field] = wrapListRef(value);
    } else {
      fm[field] = value;
    }
  }

  for (const field of [...explicitNullFields].sort()) {
    if (!Object.hasOwn(fm, field) && !isUnrenderedField(field)) fm[field] = null;
  }

  // Serialize YAML
  const yamlStr = placeholders.length === 0 ? stringify(fm, YAML_OPTIONS) : withKeptLines(fm, placeholders);

  // Build file content: ---\n{yaml}---\n{body}
  if (body === '') {
    return `---\n${yamlStr}---\n`;
  }
  return `---\n${yamlStr}---\n${body}`;
}

interface KeptPlaceholder {
  field: string;
  token: string;
  kept: KeptFieldText;
}

/**
 * Serialize `fm`, then put each kept field's own lines where its placeholder line is.
 * The result must read back as the same data with each kept field's value as the file
 * had it; when it does not (a kept line that needs context it no longer has, such as an
 * alias to an anchor elsewhere), each kept field is written from its value instead.
 */
function withKeptLines(fm: Record<string, unknown>, placeholders: readonly KeptPlaceholder[]): string {
  const withPlaceholders = stringify(fm, YAML_OPTIONS);
  const lines = withPlaceholders.split('\n');
  let spliced = true;
  for (const { token, kept } of placeholders) {
    const index = lines.findIndex(line => !line.startsWith(' ') && line.endsWith(`: ${token}`));
    if (withPlaceholders.split(token).length !== 2 || index === -1) {
      spliced = false;
      break;
    }
    lines[index] = kept.text!;
  }
  if (spliced) {
    const result = lines.join('\n');
    const expected = parseDocument(withPlaceholders, { uniqueKeys: false }).toJS() as Record<string, unknown>;
    for (const { field, kept } of placeholders) expected[field] = kept.raw;
    if (readsBackAs(result, expected)) return result;
  }
  const values = createFieldMap(fm);
  for (const { field, kept } of placeholders) values[field] = kept.raw;
  return stringify(values, YAML_OPTIONS);
}

function readsBackAs(yaml: string, expected: Record<string, unknown>): boolean {
  const doc = parseDocument(yaml, { uniqueKeys: false });
  if (doc.errors.length > 0) return false;
  try {
    return isDeepStrictEqual(doc.toJS(), expected);
  } catch {
    // An alias whose anchor is not in the render.
    return false;
  }
}
