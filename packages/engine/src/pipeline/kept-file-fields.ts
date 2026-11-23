// src/pipeline/kept-file-fields.ts
//
// Typed text a re-render keeps (#501). The watcher stores no value for a field
// whose typed value fails validation, or keeps the value the database already
// held, and logs `value-rejected`; the file still shows what was typed. Every
// later Engine write renders the note from the database, which used to take
// the typed text out of the file. A render now writes that field's lines back
// as they are in the file, while the database keeps what the watcher left.

import { isDeepStrictEqual } from 'node:util';
import { parseDocument, isMap, isScalar } from 'yaml';
import { cleanFieldValue, splitFrontmatter } from '../parser/frontmatter.js';
import type { YamlValue } from '../parser/types.js';
import { typeKey } from '../parser/type-key.js';
import { validateEffectiveFieldValue } from '../validation/validate.js';
import type { EffectiveFieldSet } from '../validation/types.js';

/** A top-level frontmatter field of a note's file. */
export interface FileField {
  name: string;
  /** The value as YAML reads it, wiki-link brackets included. */
  raw: unknown;
  /** The value as the watcher validates and stores it: wiki-link brackets stripped. */
  value: unknown;
  /** The field's own lines in the file, key and any comment on its last line included,
   * without the final line break; null when they cannot be cut out on whole lines. */
  text: string | null;
}

/**
 * The top-level fields of a note's frontmatter, in file order (a key held twice
 * counts once, with its last value, as the parser reads it). Empty when there
 * is no content, no frontmatter, or frontmatter that does not parse as a mapping.
 */
export function readFileFields(content: string | null): FileField[] {
  if (content === null) return [];
  const { yaml } = splitFrontmatter(content);
  if (yaml === null) return [];
  const doc = parseDocument(yaml, { uniqueKeys: false });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
  let data: Record<string, unknown> | null;
  try {
    data = doc.toJS() as Record<string, unknown> | null;
  } catch {
    // An alias without its anchor: the parser fails on it too.
    return [];
  }
  if (data === null || typeof data !== 'object') return [];

  const fields = new Map<string, FileField>();
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) continue;
    const name = String(pair.key.value);
    if (!Object.hasOwn(data, name)) continue;
    const raw = data[name];
    fields.delete(name);
    fields.set(name, {
      name,
      raw,
      value: cleanFieldValue(raw as YamlValue),
      text: doc.contents.flow ? null : pairText(yaml, pair.key.range, (pair.value as { range?: [number, number, number] } | null)?.range),
    });
  }
  return [...fields.values()];
}

/** The whole lines a block-mapping pair spans, from its key to the end of its value's last line. */
function pairText(
  yaml: string,
  keyRange: [number, number, number] | null | undefined,
  valueRange: [number, number, number] | null | undefined,
): string | null {
  if (!keyRange) return null;
  const start = keyRange[0];
  // A key that does not start its line (an indented mapping, a key with an anchor) is not cut out.
  if (start !== 0 && yaml[start - 1] !== '\n') return null;
  let end = valueRange ? valueRange[1] : keyRange[1];
  while (end > start && (yaml[end - 1] === '\n' || yaml[end - 1] === '\r')) end--;
  const lineEnd = yaml.indexOf('\n', end);
  // The renderer writes LF line endings, so a CRLF file's lines lose their CR.
  return yaml.slice(start, lineEnd === -1 ? yaml.length : lineEnd).replace(/\r(?=\n|$)/g, '');
}

export interface KeepRule {
  /** What the write stores, by field (absent: no value). */
  stored: Readonly<Record<string, unknown>>;
  /** What was stored before the write. Given, a field whose stored value the write changes
   * without naming it keeps nothing from the file; omitted (undo), no comparison is made. */
  before?: Readonly<Record<string, unknown>>;
  /** Fields the write names, set or cleared: their file text is replaced. */
  touched: Iterable<string>;
  /** Fields the write stores as an explicit null. */
  explicitNull: ReadonlySet<string>;
  /** Fields the write fills with their default: filling a default is not setting the field. */
  defaulted?: ReadonlySet<string>;
  /** The definitions a field's file value is checked against, as the watcher checks it. */
  effectiveFields: EffectiveFieldSet;
  /** The file is the one the database last read or wrote, so a field it holds that the
   * database stores no value for was not taken by the watcher: keep its text even when it
   * would pass validation now (a definition loosened, a claim removed, a type removed). */
  keepUnstored: boolean;
}

/**
 * The file fields a re-render writes back as they are in the file: values the watcher
 * did not take that the write leaves alone. A field is kept when the write does not name
 * it or change its stored value, the database does not hold the file's value as given,
 * and the file's value fails validation, or the database holds no value for it and
 * `keepUnstored` is set. The type key is never a field, and an empty value is the
 * explicit-null rule's.
 */
export function keptFileFields(fileFields: readonly FileField[], rule: KeepRule): Map<string, FileField> {
  const kept = new Map<string, FileField>();
  if (fileFields.length === 0) return kept;
  const key = typeKey();
  const touched = new Set(rule.touched);
  for (const field of fileFields) {
    const { name, value } = field;
    if (name === key || value === null || value === undefined) continue;
    if (touched.has(name) || rule.explicitNull.has(name)) continue;
    const storedValue = Object.hasOwn(rule.stored, name) ? rule.stored[name] : undefined;
    if (rule.before !== undefined && !rule.defaulted?.has(name)) {
      const beforeValue = Object.hasOwn(rule.before, name) ? rule.before[name] : undefined;
      if (!isDeepStrictEqual(beforeValue, storedValue)) continue;
    }
    if (storedValue !== undefined && storedValue !== null && isDeepStrictEqual(storedValue, value)) continue;
    const unstored = storedValue === undefined || storedValue === null;
    if (failsValidation(name, value, rule.effectiveFields) || (rule.keepUnstored && unstored)) {
      kept.set(name, field);
    }
  }
  return kept;
}

function failsValidation(name: string, value: unknown, effectiveFields: EffectiveFieldSet): boolean {
  const field = effectiveFields.get(name);
  return field !== undefined && !validateEffectiveFieldValue(name, value, field).ok;
}
