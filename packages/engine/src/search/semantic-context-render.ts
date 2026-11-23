import { Buffer } from 'node:buffer';
import { allocateSemanticFieldNames, createSemanticFieldDictionary, selectSemanticFields } from './semantic-context-fields.js';

export const CONTEXT_LIMITS = Object.freeze({
  fields: 256, links: 512, rawFieldBytes: 16 * 1024, depth: 16,
  leaves: 512, scalarBytes: 2 * 1024, renderedBytes: 32 * 1024,
});

export interface EmbeddingDocumentContext {
  readonly source: {
    readonly kind: 'node' | 'extraction'; readonly ref?: string; readonly media_type?: string;
  };
  readonly title: string; readonly path: string;
  readonly types: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
  readonly links: readonly string[];
  /** Field names (lower case) rendered first, in order. Set only when the vault map's people
   *  field is not the default (`semanticPriorityFields`); absent = the default list, so an
   *  install with the default map embeds the same bytes as before the map. */
  readonly priorityFields?: readonly string[];
}

export type ContextLines = { readonly lines: readonly string[]; readonly requiredCount: number };

const PRIORITY_FIELDS: readonly string[] = ['aliases', 'project', 'people', 'people involved', 'tags', 'context', 'author'];
/** The entry of PRIORITY_FIELDS that names the vault map's people field (`peopleField`). */
const DEFAULT_PEOPLE_FIELD = 'people involved';

/**
 * The priority list for a vault whose people field (the vault map's `peopleField`) is
 * `peopleField`: its name in place of the default's, or no people entry when it is none.
 * Undefined when it is the default, so the context carries nothing and renders as before.
 */
export function semanticPriorityFields(peopleField: string | null): readonly string[] | undefined {
  const people = peopleField === null ? null : peopleField.toLowerCase();
  if (people === DEFAULT_PEOPLE_FIELD) return undefined;
  const list = PRIORITY_FIELDS.flatMap(name => name !== DEFAULT_PEOPLE_FIELD ? [name] : people === null ? [] : [people]);
  return [...new Set(list)];
}
const TRAVERSAL_LIMIT = CONTEXT_LIMITS.leaves * (CONTEXT_LIMITS.depth + 1) + 1;

type StackEntry = { readonly value: unknown; readonly prefix: string; readonly depth: number };
type LeafBudget = { count: number; visited: number; exhausted: boolean };
type CloneEntry = { readonly value: unknown; readonly parent: Record<string, unknown> | unknown[]; readonly key: string | number; readonly depth: number };

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return value;
  const marker = `… [truncated: ${bytes} bytes]`;
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let prefix = '';
  let used = 0;
  for (const codePoint of value) {
    const width = Buffer.byteLength(codePoint, 'utf8');
    if (used + width > contentBudget) break;
    prefix += codePoint;
    used += width;
  }
  return `${prefix}${marker}`;
}

function boundScalar(value: string): string { return truncateUtf8(value.replace(/\s+/g, ' ').trim(), CONTEXT_LIMITS.scalarBytes); }

function boundStructuralScalar(value: string): string { return truncateUtf8(value, CONTEXT_LIMITS.scalarBytes); }

function assignClone(parent: Record<string, unknown> | unknown[], key: string | number, value: unknown): void {
  if (Array.isArray(parent)) {
    if (typeof key === 'number') parent[key] = value;
    return;
  }
  if (typeof key === 'string') parent[key] = value;
}

