import type Database from 'better-sqlite3';
import type { VaultSettings } from '@vault/settings-registry';
import { missingLinkKey } from '../mcp/link-counts.js';
import { userNotesWhere } from '../notes/user-notes.js';
import { LinkCanonicalizer } from '../resolver/file-link.js';
import { linkKey, loadAliases } from '../resolver/near-miss.js';
import { buildReferenceCatalog, resolveRelationship } from '../resolver/relationship-policy.js';
import { resolveFilename } from '../schema/paths.js';
import { getVaultSettings } from '../settings/vault.js';

/**
 * Names with no note (#645): the people, companies and other things that notes name but that
 * have no note of their own, most-named first. Read-only and stateless. Creating the notes stays
 * with the caller.
 *
 * A name comes from two places:
 *
 * - **A link that resolves to nothing**, in a note's text or in a field. This is what the
 *   clean-up report's `missing-notes` row counts, and both read `scanMissingNames`.
 * - **Plain text in the people field or the company field** of the vault map: `Dana Whitfield`
 *   where a link would be `[[Dana Whitfield]]`. A pile of exported notes names most people this
 *   way. Only the tool reads these, and only those two fields: any other field's text is not
 *   known to hold names.
 *
 * Names in a note's running text are not read: telling a name from other words needs a model,
 * and the link sweep (#332) covers mentions of notes that already exist.
 *
 * A name is missing only when no note answers to it with no kind required. Under the typed
 * reference policy a field's link also stays unresolved when its name matches two notes, or a
 * note of another kind than the field takes; creating a note for one of those would add a
 * duplicate, so neither is listed.
 */

export const MISSING_LIMITS = {
  defaultNames: 50,
  maxNames: 200,
  /** Notes shown per name. */
  examples: 3,
  /** Other spellings shown per name. */
  spellings: 10,
  /** A plain value longer than this is a sentence, not a name. */
  maxNameChars: 100,
} as const;

