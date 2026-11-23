// src/parser/raw-field-texts.ts
//
// The text each frontmatter field was written from, for the fields that hold a link.
//
// A field's value is stored with every link reduced to its target (`cleanFieldValue`), and a
// field no kind defines is written back from this text, so a link survives a write however it
// was written. YAML reads an unquoted link (`[[Dana W]]`) as a list holding a one-item list, so
// that form is turned back into the link's text first, wherever it stands: as the whole value,
// as an item of a list, or inside a map (#667). This follows the parser's own reading
// (`extractWikiLinksFromValue`): a value it reads a link from keeps the text of that link here.

import { isDeepStrictEqual } from 'node:util';
import { createFieldMap } from '../fields/field-map.js';
import { cleanFieldValue, parseFrontmatterMapping } from './frontmatter.js';
import type { YamlValue } from './types.js';
import { typeKey } from './type-key.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;
const WIKILINK_ALL = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** An unquoted `[[target]]`, as YAML reads it: a one-item list whose item is a one-item list of text. */
function unquotedLinkTarget(value: unknown): string | null {
  return Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 1
    && typeof value[0][0] === 'string'
    ? value[0][0]
    : null;
}

/** A value as it was written: each unquoted link turned back into its text, at any depth. */
export function writtenForm(value: unknown): unknown {
  const target = unquotedLinkTarget(value);
  if (target !== null) return `[[${target}]]`;
  if (Array.isArray(value)) return value.map(writtenForm);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    // fromEntries makes own properties, even for a key named __proto__.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, writtenForm(item)]));
  }
  return value;
}

/** Whether a written value holds a link anywhere. */
function holdsLink(value: unknown): boolean {
  if (typeof value === 'string') return WIKILINK_RE.test(value);
  if (Array.isArray(value)) return value.some(holdsLink);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) return Object.values(value).some(holdsLink);
  return false;
}

/**
 * The raw text of one field's value, or null when it holds no link. A text is kept as it is;
 * a list or a map is kept as JSON, which the renderer reads back.
 */
export function rawFieldText(value: unknown): string | null {
  const written = writtenForm(value);
  if (!holdsLink(written)) return null;
  return typeof written === 'string' ? written : JSON.stringify(written);
}

/** The raw text of every field of a note's frontmatter that holds a link (duplicate keys tolerated, as the parser reads them). */
export function extractRawFieldTexts(content: string): Record<string, string> {
  const result = createFieldMap<string>();
  const parsed = parseFrontmatterMapping(content);
  if (!parsed.hasFrontmatter || parsed.parseError !== null) return result;
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === typeKey()) continue;
    const raw = rawFieldText(value);
    if (raw !== null) result[key] = raw;
  }
  return result;
}

const isMapValue = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/** A raw text as JSON of a list or a map, or null when it is neither. */
function decodedContainer(raw: string): unknown[] | Record<string, unknown> | null {
  if (!raw.startsWith('[') && !raw.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed as unknown[] | Record<string, unknown> : null;
  } catch {
    // One unquoted link (`[[Dana W]]`) starts like a list and is not one.
    return null;
  }
}

/**
 * A raw text as the renderer writes it beside a value: a list's raw text is JSON, and so is a
 * map's, which is read as one only beside a map value, so a text that starts with `{` stays a
 * text. Anything else is the text itself.
 */
export function renderedRawText(raw: string, value: unknown): unknown {
  if (!raw.startsWith('[') && !(raw.startsWith('{') && isMapValue(value))) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * The written form a raw text holds for a stored value, or null when it does not read as that
 * value: a decoded list or map when that is what reads as the value, else the text itself. The
 * value decides, so a text that looks like JSON is still a text.
 */
export function writtenFormOf(raw: string, value: unknown): unknown {
  const decoded = decodedContainer(raw);
  if (decoded !== null && isDeepStrictEqual(cleanFieldValue(decoded as YamlValue), value)) return decoded;
  return isDeepStrictEqual(cleanFieldValue(raw), value) ? raw : null;
}

/** Whether a value holds a map, as the whole value or inside a list, at any depth. */
export function holdsMap(value: unknown): boolean {
  return isMapValue(value) || (Array.isArray(value) && value.some(holdsMap));
}

/**
 * A field's raw text with each link whose target `targets` names given its replacement, at any
 * depth (a map's texts included, #670), and the value read again from the result as the parser
 * reads it. Display text and every other link stay as written. Null when the raw text does not
 * read as the value (`writtenFormOf`), or no link changes.
 */
export function relinkedRawText(
  raw: string,
  value: unknown,
  targets: ReadonlyMap<string, string>,
): { raw: string; value: unknown } | null {
  const written = writtenFormOf(raw, value);
  if (written === null) return null;
  let changed = false;
  const next = mapWrittenTexts(written, text => text.replace(WIKILINK_ALL, (link, target: string, alias: string | undefined) => {
    const replacement = targets.get(target);
    if (replacement === undefined || replacement === target) return link;
    changed = true;
    return `[[${replacement}${alias === undefined ? '' : `|${alias}`}]]`;
  }));
  if (!changed) return null;
  return { raw: typeof next === 'string' ? next : JSON.stringify(next), value: cleanFieldValue(next as YamlValue) };
}

/** A written value with each of its texts, at any depth, passed through `rewrite`. */
export function mapWrittenTexts(written: unknown, rewrite: (text: string) => string): unknown {
  if (typeof written === 'string') return rewrite(written);
  if (Array.isArray(written)) return written.map(item => mapWrittenTexts(item, rewrite));
  if (isMapValue(written)) return Object.fromEntries(Object.entries(written).map(([key, item]) => [key, mapWrittenTexts(item, rewrite)]));
  return written;
}

/** The links of a written value, at any depth, each read from its own decoded text: target and alias. */
export function linksInWritten(written: unknown): Array<{ target: string; alias: string | null }> {
  const links: Array<{ target: string; alias: string | null }> = [];
  mapWrittenTexts(written, text => {
    for (const match of text.matchAll(WIKILINK_ALL)) links.push({ target: match[1]!, alias: match[2] ?? null });
    return text;
  });
  return links;
}

