import { assertWikiSectionContent, assertWikiSectionStructure } from './section-integrity.js';

export interface ManagedSectionInput {
  name: string;
  mode: 'replace' | 'append';
  content: string;
}

export interface MergeSectionsInput {
  live: Record<string, string>;
  managed: ManagedSectionInput[];
}

export interface MergeSectionsResult {
  body: string;
  written: string[];
  created: string[];
}

// Narrative first, evidence second: the synthesized brief (Now, Focus, Open
// threads) renders above all live appendices so the top of the page answers
// "what is going on?" before any raw query output. Log is the exception — a
// dated journal that belongs at the very bottom and grows downward.
const DEFAULT_ORDER = [
  'managed:At a glance',
  'managed:Now',
  'managed:Focus',
  'managed:Open threads',
  'managed:Summary',
  'live:tasks',
  'live:upcoming',
  'live:contacts',
  'live:meetings',
  'live:notes',
  'live:related',
  'live:sub-pages',
  'managed:Log',
];

export function mergeManagedSections(currentBody: string, payload: MergeSectionsInput): MergeSectionsResult {
  assertWikiSectionStructure(currentBody);
  for (const [name, content] of Object.entries(payload.live)) assertWikiSectionContent(name, content);
  for (const section of payload.managed) assertWikiSectionContent(section.name, section.content);
  let body = currentBody;
  const written: string[] = [];
  const created: string[] = [];

  const managed = new Map(payload.managed.map(s => [s.name, s]));

  for (const [key, content] of Object.entries(payload.live).sort(([a], [b]) => compareSectionOrder(`live:${a}`, `live:${b}`))) {
    const name = `live:${key}`;
    const nextBlock = makeBlock('live', key, normalizeContent(content));
    const replaced = replaceBlock(body, 'live', key, nextBlock);
    body = replaced.body;
    written.push(name);
    if (!replaced.found) created.push(name);
  }

  const managedInputs = Array.from(managed.values())
    .sort((a, b) => compareSectionOrder(`managed:${a.name}`, `managed:${b.name}`));
  for (const section of managedInputs) {
    const name = `managed:${section.name}`;
    const content = normalizeContent(section.content);
    if (section.mode === 'append') {
      const appended = appendBlock(body, 'managed', section.name, content);
      body = appended.body;
      written.push(name);
      if (!appended.found) created.push(name);
    } else {
      const nextBlock = makeBlock('managed', section.name, content);
      const replaced = replaceBlock(body, 'managed', section.name, nextBlock);
      body = replaced.body;
      written.push(name);
      if (!replaced.found) created.push(name);
    }
  }

  for (const name of sortCreated(created)) {
    const [kind, key] = splitSectionName(name);
    if (hasBlock(body, kind, key)) continue;
    const content = kind === 'live'
      ? normalizeContent(payload.live[key] ?? '')
      : normalizeContent(managed.get(key)?.content ?? '');
    body = insertBlockInOrder(body, name, makeBlock(kind, key, content));
  }

  assertWikiSectionStructure(body);
  return { body, written, created: sortCreated(created) };
}

export function extractManagedSection(body: string, name: string, maxChars: number): string | undefined {
  const match = markerRegex('managed', name).exec(body);
  if (!match) return undefined;
  const block = match[0];
  const contentStart = block.indexOf('-->') + 3;
  const contentEnd = block.lastIndexOf('<!--');
  return block.slice(contentStart, contentEnd).trim().slice(0, maxChars);
}

function splitSectionName(name: string): ['live' | 'managed', string] {
  const idx = name.indexOf(':');
  return [name.slice(0, idx) as 'live' | 'managed', name.slice(idx + 1)];
}

function sortCreated(created: string[]): string[] {
  return Array.from(new Set(created)).sort(compareSectionOrder);
}

function compareSectionOrder(a: string, b: string): number {
  const ai = DEFAULT_ORDER.indexOf(a);
  const bi = DEFAULT_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  return a.localeCompare(b);
}

function normalizeContent(content: string): string {
  return content.trim();
}

function makeBlock(kind: 'live' | 'managed', key: string, content: string): string {
  return `<!-- ve:${kind}:${key} -->\n${content}${content ? '\n' : ''}<!-- /ve:${kind}:${key} -->`;
}

function markerRegex(kind: 'live' | 'managed', key: string): RegExp {
  const escapedKind = escapeRegex(kind);
  const escapedKey = escapeRegex(key);
  return new RegExp(`<!--\\s*ve:${escapedKind}:${escapedKey}\\s*-->([\\s\\S]*?)<!--\\s*/ve:${escapedKind}:${escapedKey}\\s*-->`);
}

function hasBlock(body: string, kind: 'live' | 'managed', key: string): boolean {
  return markerRegex(kind, key).test(body);
}

function replaceBlock(body: string, kind: 'live' | 'managed', key: string, block: string): { body: string; found: boolean } {
  const rx = markerRegex(kind, key);
  if (!rx.test(body)) return { body, found: false };
  return { body: body.replace(rx, () => block), found: true };
}

function appendBlock(body: string, kind: 'managed', key: string, content: string): { body: string; found: boolean } {
  const rx = markerRegex(kind, key);
  const match = rx.exec(body);
  if (!match) return { body, found: false };
  const block = match[0];
  // Strip only marker separator lines; leading code indentation belongs to history.
  const existing = (match[1] ?? '').replace(/^\r?\n/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
  const nextContent = [existing.trim() ? existing : '', content].filter(Boolean).join('\n\n');
  const nextBlock = makeBlock(kind, key, nextContent);
  return { body: body.slice(0, match.index) + nextBlock + body.slice(match.index + block.length), found: true };
}

function appendWithSpacing(body: string, block: string): string {
  if (body.trim() === '') return `${block}\n`;
  return `${body.replace(/\s*$/, '')}\n\n${block}\n`;
}

function insertBlockInOrder(body: string, name: string, block: string): string {
  const insertionIndex = findInsertionIndex(body, name);
  if (insertionIndex === null) return appendWithSpacing(body, block);
  const before = body.slice(0, insertionIndex).replace(/\s*$/, '');
  const after = body.slice(insertionIndex).replace(/^\s*/, '');
  const prefix = before ? `${before}\n\n` : '';
  const suffix = after ? `\n\n${after}` : '\n';
  return `${prefix}${block}${suffix}`;
}

function findInsertionIndex(body: string, name: string): number | null {
  const currentOrder = sectionOrderIndex(name);
  const rx = /<!--\s*ve:(live|managed):([\s\S]*?)\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(body)) !== null) {
    const candidate = `${match[1]}:${match[2].trim()}`;
    if (sectionOrderIndex(candidate) > currentOrder) return match.index;
  }
  return null;
}

function sectionOrderIndex(name: string): number {
  const idx = DEFAULT_ORDER.indexOf(name);
  return idx === -1 ? 999 : idx;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