export class MissingNotesError extends Error {
  override readonly name = 'MissingNotesError';
  constructor(readonly code: 'INVALID_PARAMS', message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export interface MissingRequest {
  /** Only names written in one of these fields, as a link or as plain text. */
  fields?: string[];
  /** Only names at least this many notes name (default 1). */
  min_notes?: number;
  limit?: number;
  offset?: number;
}

export interface MissingNameField {
  field: string;
  /** Notes that name it in this field as a link, and as plain text. */
  links: number;
  plain_text: number;
}

export interface MissingName {
  name: string;
  /** Other ways notes write it (case, separators, `.md`, a folder). */
  other_spellings: string[];
  /** Notes that name it. */
  notes: number;
  /** Of those, the notes that link to it from their text. */
  body_links: number;
  /** The fields that name it. */
  fields: MissingNameField[];
  /** The kind its note would most likely be, from the fields that name it; null when they do not say or disagree. */
  likely_type: string | null;
  /** The newest notes that name it. */
  examples: Array<{ id: string; title: string; path: string }>;
  /**
   * A note that already answers to the name by an alias or a near spelling (`A: B` for the file
   * `A - B`), which no link resolves by. The name needs no new note: its links and values need
   * rewriting to this one.
   */
  existing_note?: { id: string; title: string; path: string };
  /** create-node arguments for its note. Left out when `existing_note` is set. */
  create?: { title: string; directory?: string; override_default_directory?: true; types?: string[] };
  /** Set when `create` is left out, or leaves `likely_type` out: why, and what to do. */
  create_note?: string;
}

export interface PlainTextField {
  field: string;
  role: 'people' | 'company';
  /** Names written as plain text here that no note answers to. They are in the listing. */
  missing: number;
  /** Names written as plain text here that a note does answer to. Not listed: nothing is missing, but the value is not a link. */
  with_a_note: number;
}

export interface MissingResult {
  scope: {
    /** The user's notes. */
    notes: number;
    /** The vault map's people and company fields, whose plain text was read for names. */
    plain_text_fields: PlainTextField[];
  };
  /** Names with no note, and the notes that name one. */
  total_names: number;
  total_notes: number;
  offset: number;
  /** Most-named first. */
  names: MissingName[];
}

/**
 * The note a missing name stands for, as create-node arguments. A name written as a path
 * (`People/Dana`) needs its folder: created as a title, the `/` would be replaced and a link
 * written that way would still not resolve.
 */
export function noteForName(name: string): { title: string; directory?: string; override_default_directory?: true } {
  const path = name.endsWith('.md') ? name.slice(0, -3) : name;
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { title: path } : { title: path.slice(slash + 1), directory: path.slice(0, slash), override_default_directory: true };
}

interface FieldUse { links: Set<string>; plain: Set<string> }

export interface MissingEntry {
  /** The spelling that sorts first, so it does not depend on the order notes were read in. */
  name: string;
  spellings: Set<string>;
  /** Notes that name it. */
  sources: Set<string>;
  /** Notes that link to it from their text. */
  body: Set<string>;
  fields: Map<string, FieldUse>;
}

export interface MissingScan {
  /** By folded spelling (`missingLinkKey`). */
  entries: Map<string, MissingEntry>;
  /** Every note that names a missing note; those found through links come first, newest first. */
  sources: Set<string>;
  /** When each of those notes' files last changed. */
  modified: Map<string, number>;
  plainTextFields: PlainTextField[];
}

interface Context { vault: VaultSettings; settingsDir: string | undefined }

const NEWEST_FIRST = 'ORDER BY n.file_mtime DESC, n.id';
/** The rel_type of a link in a note's text. Any other is the field the link is in; a field of this very name is told apart by its context. */
const BODY_LINK = 'wiki-link';

/** The designated fields whose plain text holds names, each with what it names. One field can be both. */
function plainTextRoles(vault: VaultSettings): Map<string, Array<'people' | 'company'>> {
  const roles = new Map<string, Array<'people' | 'company'>>();
  if (vault.peopleField !== null) roles.set(vault.peopleField, ['people']);
  if (vault.companyField !== null) roles.set(vault.companyField, [...(roles.get(vault.companyField) ?? []), 'company']);
  return roles;
}

/**
 * A people value split on commas and semicolons, with the note's own links in it kept whole.
 * Several links in one value are stored with their brackets stripped and the text between them
 * kept, so `[[Whitfield, Dana]], [[Lee Okafor]]` reads as "Whitfield, Dana, Lee Okafor": a
 * link's target is taken as one name wherever it starts a name and ends one.
 */
function splitNames(text: string, linked: readonly string[]): string[] {
  const targets = linked.filter(target => target !== '').sort((a, b) => b.length - a.length);
  const names: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (/[\s,;]/.test(text[at]!)) { at += 1; continue; }
    const link = targets.find(target => text.startsWith(target, at) && /^\s*([,;]|$)/.test(text.slice(at + target.length)));
    const next = text.slice(at).search(/[,;]/);
    const end = link !== undefined ? at + link.length : next === -1 ? text.length : at + next;
    names.push(text.slice(at, end));
    at = end;
  }
  return names;
}

/**
 * The names a stored field value holds. A list's items are names as written. One string in a
 * people field is split on commas and semicolons ("Dana Whitfield, Lee Okafor"), unless the
 * string as a whole is one name already (`whole`): a link's target is stored with its brackets
 * stripped, so `[[Whitfield, Dana]]` reads here as "Whitfield, Dana". A company's name can hold
 * a comma, so a company field's string is one name.
 */
function namesIn(
  text: string | null, json: string | null, split: boolean,
  whole: (name: string) => boolean, linked: readonly string[],
): string[] {
  let items: unknown[] = [];
  if (text !== null) {
    items = split && !whole(text.trim()) ? splitNames(text, linked) : [text];
  } else if (json !== null) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      return [];
    }
  }
  const names: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    // A link is read from the relationships; a long value or one over several lines is prose.
    if (name === '' || name.length > MISSING_LIMITS.maxNameChars || name.includes('\n') || name.includes('[[') || name.includes(']]')) continue;
    names.push(name);
  }
  return names;
}

/**
 * The key a plain-text name folds by. A link's key (`missingLinkKey`) is none for a target that
 * looks like an attachment (`diagram.png`); a value in the company field is a name whatever it
 * ends in (`Northwind.ai`), so that rule is not applied here.
 */
function plainNameKey(name: string): string | null {
  const key = linkKey(name);
  return key === '' ? null : key;
}

/**
 * Every name the user's notes give that no note answers to. `plainText: false` reads links
 * only, which is what the clean-up report's row counts.
 */
