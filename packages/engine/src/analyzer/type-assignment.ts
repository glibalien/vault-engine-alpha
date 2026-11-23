import { parseExclusions, parseRelativeDirectory } from './relative-directory.js';
import { invalidArguments, refusal, type AnalyzerResult, type FieldTypeChoice } from './report.js';
import { DEFAULT_TYPE_KEY, isEngineNoteKey } from '../parser/type-key.js';
import type { ScannedMarkdownFile } from './scan.js';
import { isApplySafeSchemaName } from './schema-name.js';
import {
  normalizeNestedWikiLinkValue,
  normalizeTypeValue,
} from './type-field-candidates.js';

export interface FolderTypeRule {
  /** Vault-relative POSIX directory; the rule covers the directory and its subdirectories. */
  directory: string;
  /** Final type name for the subtree, or null to leave it untyped. */
  type: string | null;
}

/** A tag that names a kind (#650). */
export interface TagTypeRule {
  /** The tag, as `list-inline-tags` shows it: lowercase, without the `#`. A nested tag under it matches too. */
  tag: string;
  /** Final type name for notes carrying it, or null to leave it out. */
  type: string | null;
}

export interface AnalyzeInput {
  root: string;
  /** Exact frontmatter key that names each document's types. */
  typeField?: string;
  /**
   * The frontmatter key Engine will keep types in (its `VAULT_TYPE_KEY`); `types` when
   * omitted. Documents typed by another source must not already hold a value there.
   */
  typeKey?: string;
  /** The deepest matching rule types a document that has no usable type-field value. */
  folderRules?: FolderTypeRule[];
  /**
   * A document with no usable type-field value and a tag one of these names gets that tag's
   * type, every such tag's: a tag the note itself carries wins over its folder (#650).
   */
  tagRules?: TagTypeRule[];
  /** Normalized type-field value -> final type name, or null to drop that value. */
  typeRenames?: Record<string, string | null>;
  /** Vault-relative directories to leave out entirely, matched like Engine's `excludeDirs`. */
  exclude?: string[];
  /** Field name -> the type to use instead of inferring one, when every value converts. */
  fieldTypes?: Record<string, FieldTypeChoice>;
}

export interface ResolvedFolderRule {
  directory: string;
  segments: string[];
  type: string | null;
}

export interface TypeAssignmentPlan {
  typeField: string | null;
  /** The key Engine keeps types in; the proposal maps the type field onto it. */
  typeKey: string;
  /** Sorted by exact directory. */
  folderRules: ResolvedFolderRule[];
  /** Tag -> type (null: left out), in the order given. */
  tagRules: Map<string, string | null>;
  typeRenames: Map<string, string | null>;
}

export interface ParsedAnalyzeInput {
  root: string;
  exclusions: string[];
  plan: TypeAssignmentPlan;
  fieldTypes: Map<string, FieldTypeChoice>;
}

export function parseAnalyzeInput(input: AnalyzeInput): AnalyzerResult<ParsedAnalyzeInput> {
  if (typeof input?.root !== 'string' || input.root.trim() === '') {
    return invalidArguments('root must be a non-empty string');
  }
  if (
    input.typeField !== undefined
    && (typeof input.typeField !== 'string' || input.typeField.length === 0)
  ) {
    return invalidArguments('typeField must be a non-empty exact frontmatter key');
  }
  if (input.typeKey !== undefined) {
    if (typeof input.typeKey !== 'string' || input.typeKey.trim() !== input.typeKey || input.typeKey.length === 0) {
      return invalidArguments('typeKey must be a non-empty exact frontmatter key without surrounding spaces');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(input.typeKey)) {
      return invalidArguments('typeKey must be a frontmatter key on one line, without control characters');
    }
    if (isEngineNoteKey(input.typeKey)) {
      return refusal(
        'TYPE_KEY_RESERVED',
        `Engine writes "${input.typeKey}" in its own notes, so that key cannot also hold note types`,
        { type_key: input.typeKey },
      );
    }
  }
  const exclusions = parseExclusions(input.exclude);
  if (!exclusions.ok) return exclusions;
  const folderRules = parseFolderRules(input.folderRules);
  if (!folderRules.ok) return folderRules;
  const tagRules = parseTagRules(input.tagRules);
  if (!tagRules.ok) return tagRules;
  const typeRenames = parseTypeRenames(input.typeRenames);
  if (!typeRenames.ok) return typeRenames;
  const fieldTypes = parseFieldTypes(input.fieldTypes);
  if (!fieldTypes.ok) return fieldTypes;

  const typeField = input.typeField ?? null;
  if (typeField === null && folderRules.data.length === 0 && tagRules.data.size === 0) {
    return invalidArguments('provide typeField, folderRules, tagRules, or several');
  }
  if (typeField === null && typeRenames.data.size > 0) {
    return invalidArguments('typeRenames apply only to typeField values');
  }
  return {
    ok: true,
    data: {
      root: input.root,
      exclusions: exclusions.data,
      plan: {
        typeField, typeKey: input.typeKey ?? DEFAULT_TYPE_KEY, folderRules: folderRules.data, tagRules: tagRules.data,
        typeRenames: typeRenames.data,
      },
      fieldTypes: fieldTypes.data,
    },
  };
}