function cloneBoundedValue(value: unknown, budget: LeafBudget): unknown {
  const root = createSemanticFieldDictionary();
  const stack: CloneEntry[] = [{ value, parent: root, key: 'value', depth: 0 }];
  while (stack.length > 0 && !budget.exhausted) {
    const entry = stack.pop();
    if (entry === undefined) continue;
    budget.visited += 1;
    if (budget.visited > TRAVERSAL_LIMIT) {
      assignClone(entry.parent, entry.key, '[leaf limit]');
      budget.exhausted = true;
      continue;
    }
    const scalar = typeof entry.value === 'string' ? boundScalar(entry.value) : null;
    if (scalar !== null || typeof entry.value === 'number' || typeof entry.value === 'boolean' || typeof entry.value === 'bigint') {
      if (budget.count >= CONTEXT_LIMITS.leaves) {
        assignClone(entry.parent, entry.key, '[leaf limit]');
        budget.exhausted = true;
      } else {
        assignClone(entry.parent, entry.key, scalar ?? String(entry.value));
        if (scalar !== '') budget.count += 1;
      }
      continue;
    }
    if (entry.value === null || entry.value === undefined || typeof entry.value !== 'object') continue;
    if (entry.depth >= CONTEXT_LIMITS.depth) {
      const marker = budget.count >= CONTEXT_LIMITS.leaves ? '[leaf limit]' : '[depth limit]';
      assignClone(entry.parent, entry.key, marker);
      if (marker === '[leaf limit]') budget.exhausted = true;
      else budget.count += 1;
      continue;
    }
    const clone: Record<string, unknown> | unknown[] = Array.isArray(entry.value) ? [] : createSemanticFieldDictionary();
    assignClone(entry.parent, entry.key, clone);
    const childLimit = Math.max(1, Math.min(
      CONTEXT_LIMITS.leaves - budget.count + 1,
      TRAVERSAL_LIMIT - budget.visited + 1,
    ));
    const children: Array<readonly [string | number, unknown]> = [];
    if (Array.isArray(entry.value)) {
      const length = Math.min(entry.value.length, childLimit);
      for (let index = 0; index < length; index += 1) children.push([index, entry.value[index]]);
    } else {
      for (const key in entry.value) {
        if (!Object.hasOwn(entry.value, key)) continue;
        children.push([key, Reflect.get(entry.value, key)]);
        if (children.length >= childLimit) break;
      }
      children.sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ value: child[1], parent: clone, key: child[0], depth: entry.depth + 1 });
    }
  }
  return root['value'];
}

function addLeaf(entries: string[], prefix: string, value: string, budget: LeafBudget): boolean {
  if (budget.count >= CONTEXT_LIMITS.leaves) {
    if (!budget.exhausted) {
      entries.push(prefix ? `${prefix}: [leaf limit]` : '[leaf limit]');
      budget.exhausted = true;
    }
    return false;
  }
  entries.push(prefix ? `${prefix}: ${value}` : value);
  budget.count += 1;
  return true;
}

function flattenBoundedValue(value: unknown, budget: LeafBudget): readonly string[] {
  const entries: string[] = [];
  const stack: StackEntry[] = [{ value, prefix: '', depth: 0 }];
  while (stack.length > 0 && !budget.exhausted) {
    const entry = stack.pop();
    if (entry === undefined || entry.value === null || entry.value === undefined) continue;
    if (typeof entry.value === 'string') {
      const scalar = boundScalar(entry.value);
      if (scalar) addLeaf(entries, entry.prefix, scalar, budget);
      continue;
    }
    if (typeof entry.value === 'number' || typeof entry.value === 'boolean' || typeof entry.value === 'bigint') {
      addLeaf(entries, entry.prefix, String(entry.value), budget);
      continue;
    }
    if (typeof entry.value !== 'object') continue;
    if (entry.depth >= CONTEXT_LIMITS.depth) {
      addLeaf(entries, entry.prefix, '[depth limit]', budget);
      continue;
    }
    if (Array.isArray(entry.value)) {
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entry.value[index], prefix: entry.prefix, depth: entry.depth + 1 });
      }
      continue;
    }
    const children = Object.entries(entry.value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined) continue;
      const [key, childValue] = child;
      stack.push({
        value: childValue,
        prefix: entry.prefix ? `${entry.prefix}.${boundStructuralScalar(key)}` : boundStructuralScalar(key),
        depth: entry.depth + 1,
      });
    }
  }
  return entries;
}

function renderOrder(fieldNames: readonly string[], priorityFields: readonly string[]): readonly string[] {
  const byLower = new Map(fieldNames.map(name => [name.toLowerCase(), name]));
  const priority = priorityFields.flatMap(wanted => {
    const actual = byLower.get(wanted);
    return actual === undefined ? [] : [actual];
  });
  const used = new Set(priority);
  return [...priority, ...fieldNames.filter(name => !used.has(name))];
}

