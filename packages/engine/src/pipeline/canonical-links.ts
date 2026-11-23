// src/pipeline/canonical-links.ts
//
// Link canonicalization for pipeline writes: wiki-links that only the engine
// can resolve (a title its filename cannot reproduce, or text that misses the
// filename by sanitization) are rewritten to name the file. See
// LinkCanonicalizer in resolver/file-link.ts for what counts as a match.

import { extname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rewriteBodyWikiLinksWith } from '../parser/wiki-links.js';
import { cleanFieldValue } from '../parser/frontmatter.js';
import { mapWrittenTexts, writtenFormOf } from '../parser/raw-field-texts.js';
import type { YamlValue } from '../parser/types.js';
import type { LinkCanonicalizer } from '../resolver/file-link.js';
import { anchoredLinkName } from '../resolver/resolve.js';
import type { GlobalFieldDefinition } from '../validation/types.js';

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * The canonical target for link text, or null to leave it. A link to a heading or block
 * (`Note#Heading`) keeps its anchor after the canonical name (#613); a canonical name never
 * holds a `#` (`LinkCanonicalizer.match`).
 */
function linkTargetFor(canonicalizer: LinkCanonicalizer, text: string, requiredType: string | null = null): string | null {
  const node = canonicalizer.match(text, requiredType);
  if (node) return canonicalizer.linkTarget(node);
  // Only a link whose whole text names no note is read as a heading link.
  const name = anchoredLinkName(text);
  const named = name === null || canonicalizer.namesAnyNote(text) ? null : canonicalizer.match(name, requiredType);
  if (!named) return null;
  // Resolvers read a link whole first: when another note is named by the canonical name plus the
  // anchor, the vault path with `.md` names this one instead; failing that, leave the link alone.
  const anchor = text.slice(text.indexOf('#'));
  for (const replacement of [canonicalizer.linkTarget(named) + anchor, named.file_path + anchor]) {
    if (!canonicalizer.namesAnyNote(replacement)) return replacement;
  }
  return null;
}

/**
 * `[[text]]` → `[[name|text]]` and `[[text|alias]]` → `[[name|alias]]`,
 * so the link resolves by filename while reading exactly as written.
 */
export function canonicalizeBodyLinks(body: string, canonicalizer: LinkCanonicalizer): string {
  const names = new Map<string, string | null>();
  const nameFor = (target: string) => {
    if (!names.has(target)) names.set(target, linkTargetFor(canonicalizer, target));
    return names.get(target)!;
  };
  // Cheap pre-pass over the raw text: most bodies need no rewrite, and only a
  // body that does pays for the AST walk (which also skips code spans and
  // decodes targets). Text with an entity or escape may decode to a match.
  const mayNeedRewrite = [...body.matchAll(WIKILINK_PATTERN)]
    .some(match => /[&\\]/.test(match[1]) || nameFor(match[1]) !== null);
  if (!mayNeedRewrite) return body;

  return rewriteBodyWikiLinksWith(body, ({ target, written, embed, inTableCell }) => {
    const name = nameFor(target);
    if (name === null) return null;
    const alias = written.alias;
    // A bare `|` would end a GFM table cell; there the separator is escaped.
    const separator = inTableCell ? '\\|' : '|';
    if (embed) {
      // Embed resolution reads any other extension as an attachment's, so a
      // dotted note name (`Report.v2`) keeps its `.md`. The alias half of an
      // embed is a size or caption, not the link's text.
      const hash = name.indexOf('#');
      const note = hash < 0 ? name : name.slice(0, hash);
      const anchor = hash < 0 ? '' : name.slice(hash);
      const ref = (extname(note) !== '' && !note.endsWith('.md') ? `${note}.md` : note) + anchor;
      return alias === null ? `[[${ref}]]` : `[[${ref}${separator}${alias}]]`;
    }
    // The display half carries the text over as written (entities intact).
    return `[[${name}${separator}${alias ?? written.target}]]`;
  });
}

/**
 * Reference-field values are bare link targets rendered as `[[value]]`, so the
 * canonical form is the link target itself. Under typed resolution (policy v2)
 * a field's `reference_target` must hold for the match. A field rendered from
 * retained raw text is left to canonicalizeExplicitFieldLinks. Mutates `fields`.
 */
export function canonicalizeReferenceFields(
  fields: Record<string, unknown>,
  definitions: ReadonlyMap<string, GlobalFieldDefinition>,
  canonicalizer: LinkCanonicalizer,
  typed: boolean,
  rawTexts: Readonly<Record<string, string>> = {},
): void {
  for (const [name, value] of Object.entries(fields)) {
    const gf = definitions.get(name);
    if (!gf || Object.hasOwn(rawTexts, name)) continue;
    const requiredType = typed ? gf.reference_target : null;
    const canonical = (item: unknown): unknown =>
      typeof item === 'string' ? linkTargetFor(canonicalizer, item, requiredType) ?? item : item;
    if (gf.field_type === 'reference') {
      fields[name] = canonical(value);
    } else if (gf.field_type === 'list' && gf.list_item_type === 'reference' && Array.isArray(value)) {
      fields[name] = value.map(canonical);
    }
  }
}

/**
 * Explicit wiki-links in non-reference fields — unclaimed (orphan) fields and
 * claimed text/list fields alike — and in the retained raw text of unclaimed
 * reference fields (`requiredTypes` holds their v2 targets). Indexed orphan
 * values keep their links in
 * `rawTexts` (value = links reduced to targets); tool-written values carry the
 * brackets themselves. A raw text that no longer describes the value is left
 * alone. Mutates `fields` and `rawTexts`; returns the fields whose raw text
 * changed.
 */
export function canonicalizeExplicitFieldLinks(
  fields: Record<string, unknown>,
  rawTexts: Record<string, string>,
  linkFields: readonly string[],
  canonicalizer: LinkCanonicalizer,
  requiredTypes: ReadonlyMap<string, string | null> = new Map(),
): string[] {
  const changedRaw: string[] = [];
  for (const field of linkFields) {
    const requiredType = requiredTypes.get(field) ?? null;
    const rewrite = (text: string) => text.replace(WIKILINK_PATTERN, (link, target: string, alias: string | undefined) => {
      const name = linkTargetFor(canonicalizer, target, requiredType);
      return name === null ? link : `[[${name}${alias === undefined ? '' : `|${alias}`}]]`;
    });
    const raw = rawTexts[field];
    if (raw !== undefined) {
      // The raw text as the written form of the value it is stored beside: a list or a map as
      // decoded JSON, so each text is rewritten on its own and a name with a quote in it stays
      // valid JSON; a text as itself, even one that looks like JSON (#667).
      const written = writtenFormOf(raw, fields[field]);
      if (written === null) continue;
      const next = mapWrittenTexts(written, rewrite);
      if (isDeepStrictEqual(next, written)) continue;
      rawTexts[field] = typeof next === 'string' ? next : JSON.stringify(next);
      fields[field] = cleanFieldValue(next as YamlValue);
      changedRaw.push(field);
    } else {
      const value = fields[field];
      const canonical = (item: unknown) => typeof item === 'string' ? rewrite(item) : item;
      fields[field] = Array.isArray(value) ? value.map(canonical) : canonical(value);
    }
  }
  return changedRaw;
}