const CHOSEN_FIELD_TYPES = new Set(['string', 'number', 'date', 'boolean', 'reference', 'list']);
const LIST_ITEM_TYPES = new Set(['string', 'number', 'date', 'boolean', 'reference']);

function parseFieldTypes(fieldTypes: unknown): AnalyzerResult<Map<string, FieldTypeChoice>> {
  if (fieldTypes === undefined) return { ok: true, data: new Map() };
  if (typeof fieldTypes !== 'object' || fieldTypes === null || Array.isArray(fieldTypes)) {
    return invalidArguments('fieldTypes must be an object');
  }
  const parsed = new Map<string, FieldTypeChoice>();
  for (const [name, choice] of Object.entries(fieldTypes)) {
    if (name.length === 0) return invalidArguments('fieldTypes names must be non-empty');
    if (
      typeof choice !== 'object' || choice === null || Array.isArray(choice)
      || Object.keys(choice).some(key => key !== 'field_type' && key !== 'list_item_type')
    ) {
      return invalidArguments(`fieldTypes.${name} must be an object with field_type and, for a list, list_item_type`);
    }
    const { field_type: fieldType, list_item_type: itemType } = choice as { field_type?: unknown; list_item_type?: unknown };
    if (typeof fieldType !== 'string' || !CHOSEN_FIELD_TYPES.has(fieldType)) {
      return invalidArguments(`invalid fieldTypes.${name}.field_type: ${JSON.stringify(fieldType)}`);
    }
    if (fieldType === 'list' ? typeof itemType !== 'string' || !LIST_ITEM_TYPES.has(itemType) : itemType !== undefined) {
      return invalidArguments(`invalid fieldTypes.${name}.list_item_type: ${JSON.stringify(itemType)}`);
    }
    parsed.set(name, choice as FieldTypeChoice);
  }
  return { ok: true, data: parsed };
}

function parseFolderRules(rules: unknown): AnalyzerResult<ResolvedFolderRule[]> {
  if (rules === undefined) return { ok: true, data: [] };
  if (!Array.isArray(rules)) return invalidArguments('folderRules must be an array');
  const resolved = new Map<string, ResolvedFolderRule>();
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      return invalidArguments('each folder rule must be an object with directory and type');
    }
    const { directory: rawDirectory, type } = rule as { directory?: unknown; type?: unknown };
    const directory = parseRelativeDirectory(rawDirectory);
    if (directory === null) {
      return invalidArguments(`invalid folder rule directory: ${JSON.stringify(rawDirectory)}`);
    }
    if (type !== null && !isFinalTypeName(type)) {
      return invalidArguments(`invalid folder rule type for ${directory}: ${JSON.stringify(type)}`);
    }
    if (resolved.has(directory)) {
      return invalidArguments(`duplicate folder rule directory: ${directory}`);
    }
    resolved.set(directory, { directory, segments: directory.split('/'), type });
  }
  return {
    ok: true,
    data: [...resolved.values()].sort((left, right) => compareExact(left.directory, right.directory)),
  };
}

function parseTagRules(rules: unknown): AnalyzerResult<Map<string, string | null>> {
  if (rules === undefined) return { ok: true, data: new Map() };
  if (!Array.isArray(rules)) return invalidArguments('tagRules must be an array');
  const parsed = new Map<string, string | null>();
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      return invalidArguments('each tag rule must be an object with tag and type');
    }
    const { tag: rawTag, type } = rule as { tag?: unknown; type?: unknown };
    const tag = typeof rawTag === 'string' ? rawTag.trim().replace(/^#/, '').toLowerCase() : '';
    if (tag === '' || tag.startsWith('/') || tag.endsWith('/') || /\s/.test(tag)) {
      return invalidArguments(`invalid tag rule tag: ${JSON.stringify(rawTag)}`);
    }
    if (type !== null && !isFinalTypeName(type)) {
      return invalidArguments(`invalid tag rule type for #${tag}: ${JSON.stringify(type)}`);
    }
    if (parsed.has(tag)) return invalidArguments(`duplicate tag rule: #${tag}`);
    parsed.set(tag, type);
  }
  return { ok: true, data: parsed };
}