export function scanMissingNames(
  db: Database.Database, context: Context,
  options: { plainText: boolean; knownAs?: (name: string) => unknown },
): MissingScan {
  const user = userNotesWhere(context);
  const unresolved = db.prepare(
    `SELECT r.source_id AS source, r.target, r.rel_type AS rel, r.context, n.file_mtime AS mtime FROM relationships r JOIN nodes n ON n.id = r.source_id
     WHERE ${user.sql} AND r.resolved_target_id IS NULL ${NEWEST_FIRST}, r.target`,
  ).all(...user.params) as Array<{ source: string; target: string; rel: string; context: string | null; mtime: number | null }>;

  let catalog: ReturnType<typeof buildReferenceCatalog> | null = null;
  const anyKind = { origin: 'body', field: null, requiredType: null } as const;
  const answered = new Map<string, boolean>();
  const noteExists = (target: string): boolean => {
    let found = answered.get(target);
    if (found === undefined) {
      catalog ??= buildReferenceCatalog(db);
      found = resolveRelationship(catalog, { rawTarget: target, context: anyKind }, 1).status === 'resolved';
      answered.set(target, found);
    }
    return found;
  };

  const entries = new Map<string, MissingEntry>();
  const sources = new Set<string>();
  const modified = new Map<string, number>();
  const entryFor = (key: string, name: string): MissingEntry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { name, spellings: new Set(), sources: new Set(), body: new Set(), fields: new Map() };
      entries.set(key, entry);
    } else if (name < entry.name) {
      entry.name = name;
    }
    entry.spellings.add(name);
    return entry;
  };
  const useOf = (entry: MissingEntry, field: string): FieldUse => {
    let use = entry.fields.get(field);
    if (!use) {
      use = { links: new Set(), plain: new Set() };
      entry.fields.set(field, use);
    }
    return use;
  };
  const named = (entry: MissingEntry, source: string, mtime: number | null): void => {
    entry.sources.add(source);
    sources.add(source);
    modified.set(source, mtime ?? 0);
  };

  for (const link of unresolved) {
    const key = missingLinkKey(link.target);
    if (key === null || noteExists(link.target)) continue;
    const entry = entryFor(key, link.target.split('#')[0]!.trim());
    // A field's link carries the field's name as its context too; a link in the text carries its paragraph.
    if (link.rel === BODY_LINK && link.context !== BODY_LINK) entry.body.add(link.source);
    else useOf(entry, link.rel).links.add(link.source);
    named(entry, link.source, link.mtime);
  }

  const plainTextFields: PlainTextField[] = [];
  if (options.plainText) {
    // What each note links to from the field, by folded spelling: a value that is one of them is a link, read above or bound to a note.
    const linkedBy = db.prepare<[string], { source: string; target: string }>(
      'SELECT r.source_id AS source, r.target FROM relationships r WHERE r.rel_type = ?',
    );
    const values = db.prepare<string[], { source: string; text: string | null; json: string | null; mtime: number | null }>(
      `SELECT f.node_id AS source, f.value_text AS text, f.value_json AS json, n.file_mtime AS mtime FROM node_fields f JOIN nodes n ON n.id = f.node_id
       WHERE ${user.sql} AND f.field_name = ? ${NEWEST_FIRST}`,
    );
    for (const [field, roles] of plainTextRoles(context.vault)) {
      const linked = new Map<string, Set<string>>();
      const linkedTexts = new Map<string, string[]>();
      for (const row of linkedBy.iterate(field)) {
        // The stored value is the link's whole target, anchor included (`Dana Whitfield#Role`);
        // the name before the anchor is kept too, for a value written without it.
        for (const text of [row.target, row.target.split('#')[0]!]) {
          const key = plainNameKey(text);
          if (key === null) continue;
          let keys = linked.get(row.source);
          if (!keys) linked.set(row.source, keys = new Set());
          keys.add(key);
        }
        const texts = linkedTexts.get(row.source);
        if (texts) texts.push(row.target);
        else linkedTexts.set(row.source, [row.target]);
      }
      const missing = new Set<string>();
      const withNote = new Set<string>();
      for (const row of values.iterate(...user.params, field)) {
        const own = linked.get(row.source);
        // One name already: the note's own link in this field, or text a note answers to as it
        // stands, by its name or by an alias ("Whitfield, Dana" as an alias of Dana Whitfield).
        const whole = (name: string): boolean => {
          const key = plainNameKey(name);
          return key !== null && (own?.has(key) === true || noteExists(name) || (options.knownAs?.(name) ?? null) !== null);
        };
        for (const name of namesIn(row.text, row.json, roles.includes('people'), whole, linkedTexts.get(row.source) ?? [])) {
          const key = plainNameKey(name);
          if (key === null || own?.has(key)) continue;
          if (noteExists(name)) {
            withNote.add(key);
            continue;
          }
          missing.add(key);
          const entry = entryFor(key, name);
          useOf(entry, field).plain.add(row.source);
          named(entry, row.source, row.mtime);
        }
      }
      for (const role of roles) plainTextFields.push({ field, role, missing: missing.size, with_a_note: withNote.size });
    }
  }
  return { entries, sources, modified, plainTextFields };
}