export function boundDocumentContext(context: EmbeddingDocumentContext): EmbeddingDocumentContext {
  const fieldEntries = allocateSemanticFieldNames(
    selectSemanticFields(context.fields, CONTEXT_LIMITS.fields),
    CONTEXT_LIMITS.scalarBytes,
  );
  const fieldValues = new Map(fieldEntries.map(entry => [entry.name, entry.value]));
  const budget: LeafBudget = { count: 0, visited: 0, exhausted: false };
  const fields = createSemanticFieldDictionary();
  const priorityFields = context.priorityFields ?? PRIORITY_FIELDS;
  for (const name of renderOrder([...fieldValues.keys()], priorityFields)) fields[name] = cloneBoundedValue(fieldValues.get(name), budget);
  const source = context.source.kind === 'extraction'
    ? {
        kind: 'extraction' as const,
        ...(context.source.ref === undefined ? {} : { ref: boundStructuralScalar(context.source.ref) }),
        ...(context.source.media_type === undefined ? {} : { media_type: boundStructuralScalar(context.source.media_type) }),
      }
    : { kind: 'node' as const };
  const types = context.types.slice(0, CONTEXT_LIMITS.fields).map(boundStructuralScalar).join(', ');
  const links = context.links.slice(0, CONTEXT_LIMITS.links).map(boundStructuralScalar).join(', ');
  const bounded: EmbeddingDocumentContext = {
    source,
    title: boundScalar(context.title),
    path: boundScalar(context.path),
    types: types ? [boundStructuralScalar(types)] : [],
    fields,
    links: links ? [boundStructuralScalar(links)] : [],
    ...(context.priorityFields === undefined ? {} : { priorityFields: context.priorityFields }),
  };
  const removableFields = [...renderOrder(Object.keys(fields), priorityFields)];
  while (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > CONTEXT_LIMITS.renderedBytes) {
    const name = removableFields.pop();
    if (name === undefined) break;
    delete fields[name];
  }
  return bounded;
}

function renderFieldLine(name: string, value: unknown): string | null {
  const budget: LeafBudget = { count: 0, visited: 0, exhausted: false };
  const entries = [...new Set(flattenBoundedValue(value, budget))];
  return entries.length === 0 ? null : `${name}: ${entries.join(', ')}`;
}

function appendBoundedLine(lines: string[], line: string): boolean {
  const separatorBytes = lines.length === 0 ? 0 : 1;
  const usedBytes = Buffer.byteLength(lines.join('\n'), 'utf8');
  const remaining = CONTEXT_LIMITS.renderedBytes - usedBytes - separatorBytes;
  if (remaining <= 0) return false;
  lines.push(truncateUtf8(line, remaining));
  return Buffer.byteLength(line, 'utf8') <= remaining;
}

export function renderContextLines(context: EmbeddingDocumentContext): ContextLines {
  const bounded = boundDocumentContext(context);
  const identity: string[] = [];
  if (bounded.source.kind === 'extraction') {
    const media = bounded.source.media_type ? ` (${bounded.source.media_type})` : '';
    identity.push(`Attachment: ${bounded.source.ref ?? 'unknown'}${media}`);
  } else {
    identity.push('Source: node');
  }
  if (bounded.title) identity.push(`Title: ${bounded.title}`);
  if (bounded.path) identity.push(`Path: ${bounded.path}`);
  if (bounded.types.length > 0) identity.push(`Types: ${boundStructuralScalar(bounded.types.join(', '))}`);

  const lines: string[] = [];
  for (const line of identity) appendBoundedLine(lines, line);
  const requiredCount = lines.length;
  const fieldNames = Object.keys(bounded.fields);
  const byLower = new Map(fieldNames.map(name => [name.toLowerCase(), name]));
  const used = new Set<string>();
  for (const wanted of bounded.priorityFields ?? PRIORITY_FIELDS) {
    const actual = byLower.get(wanted);
    if (actual === undefined || used.has(actual)) continue;
    const line = renderFieldLine(actual, bounded.fields[actual]);
    if (line !== null && !appendBoundedLine(lines, line)) return { lines, requiredCount };
    if (line !== null) used.add(actual);
  }
  if (bounded.links.length > 0 && !appendBoundedLine(lines, `Links: ${boundStructuralScalar(bounded.links.join(', '))}`)) {
    return { lines, requiredCount };
  }
  for (const name of fieldNames.filter(name => !used.has(name)).sort((left, right) => left.localeCompare(right))) {
    const line = renderFieldLine(name, bounded.fields[name]);
    if (line !== null && !appendBoundedLine(lines, line)) break;
  }
  return { lines, requiredCount };
}

export function renderSemanticContext(context: EmbeddingDocumentContext): string {
  return renderContextLines(context).lines.join('\n');
}