/** The types a document's tags give it, in rule order, each once (`ScannedMarkdownFile.tags` already holds every parent of a nested tag). */
export function tagRuleTypes(rules: ReadonlyMap<string, string | null>, tags: readonly string[]): { types: string[]; tags: string[] } {
  if (rules.size === 0 || tags.length === 0) return { types: [], tags: [] };
  const carried = new Set(tags);
  const types: string[] = [];
  const matched: string[] = [];
  for (const [tag, type] of rules) {
    if (!carried.has(tag) || type === null) continue;
    matched.push(tag);
    if (!types.includes(type)) types.push(type);
  }
  return { types, tags: matched };
}

function parseTypeRenames(renames: unknown): AnalyzerResult<Map<string, string | null>> {
  if (renames === undefined) return { ok: true, data: new Map() };
  if (typeof renames !== 'object' || renames === null || Array.isArray(renames)) {
    return invalidArguments('typeRenames must be an object');
  }
  const parsed = new Map<string, string | null>();
  for (const [from, to] of Object.entries(renames)) {
    if (from.length === 0 || from !== from.trim()) {
      return invalidArguments(`invalid typeRenames source: ${JSON.stringify(from)}`);
    }
    if (to !== null && !isFinalTypeName(to)) {
      return invalidArguments(`invalid typeRenames target for ${from}: ${JSON.stringify(to)}`);
    }
    parsed.set(from, to);
  }
  return { ok: true, data: parsed };
}

/**
 * Engine's frontmatter parser strips one whole `[[...]]` wrapper from canonical type
 * values, so a wrapped final name would not match its own schema after adoption.
 */
const ENGINE_TYPE_WRAPPER_RE = /^\[\[(.+)\]\]$/;

function isFinalTypeName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !ENGINE_TYPE_WRAPPER_RE.test(value)
    && isApplySafeSchemaName(value);
}

/** The deepest rule whose directory contains the file, or null. */
export function matchFolderRule(
  rules: readonly ResolvedFolderRule[],
  relativePath: string,
): ResolvedFolderRule | null {
  const directorySegments = relativePath.split('/').slice(0, -1);
  let match: ResolvedFolderRule | null = null;
  for (const rule of rules) {
    if (rule.segments.length > directorySegments.length) continue;
    if (!rule.segments.every((segment, index) => directorySegments[index] === segment)) continue;
    if (match === null || rule.segments.length > match.segments.length) match = rule;
  }
  return match;
}

/**
 * Read a document's type-field values. `values` holds each normalized source value
 * once; `types` holds the final names after renames, without dropped values.
 */
export function readTypeFieldValues(
  file: ScannedMarkdownFile,
  typeField: string,
  typeRenames: ReadonlyMap<string, string | null>,
): { types: string[]; values: string[]; invalidValues: unknown[]; keyPresent: boolean } {
  const data = file.frontmatter?.data;
  if (!data || !Object.prototype.hasOwnProperty.call(data, typeField)) {
    return { types: [], values: [], invalidValues: [], keyPresent: false };
  }
  const raw = data[typeField];
  const nestedWikiLinkValue = (
    Array.isArray(raw) && raw.length === 1 && Array.isArray(raw[0])
    && raw[0].length === 1 && typeof raw[0][0] === 'string'
  ) ? raw[0][0] : null;
  const rawValues = nestedWikiLinkValue !== null
    ? [nestedWikiLinkValue]
    : Array.isArray(raw) ? raw : [raw];
  const types: string[] = [];
  const values: string[] = [];
  const invalidValues: unknown[] = [];
  for (const value of rawValues) {
    if (typeof value !== 'string') {
      invalidValues.push(value);
      continue;
    }
    const normalized = nestedWikiLinkValue !== null
      ? normalizeNestedWikiLinkValue(value)
      : normalizeTypeValue(value);
    if (normalized === null) {
      invalidValues.push(value);
      continue;
    }
    const renamed = typeRenames.has(normalized);
    if (!renamed && !isApplySafeSchemaName(normalized)) {
      invalidValues.push(value);
      continue;
    }
    if (!values.includes(normalized)) values.push(normalized);
    const type = renamed ? typeRenames.get(normalized) ?? null : normalized;
    if (type !== null && !types.includes(type)) types.push(type);
  }
  return { types, values, invalidValues, keyPresent: true };
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
