/**
 * Frontmatter parsing and wiki-link extraction from YAML values.
 *
 * Uses the `yaml` package directly (no gray-matter).
 */

import { parse as parseYaml } from 'yaml';
import type { YamlRecord, YamlValue, WikiLink } from './types.js';
import { typeKey } from './type-key.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface FrontmatterResult {
  types: string[];
  fields: Map<string, YamlValue>;
  wikiLinks: WikiLink[];
  body: string;
  parseError: string | null;
}

export interface ParsedFrontmatterMapping {
  hasFrontmatter: boolean;
  data: YamlRecord;
  body: string;
  parseError: string | null;
}

const BOM = '\uFEFF';

/**
 * Split raw markdown into frontmatter YAML string and body.
 * Returns null for yaml if no frontmatter block is found.
 *
 * Accepts a leading UTF-8 byte-order mark and CRLF line endings (#261): files saved on
 * Windows, or by tools that write a BOM, otherwise lost their frontmatter or kept a stray
 * "\r" on its last value. The delimiters' own line endings are dropped, so the YAML's
 * last line and the body's start carry no stray "\r"; the body's own line endings are
 * left as written.
 */
export function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  const text = raw.startsWith(BOM) ? raw.slice(1) : raw;
  // Frontmatter must start at the very beginning of the file
  if (!text.startsWith('---')) {
    return { yaml: null, body: text };
  }

  // Find the closing --- (a line starting with it, after an LF or CRLF)
  const found = text.slice(3).search(/\r?\n---/);
  if (found === -1) {
    return { yaml: null, body: text };
  }
  const closingIndex = found + 3;
  const closingLength = text[closingIndex] === '\r' ? 5 : 4; // "\r\n---" or "\n---"

  const yamlStart = text.startsWith('---\r\n') ? 5 : 4; // skip the opening "---" and its line ending
  const yamlStr = text.slice(yamlStart, closingIndex);
  const body = text.slice(closingIndex + closingLength);

  // Strip the closing delimiter's line ending from the body
  return {
    yaml: yamlStr,
    body: body.startsWith('\r\n') ? body.slice(2) : body.startsWith('\n') ? body.slice(1) : body,
  };
}

/**
 * Parse frontmatter into its complete top-level YAML mapping.
 *
 * This intentionally does not assign any field-specific semantics; callers can
 * inspect whichever keys they need while retaining the Engine's YAML compatibility
 * rules (including duplicate-key tolerance).
 */
export function parseFrontmatterMapping(raw: string): ParsedFrontmatterMapping {
  const { yaml: yamlStr, body } = splitFrontmatter(raw);
  if (yamlStr === null) {
    return { hasFrontmatter: false, data: {}, body, parseError: null };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlStr, { uniqueKeys: false });
  } catch (error) {
    return {
      hasFrontmatter: true,
      data: {},
      body: raw,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed === null || parsed === undefined) {
    return { hasFrontmatter: true, data: {}, body, parseError: null };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      hasFrontmatter: true,
      data: {},
      body,
      parseError: 'Frontmatter is not a YAML mapping',
    };
  }
  return { hasFrontmatter: true, data: parsed as YamlRecord, body, parseError: null };
}

/**
 * Extract wiki-links from a YAML value, recursively handling strings, arrays, and objects.
 * Returns the cleaned value (brackets stripped from strings) and any wiki-links found.
 */
/** A frontmatter value as Engine validates it: wiki-link brackets stripped to the target. */
export function cleanFieldValue(value: YamlValue): YamlValue {
  return extractWikiLinksFromValue(value, '').cleaned;
}