/** Most-named first, then by name. */
export function rankMissing(entries: Iterable<MissingEntry>): MissingEntry[] {
  return [...entries].sort((a, b) => b.sources.size - a.sources.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function unknownFields(db: Database.Database, fields: readonly string[]): string[] {
  const known = db.prepare<[string, string, string], { found: number }>(
    `SELECT EXISTS (SELECT 1 FROM global_fields WHERE name = ?) OR EXISTS (SELECT 1 FROM node_fields WHERE field_name = ?)
       OR EXISTS (SELECT 1 FROM relationships WHERE rel_type = ?) AS found`,
  );
  return fields.filter(field => known.get(field, field, field)?.found !== 1);
}

/** The kind each field says its values are: a reference field's target kind, else the vault map's person or company kind. */
function kindsByField(db: Database.Database, vault: VaultSettings): (field: string) => string | null {
  const targets = new Map<string, string>();
  const rows = db.prepare('SELECT name, reference_target AS target FROM global_fields WHERE reference_target IS NOT NULL').all() as Array<{ name: string; target: string }>;
  for (const row of rows) targets.set(row.name, row.target);
  return (field) => targets.get(field)
    ?? (field === vault.peopleField && field !== vault.companyField ? vault.personType : null)
    ?? (field === vault.companyField && field !== vault.peopleField ? vault.companyType : null);
}

/**
 * Why `create` cannot offer a kind, or null when it can: create-node must accept the arguments,
 * and the note it makes must answer to the name.
 *
 * - A kind with no schema is refused by create-node. A fresh export has plain people and
 *   company fields long before it has a person or company kind.
 * - A kind's filename template (`Contact - {title}.md`) names the file, and the stored title is
 *   the file's, so a note created as that kind would leave the name missing.
 */
function kindCaveat(db: Database.Database, title: string, kind: string): string | null {
  if (db.prepare('SELECT 1 FROM schemas WHERE name = ?').get(kind) === undefined) {
    return `No ${kind} kind is defined yet, so create-node would refuse it. Define the kind with create-schema and pass types: ["${kind}"], or create the note without a kind and add it later with update-node add_types.`;
  }
  const named = resolveFilename(db, { types: [kind], title, fields: {} });
  if (named.ok && linkKey(named.fileName) === linkKey(title)) return null;
  return `The ${kind} kind names its files by a template, so a note created as that kind would not answer to this name. Create it without a kind, then add the kind with update-node add_types.`;
}

/**
 * The one note that has a plain-text name as an alias, for a name that ends like a file name.
 * Link repair never takes an alias for such a target (`![[report.pdf]]` names an attachment),
 * so `LinkCanonicalizer.match` finds none; a value in the company field is a name whatever it
 * ends in, and `Northwind.ai` may be a note's alias.
 */
function aliasOwners(db: Database.Database): (name: string) => { id: string; file_path: string; title: string | null } | null {
  let owners: Map<string, Set<string>> | null = null;
  const note = db.prepare<[string], { id: string; file_path: string; title: string | null }>('SELECT id, file_path, title FROM nodes WHERE id = ?');
  return (name) => {
    if (!/\.[A-Za-z0-9]+$/.test(name.trim())) return null;
    if (owners === null) {
      owners = new Map();
      for (const [id, aliases] of loadAliases(db)) {
        for (const alias of aliases) {
          const key = linkKey(alias);
          if (key === '') continue;
          let ids = owners.get(key);
          if (!ids) owners.set(key, ids = new Set());
          ids.add(id);
        }
      }
    }
    const ids = owners.get(linkKey(name));
    return ids?.size === 1 ? note.get([...ids][0]!) ?? null : null;
  };
}

/**
 * The note a missing name already belongs to, by an alias or a near spelling: no resolver takes
 * those, so the name is listed, and this says whose it is.
 */
function otherNames(db: Database.Database): (name: string) => { id: string; file_path: string; title: string | null } | null {
  let nearby: LinkCanonicalizer | null = null;
  const aliasOwner = aliasOwners(db);
  return name => (nearby ??= new LinkCanonicalizer(db)).match(name) ?? aliasOwner(name);
}

export function findMissingNotes(db: Database.Database, request: MissingRequest, options: { settingsDir?: string } = {}): MissingResult {
  const vault = getVaultSettings(db);
  const context: Context = { vault, settingsDir: options.settingsDir };
  if (request.fields && request.fields.length > 0) {
    const unknown = unknownFields(db, request.fields);
    if (unknown.length > 0) {
      throw new MissingNotesError('INVALID_PARAMS', `fields: no note has the field ${unknown.map(field => `"${field}"`).join(', ')}. list-global-fields shows the defined fields.`, { unknown_fields: unknown });
    }
  }
  const knownAs = otherNames(db);
  const scan = scanMissingNames(db, context, { plainText: true, knownAs });
  const wanted = request.fields && request.fields.length > 0 ? new Set(request.fields) : null;
  const atLeast = request.min_notes ?? 1;
  const ranked = rankMissing(scan.entries.values()).filter(entry =>
    entry.sources.size >= atLeast && (wanted === null || [...entry.fields.keys()].some(field => wanted.has(field))));

  const offset = request.offset ?? 0;
  const page = ranked.slice(offset, offset + (request.limit ?? MISSING_LIMITS.defaultNames));
  const namedBy = new Set<string>();
  for (const entry of ranked) for (const source of entry.sources) namedBy.add(source);

  const newest = (ids: Iterable<string>): string[] => [...ids]
    .sort((a, b) => (scan.modified.get(b) ?? 0) - (scan.modified.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MISSING_LIMITS.examples);
  const shown = new Map<string, string[]>();
  for (const entry of page) shown.set(entry.name, newest(entry.sources));
  const note = db.prepare<[string], { id: string; title: string | null; path: string }>('SELECT id, title, file_path AS path FROM nodes WHERE id = ?');
  const kindOf = kindsByField(db, vault);
  const user = userNotesWhere(context);
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM nodes n WHERE ${user.sql}`).get(...user.params) as { count: number }).count;

  return {
    scope: { notes: total, plain_text_fields: scan.plainTextFields },
    total_names: ranked.length,
    total_notes: namedBy.size,
    offset,
    names: page.map((entry) => {
      const fields = [...entry.fields.entries()]
        .map(([field, use]) => ({ field, links: use.links.size, plain_text: use.plain.size }))
        .sort((a, b) => (b.links + b.plain_text) - (a.links + a.plain_text) || (a.field < b.field ? -1 : 1));
      const kinds = new Set<string>();
      for (const { field } of fields) {
        const kind = kindOf(field);
        if (kind !== null) kinds.add(kind);
      }
      const likely = kinds.size === 1 ? [...kinds][0]! : null;
      const known = knownAs(entry.name);
      // A name only ever written as plain text is a title as it stands: `AC/DC` names no folder.
      const create = entry.body.size > 0 || fields.some(field => field.links > 0) ? noteForName(entry.name) : { title: entry.name };
      const caveat = known !== null
        ? `"${known.title ?? known.file_path}" already answers to this name by an alias or a near spelling. Rewrite the links and values to name it (update-node) instead of creating a note.`
        : likely === null ? null : kindCaveat(db, create.title, likely);
      return {
        name: entry.name,
        other_spellings: [...entry.spellings].filter(spelling => spelling !== entry.name).sort().slice(0, MISSING_LIMITS.spellings),
        notes: entry.sources.size,
        body_links: entry.body.size,
        fields,
        likely_type: likely,
        examples: shown.get(entry.name)!.flatMap((id) => {
          const row = note.get(id);
          return row ? [{ id: row.id, title: row.title ?? '', path: row.path }] : [];
        }),
        ...(known === null
          ? { create: { ...create, ...(likely !== null && caveat === null ? { types: [likely] } : {}) } }
          : { existing_note: { id: known.id, title: known.title ?? '', path: known.file_path } }),
        ...(caveat === null ? {} : { create_note: caveat }),
      };
    }),
  };
}