function extractWikiLinksFromValue(
  value: YamlValue,
  fieldName: string,
): { cleaned: YamlValue; links: WikiLink[] } {
  if (typeof value === 'string') {
    const links: WikiLink[] = [];
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(value)) !== null) {
      links.push({
        target: match[1],
        alias: match[2] ?? null,
        context: fieldName,
      });
    }
    // Strip brackets from the string value, keeping canonical target (not alias)
    const cleaned = value.replace(WIKILINK_RE, (_match, target) => target);
    return { cleaned, links };
  }

  if (Array.isArray(value)) {
    // Detect YAML-parsed unquoted wikilink: [[target]] → [["target"]]
    // YAML flow notation interprets [[x]] as a nested array, not a string.
    if (
      value.length === 1 &&
      Array.isArray(value[0]) &&
      value[0].length === 1 &&
      typeof value[0][0] === 'string'
    ) {
      const target = value[0][0] as string;
      return {
        cleaned: target,
        links: [{ target, alias: null, context: fieldName }],
      };
    }

    const allLinks: WikiLink[] = [];
    const cleanedArr = value.map((item) => {
      const result = extractWikiLinksFromValue(item, fieldName);
      allLinks.push(...result.links);
      return result.cleaned;
    });
    return { cleaned: cleanedArr, links: allLinks };
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const allLinks: WikiLink[] = [];
    // Nested values retain ordinary object coercion. fromEntries creates own
    // properties safely even for __proto__, without invoking its setter.
    const cleanedObj = Object.fromEntries(Object.entries(value).map(([key, val]) => {
      const result = extractWikiLinksFromValue(val, fieldName);
      allLinks.push(...result.links);
      return [key, result.cleaned];
    }));
    return { cleaned: cleanedObj, links: allLinks };
  }

  // number, boolean, Date, null — pass through
  return { cleaned: value, links: [] };
}

/**
 * The types under the type key, whichever key it is (#445, #482). The key is never also a
 * field, so a value left out here would be gone at the next save; every value it can hold
 * as a type is kept: an unquoted `[[link]]`, which YAML reads as a one-item list in a
 * one-item list, is its target, as the Analyzer reads it; a link's `|alias` is dropped, as
 * the Analyzer drops it; a number or boolean is its text. A type held twice is one type, as
 * the Analyzer proposes it (a note's types are unique). A mapping, or a list other than a
 * link, is no type (`unkeptTypeKeyValues`).
 */
export function typeKeyValues(raw: YamlValue): string[] {
  const values = typeKeyItems(raw).flatMap((item): string[] => {
    const value = typeKeyValue(item);
    return value === null ? [] : [value];
  });
  return [...new Set(values)];
}

/**
 * The values under the type key that it cannot keep as types: a mapping, or a list other
 * than a link (an empty item holds nothing). Vault Analyzer refuses to designate a key
 * that holds one, since Engine would drop it at the next save.
 */
export function unkeptTypeKeyValues(raw: YamlValue): YamlValue[] {
  return typeKeyItems(raw).filter(item => item !== null && typeKeyValue(item) === null);
}

function typeKeyItems(raw: YamlValue): YamlValue[] {
  // `types: [[project]]` is [['project']]: the whole value is one link.
  return isNestedLink(raw) ? [raw] : Array.isArray(raw) ? raw : [raw];
}

function typeKeyValue(item: YamlValue): string | null {
  if (typeof item === 'string') {
    const link = /^\[\[(.+)\]\]$/.exec(item);
    return link ? linkTarget(link[1] as string) : item;
  }
  if (isNestedLink(item)) return linkTarget(item[0][0]);
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  return null;
}

/** A link's target: the text before `|alias`, trimmed, as the Analyzer reads it; null when empty. */
function linkTarget(inner: string): string | null {
  const bar = inner.indexOf('|');
  if (bar === -1) return inner;
  const target = inner.slice(0, bar).trim();
  return target.length > 0 ? target : null;
}

/** An unquoted `[[target]]` as YAML parses it: `[['target']]`. */
function isNestedLink(value: YamlValue): value is [[string]] {
  return Array.isArray(value) && value.length === 1
    && Array.isArray(value[0]) && value[0].length === 1 && typeof value[0][0] === 'string';
}

/**
 * Parse frontmatter and extract structured data.
 */
export function parseFrontmatter(raw: string, rawTextFields: Set<string> = new Set()): FrontmatterResult {
  const mapping = parseFrontmatterMapping(raw);

  if (mapping.parseError !== null) {
    return {
      types: [],
      fields: new Map(),
      wikiLinks: [],
      body: mapping.body,
      parseError: mapping.parseError,
    };
  }

  const data = mapping.data;
  const allLinks: WikiLink[] = [];
  const fields = new Map<string, YamlValue>();

  // Extract types, from the type key (`types` unless VAULT_TYPE_KEY names another)
  const key = typeKey();
  const types = Object.hasOwn(data, key) ? typeKeyValues(data[key]) : [];

  // Extract all other fields
  for (const [field, value] of Object.entries(data)) {
    if (field === key) continue;
    if (rawTextFields.has(field) && typeof value === 'string') {
      fields.set(field, value);
      continue;
    }
    const result = extractWikiLinksFromValue(value, field);
    allLinks.push(...result.links);
    fields.set(field, result.cleaned);
  }

  return { types, fields, wikiLinks: allLinks, body: mapping.body, parseError: null };
}
