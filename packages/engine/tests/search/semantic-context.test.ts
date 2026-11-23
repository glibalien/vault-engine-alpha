// tests/search/semantic-context.test.ts
//
// Cycle 5: context assembly, canonical rendering, token capping, and the
// versioned source hash for context-rich chunk embeddings.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import {
  assembleDocumentContext,
  boundDocumentContext,
  renderContextLines,
  renderSemanticContext,
  semanticSourceHash,
  capContextLines,
  truncateToTokens,
  SEMANTIC_CONTEXT_VERSION,
  semanticPriorityFields,
  type EmbeddingDocumentContext,
} from '../../src/search/semantic-context.js';
import { setStoredSettings } from '../../src/settings/store.js';

// Approx 4 chars/token — matches the chunker tests' approximation.
const approxTokenize = (s: string): number => Math.ceil(s.length / 4);

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

function insertNode(id: string, title: string, filePath = `${id}.md`, body: string | null = null): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, filePath, title, body);
}

function insertType(nodeId: string, type: string, sortOrder = 0): void {
  db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)').run(nodeId, type, sortOrder);
}

function insertField(
  nodeId: string,
  name: string,
  value: { text?: string; number?: number; date?: string; json?: unknown },
): void {
  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    nodeId,
    name,
    value.text ?? null,
    value.number ?? null,
    value.date ?? null,
    value.json !== undefined ? JSON.stringify(value.json) : null,
  );
}

function insertLink(sourceId: string, target: string, relType = 'wiki-link'): void {
  db.prepare('INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)').run(sourceId, target, relType);
}

function baseContext(overrides: Partial<EmbeddingDocumentContext> = {}): EmbeddingDocumentContext {
  return {
    source: { kind: 'node' },
    title: 'My Note',
    path: 'Notes/My Note.md',
    types: ['note'],
    fields: {},
    links: [],
    ...overrides,
  };
}

describe('assembleDocumentContext', () => {
  it('returns null for a missing node', () => {
    expect(assembleDocumentContext(db, 'nope')).toBeNull();
  });

  it('assembles identity, ordered types, fields, and raw links', () => {
    insertNode('n1', 'Meeting Notes', 'Notes/Meeting Notes.md', 'body');
    insertType('n1', 'note', 1);
    insertType('n1', 'project', 0);
    insertField('n1', 'status', { text: 'open' });
    insertLink('n1', 'Zebra');
    insertLink('n1', 'Alpha');

    const ctx = assembleDocumentContext(db, 'n1')!;
    expect(ctx.source).toEqual({ kind: 'node' });
    expect(ctx.title).toBe('Meeting Notes');
    expect(ctx.path).toBe('Notes/Meeting Notes.md');
    // sort_order wins over alphabetical
    expect(ctx.types).toEqual(['project', 'note']);
    expect(ctx.fields).toEqual({ status: 'open' });
    // raw targets, sorted for determinism
    expect(ctx.links).toEqual(['Alpha', 'Zebra']);
  });

  it('reconstructs number, date, boolean, list, and object field values', () => {
    insertNode('n1', 'T');
    insertField('n1', 'count', { number: 42 });
    insertField('n1', 'due', { date: '2026-01-02T00:00:00.000Z' });
    insertField('n1', 'done', { json: true });
    insertField('n1', 'tags', { json: ['a', 'b'] });
    insertField('n1', 'meta', { json: { z: 1, a: 'x' } });

    const ctx = assembleDocumentContext(db, 'n1')!;
    expect(ctx.fields.count).toBe(42);
    expect(ctx.fields.due).toBe('2026-01-02T00:00:00.000Z');
    expect(ctx.fields.done).toBe(true);
    expect(ctx.fields.tags).toEqual(['a', 'b']);
    expect(ctx.fields.meta).toEqual({ z: 1, a: 'x' });
  });

  it('bounds oversized invalid date text before assembled or serialized context', () => {
    // Given
    insertNode('n1', 'Bounded Date');
    const discardedDate = 'not-a-date-private-sentinel-'.repeat(1_000);
    insertField('n1', 'ordinary-date', { date: '2026-08-13T00:00:00.000Z' });
    insertField('n1', 'oversized-date', { date: discardedDate });
    const discardedBytes = Buffer.byteLength(discardedDate, 'utf8');

    // When
    const context = assembleDocumentContext(db, 'n1');

    // Then
    expect(context).not.toBeNull();
    if (context === null) throw new TypeError('Expected assembled context');
    expect(context.fields['ordinary-date']).toBe('2026-08-13T00:00:00.000Z');
    expect(context.fields['oversized-date']).toBe(`[value omitted: ${discardedBytes} bytes]`);
    expect(JSON.stringify(context)).not.toContain('not-a-date-private-sentinel-');
    expect(JSON.stringify(boundDocumentContext(context))).not.toContain('not-a-date-private-sentinel-');
  });

  it('uses raw relationship targets, not resolved-node titles', () => {
    insertNode('n1', 'Source');
    insertNode('n2', 'Resolved Title');
    // resolved_target_id set — context must still use the raw target string
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES (?, ?, ?, ?)')
      .run('n1', 'raw-target-string', 'wiki-link', 'n2');

    const ctx = assembleDocumentContext(db, 'n1')!;
    expect(ctx.links).toEqual(['raw-target-string']);
  });

  it('adds attachment reference and media type for extractions', () => {
    insertNode('n1', 'Parent Note', 'Notes/Parent.md');
    const ctx = assembleDocumentContext(db, 'n1', { ref: 'audio.m4a', mediaType: 'audio' })!;
    expect(ctx.source).toEqual({ kind: 'extraction', ref: 'audio.m4a', media_type: 'audio' });
    expect(ctx.title).toBe('Parent Note');
  });

  it('bounds ordered fields before materializing oversized JSON', () => {
    // Given
    insertNode('n1', 'Bounded Fields');
    const discarded = 'discarded-secret'.repeat(2_000);
    insertField('n1', 'field-000', { json: { discarded } });
    for (let index = 1; index < 257; index++) {
      insertField('n1', `field-${String(index).padStart(3, '0')}`, { text: `value-${index}` });
    }
    const oversizedBytes = Buffer.byteLength(JSON.stringify({ discarded }), 'utf8');

    // When
    const context = assembleDocumentContext(db, 'n1');

    // Then
    expect(context).not.toBeNull();
    if (context === null) throw new TypeError('Expected assembled context');
    expect(Object.keys(context.fields)).toHaveLength(256);
    expect(Object.keys(context.fields)).toEqual(
      Array.from({ length: 256 }, (_, index) => `field-${String(index).padStart(3, '0')}`),
    );
    expect(context.fields['field-000']).toBe(`[value omitted: ${oversizedBytes} bytes]`);
    expect(JSON.stringify(context.fields)).not.toContain(discarded);
    expect(context.fields).not.toHaveProperty('field-256');
  });

  it('bounds field names before they enter assembled or serialized context', () => {
    // Given
    insertNode('n1', 'Bounded Field Name');
    const discardedName = `private-field-${'x'.repeat(64 * 1024)}`;
    insertField('n1', discardedName, { text: 'visible value' });

    // When
    const context = assembleDocumentContext(db, 'n1');

    // Then
    expect(context).not.toBeNull();
    if (context === null) throw new TypeError('Expected assembled context');
    const serialized = JSON.stringify(boundDocumentContext(context));
    expect(serialized).not.toContain(discardedName);
    expect(serialized).not.toContain('private-field-');
    expect(serialized).toContain('[field name omitted:');
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('keeps equal-byte oversized field names distinct without revealing them', () => {
    // Given
    insertNode('n1', 'Distinct Omitted Names');
    const suffix = 'x'.repeat(4 * 1024);
    const firstName = `private-alpha-${suffix}`;
    const secondName = `private-bravo-${suffix}`;
    insertField('n1', firstName, { text: 'first value' });
    insertField('n1', secondName, { text: 'second value' });

    // When
    const before = assembleDocumentContext(db, 'n1');

    // Then
    expect(before).not.toBeNull();
    if (before === null) throw new TypeError('Expected assembled context');
    const names = Object.keys(before.fields);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every(name => name.startsWith('[field name omitted:'))).toBe(true);
    expect(JSON.stringify(before.fields)).not.toContain('private-alpha-');
    expect(JSON.stringify(before.fields)).not.toContain('private-bravo-');
    expect(Object.values(before.fields).sort()).toEqual(['first value', 'second value']);

    const beforeHash = semanticSourceHash(before, 'body');
    db.prepare('UPDATE node_fields SET value_text = ? WHERE node_id = ? AND field_name = ?')
      .run('changed first value', 'n1', firstName);
    const after = assembleDocumentContext(db, 'n1');
    expect(after).not.toBeNull();
    if (after === null) throw new TypeError('Expected reassembled context');
    expect(semanticSourceHash(after, 'body')).not.toBe(beforeHash);
  });

  it('preserves a legitimate placeholder-shaped SQL field beside an oversized field', () => {
    // Given
    insertNode('n1', 'Placeholder Collision');
    const oversizedName = 'z'.repeat(2_049);
    const legitimateName = '[field name omitted: 2049 bytes, ordinal 1]';
    insertField('n1', legitimateName, { text: 'legitimate value' });
    insertField('n1', oversizedName, { text: 'oversized value' });

    // When
    const original = assembleDocumentContext(db, 'n1');

    // Then
    expect(original).not.toBeNull();
    if (original === null) throw new TypeError('Expected assembled context');
    expect(Object.keys(original.fields)).toHaveLength(2);
    expect(Object.values(original.fields).sort()).toEqual(['legitimate value', 'oversized value']);
    expect(JSON.stringify(original.fields)).not.toContain(oversizedName);
    const originalHash = semanticSourceHash(original, 'body');

    db.prepare('UPDATE node_fields SET value_text = ? WHERE node_id = ? AND field_name = ?')
      .run('changed legitimate value', 'n1', legitimateName);
    const changedLegitimate = assembleDocumentContext(db, 'n1');
    expect(changedLegitimate).not.toBeNull();
    if (changedLegitimate === null) throw new TypeError('Expected legitimate-field context');
    expect(semanticSourceHash(changedLegitimate, 'body')).not.toBe(originalHash);

    db.prepare('UPDATE node_fields SET value_text = ? WHERE node_id = ? AND field_name = ?')
      .run('legitimate value', 'n1', legitimateName);
    db.prepare('UPDATE node_fields SET value_text = ? WHERE node_id = ? AND field_name = ?')
      .run('changed oversized value', 'n1', oversizedName);
    const changedOversized = assembleDocumentContext(db, 'n1');
    expect(changedOversized).not.toBeNull();
    if (changedOversized === null) throw new TypeError('Expected oversized-field context');
    expect(semanticSourceHash(changedOversized, 'body')).not.toBe(originalHash);
  });

  it('retains an SQL __proto__ field and hashes its value', () => {
    // Given
    insertNode('n1', 'Special Field Name');
    insertField('n1', '__proto__', { text: 'first value' });

    // When
    const original = assembleDocumentContext(db, 'n1');

    // Then
    expect(original).not.toBeNull();
    if (original === null) throw new TypeError('Expected assembled context');
    expect(Object.hasOwn(original.fields, '__proto__')).toBe(true);
    expect(original.fields['__proto__']).toBe('first value');
    const originalHash = semanticSourceHash(original, 'body');

    db.prepare('UPDATE node_fields SET value_text = ? WHERE node_id = ? AND field_name = ?')
      .run('second value', 'n1', '__proto__');
    const changed = assembleDocumentContext(db, 'n1');
    expect(changed).not.toBeNull();
    if (changed === null) throw new TypeError('Expected reassembled context');
    expect(changed.fields['__proto__']).toBe('second value');
    expect(semanticSourceHash(changed, 'body')).not.toBe(originalHash);
  });
});

describe('renderContextLines', () => {
  it('bounds direct field-key enumeration before sorting hostile contexts', () => {
    // Given
    let descriptors = 0;
    const fieldNames = Array.from({ length: 100_000 }, (_, index) => `field-${index}`);
    const fields = new Proxy<Record<string, unknown>>({}, {
      ownKeys: () => fieldNames,
      getOwnPropertyDescriptor: () => {
        descriptors += 1;
        return { configurable: true, enumerable: true };
      },
      get: (_target, property) => `value-${String(property)}`,
    });

    // When
    const bounded = boundDocumentContext(baseContext({ fields }));

    // Then
    expect(Object.keys(bounded.fields)).toHaveLength(256);
    expect(descriptors).toBeLessThanOrEqual(512);
  });

  it('keeps colliding oversized direct field names distinct and hash-sensitive', () => {
    // Given
    const sharedPrefix = 'p'.repeat(2_100);
    const firstName = `${sharedPrefix}-first`;
    const secondName = `${sharedPrefix}-other`;
    const fields = { [firstName]: 'first value', [secondName]: 'second value' };

    // When
    const bounded = boundDocumentContext(baseContext({ fields }));

    // Then
    expect(Object.keys(bounded.fields)).toHaveLength(2);
    expect(Object.values(bounded.fields).sort()).toEqual(['first value', 'second value']);
    expect(JSON.stringify(bounded.fields)).not.toContain('p'.repeat(64));
    const originalHash = semanticSourceHash(baseContext({ fields }), 'body');
    expect(semanticSourceHash(baseContext({
      fields: { [firstName]: 'changed first value', [secondName]: 'second value' },
    }), 'body')).not.toBe(originalHash);
    expect(semanticSourceHash(baseContext({
      fields: { [firstName]: 'first value', [secondName]: 'changed second value' },
    }), 'body')).not.toBe(originalHash);
  });

  it('retains an enumerable own __proto__ field and hashes its value', () => {
    // Given
    const fields: Record<string, unknown> = {};
    Object.defineProperty(fields, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'first value',
      writable: true,
    });

    // When
    const bounded = boundDocumentContext(baseContext({ fields }));

    // Then
    expect(Object.hasOwn(bounded.fields, '__proto__')).toBe(true);
    expect(bounded.fields['__proto__']).toBe('first value');
    const originalHash = semanticSourceHash(baseContext({ fields }), 'body');
    Object.defineProperty(fields, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'second value',
      writable: true,
    });
    expect(semanticSourceHash(baseContext({ fields }), 'body')).not.toBe(originalHash);
  });

  it('bounds deep and wide fields without recursive traversal', () => {
    // Given
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 10_000; depth++) nested = { next: nested };
    const context = baseContext({
      fields: {
        deep: nested,
        wide: Array.from({ length: 2_000 }, (_, index) => `value-${index}`),
      },
    });

    // When
    const bounded = boundDocumentContext(context);
    const rendered = renderSemanticContext(bounded);

    // Then
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(rendered).toContain('[depth limit]');
    expect(rendered).toContain('[leaf limit]');
  });

  it('stops reading a hostile array when the shared leaf budget is exhausted', () => {
    // Given
    let reads = 0;
    const hostile = new Proxy(new Array<unknown>(100_000), {
      has: (_target, property) => typeof property === 'string' && /^\d+$/.test(property),
      get: (target, property, receiver) => {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          reads += 1;
          return `value-${property}`;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    // When
    const rendered = renderSemanticContext(boundDocumentContext(baseContext({ fields: { hostile } })));

    // Then
    expect(rendered).toContain('[leaf limit]');
    expect(reads).toBeLessThanOrEqual(513);
  });

  it('preserves the existing canonical render below every limit', () => {
    // Given
    const context = baseContext({ fields: { tags: ['b', 'a'], meta: { z: 1, a: 'x' } } });

    // When
    const rendered = renderSemanticContext(boundDocumentContext(context));

    // Then
    expect(rendered).toBe([
      'Source: node',
      'Title: My Note',
      'Path: Notes/My Note.md',
      'Types: note',
      'tags: b, a',
      'meta: a: x, z: 1',
    ].join('\n'));
  });

  it('preserves canonical object-key ordering below every limit', () => {
    // Given
    const context = baseContext({ fields: { meta: { a: 2, Z: 1 } } });

    // When
    const rendered = renderSemanticContext(boundDocumentContext(context));

    // Then
    expect(rendered).toContain('meta: Z: 1, a: 2');
  });

  it('preserves canonical structural whitespace below every limit', () => {
    // Given
    const context = baseContext({
      types: ['odd  type'],
      fields: { 'odd  field': { 'odd  key': 'value' } },
      links: ['odd  link'],
    });

    // When
    const rendered = renderSemanticContext(boundDocumentContext(context));

    // Then
    expect(rendered).toContain('Types: odd  type');
    expect(rendered).toContain('Links: odd  link');
    expect(rendered).toContain('odd  field: odd  key: value');
  });

  it('renders identity rows first and marks them required', () => {
    const { lines, requiredCount } = renderContextLines(baseContext({
      types: ['project', 'note'],
      fields: { status: 'open' },
    }));
    expect(lines.slice(0, requiredCount)).toEqual([
      'Source: node',
      'Title: My Note',
      'Path: Notes/My Note.md',
      'Types: project, note',
    ]);
    expect(lines[requiredCount]).toBe('status: open');
  });

  it('renders attachment identity for extractions', () => {
    const { lines } = renderContextLines(baseContext({
      source: { kind: 'extraction', ref: 'lecture.mp3', media_type: 'audio' },
    }));
    expect(lines[0]).toBe('Attachment: lecture.mp3 (audio)');
  });

  it('orders priority fields (aliases, project, people, tags, context, author) before links and the alphabetical rest', () => {
    const ctx = baseContext({
      fields: {
        zebra: 'z',
        author: 'Ada',
        tags: ['x', 'y'],
        aliases: ['Alias One'],
        project: 'Vault Engine',
      },
      links: ['Some Target'],
    });
    const rendered = renderContextLines(ctx).lines;
    const names = rendered.map(l => l.split(':')[0]);
    expect(names).toEqual([
      'Source', 'Title', 'Path', 'Types',
      'aliases', 'project', 'tags', 'author',
      'Links',
      'zebra',
    ]);
  });

  it('puts the vault map\'s people field where the default people field goes; none drops it', () => {
    const fields = { attendees: ['Ada'], 'people involved': ['Bo'], tags: ['x'], zebra: 'z' };
    const order = (priorityFields?: readonly string[]) => renderContextLines(baseContext({
      fields, ...(priorityFields === undefined ? {} : { priorityFields }),
    })).lines.slice(4).map(l => l.split(':')[0]);

    expect(order()).toEqual(['people involved', 'tags', 'attendees', 'zebra']);
    expect(order(semanticPriorityFields('Attendees'))).toEqual(['attendees', 'tags', 'people involved', 'zebra']);
    expect(order(semanticPriorityFields(null))).toEqual(['tags', 'attendees', 'people involved', 'zebra']);
  });

  it('preserves list order, sorts object keys, normalizes whitespace, dedupes, and omits empties', () => {
    const ctx = baseContext({
      fields: {
        tags: ['  b  ', 'a', 'b'],
        address: { zip: '75001', city: 'Paris' },
        multi: 'line one\n\n   line two',
        empty: '',
        nothing: null,
        emptyList: [],
      },
    });
    const rendered = renderContextLines(ctx).lines;
    expect(rendered).toContain('tags: b, a');
    expect(rendered).toContain('address: city: Paris, zip: 75001');
    expect(rendered).toContain('multi: line one line two');
    expect(rendered.some(l => l.startsWith('empty'))).toBe(false);
    expect(rendered.some(l => l.startsWith('nothing'))).toBe(false);
  });

  it('is deterministic regardless of field insertion order', () => {
    const a = renderSemanticContext(baseContext({ fields: { b: '2', a: '1', c: [1, 2] } }));
    const b = renderSemanticContext(baseContext({ fields: { c: [1, 2], a: '1', b: '2' } }));
    expect(a).toBe(b);
  });

  it('handles an empty node (identity rows only)', () => {
    const { lines, requiredCount } = renderContextLines({
      source: { kind: 'node' },
      title: '',
      path: 'orphan.md',
      types: [],
      fields: {},
      links: [],
    });
    expect(lines).toEqual(['Source: node', 'Path: orphan.md']);
    expect(requiredCount).toBe(2);
  });
});

describe('capContextLines', () => {
  it('keeps everything when within budget', () => {
    const cl = renderContextLines(baseContext({ fields: { status: 'open' } }));
    expect(capContextLines(cl, approxTokenize, 256)).toBe(cl.lines.join('\n'));
  });

  it('drops lower-priority rows but always keeps required identity rows', () => {
    const ctx = baseContext({
      fields: { 'a-long-field': 'x'.repeat(4000) },
    });
    const cl = renderContextLines(ctx);
    const capped = capContextLines(cl, approxTokenize, 30);
    expect(capped).toContain('Source: node');
    expect(capped).toContain('Title: My Note');
    expect(capped).toContain('Path: Notes/My Note.md');
    expect(capped).toContain('Types: note');
    // The long row did not fit; it was truncated into the remaining budget or dropped.
    expect(approxTokenize(capped)).toBeLessThanOrEqual(30);
  });

  it('truncates oversized identity values while preserving every identity row', () => {
    const cl = renderContextLines(baseContext({
      title: 't'.repeat(400),
      path: `Notes/${'p'.repeat(400)}.md`,
      types: ['note', 'project'],
    }));
    const capped = capContextLines(cl, approxTokenize, 30);
    expect(approxTokenize(capped)).toBeLessThanOrEqual(30);
    expect(capped).toContain('Source:');
    expect(capped).toContain('Title:');
    expect(capped).toContain('Path:');
    expect(capped).toContain('Types:');
  });

  it('tokenizer-truncates the first over-budget row', () => {
    const cl = {
      lines: ['Source: node', 'data: ' + 'v'.repeat(200)],
      requiredCount: 1,
    };
    const capped = capContextLines(cl, approxTokenize, 12);
    const cappedLines = capped.split('\n');
    expect(cappedLines[0]).toBe('Source: node');
    expect(cappedLines.length).toBe(2);
    expect(cappedLines[1].length).toBeLessThan(206);
    expect(cappedLines[1].startsWith('data: vvv')).toBe(true);
  });
});

describe('truncateToTokens', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateToTokens('hello', approxTokenize, 10)).toBe('hello');
  });

  it('binary-searches the largest fitting prefix', () => {
    const out = truncateToTokens('x'.repeat(100), approxTokenize, 10);
    expect(approxTokenize(out)).toBeLessThanOrEqual(10);
    expect(out.length).toBeGreaterThan(0);
    expect('x'.repeat(100).startsWith(out)).toBe(true);
  });

  it('returns empty string for a zero budget', () => {
    expect(truncateToTokens('hello', approxTokenize, 0)).toBe('');
  });
});

describe('semanticSourceHash', () => {
  const make = (overrides: Partial<EmbeddingDocumentContext> = {}, text = 'body') =>
    semanticSourceHash(baseContext(overrides), text);

  it('is a sha256 hex string', () => {
    expect(make()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the version tag (differs from a v2-style bare-content hash)', () => {
    const v2Style = createHash('sha256').update('My Note\n\nbody').digest('hex');
    expect(make()).not.toBe(v2Style);
  });

  it('changes for every meaningful context component', () => {
    const base = make();
    expect(make({ title: 'Other' })).not.toBe(base);
    expect(make({ path: 'Other.md' })).not.toBe(base);
    expect(make({ types: ['project'] })).not.toBe(base);
    expect(make({ fields: { status: 'open' } })).not.toBe(base);
    expect(make({ links: ['Target'] })).not.toBe(base);
    expect(make({ source: { kind: 'extraction', ref: 'a.pdf' } })).not.toBe(base);
    expect(make({}, 'other body')).not.toBe(base);
  });

  it('is stable for semantically identical fields in different insertion order', () => {
    const a = make({ fields: { b: '2', a: '1' } });
    const b = make({ fields: { a: '1', b: '2' } });
    expect(a).toBe(b);
  });

  it('does NOT change when only relationship resolution changes (raw targets used)', () => {
    // assembleDocumentContext reads raw targets, so two nodes identical except
    // for resolved_target_id produce the same context.
    insertNode('n1', 'S');
    insertNode('n2', 'T');
    insertLink('n1', 'T');
    const before = semanticSourceHash(assembleDocumentContext(db, 'n1')!, '');
    db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE source_id = ?').run('n2', 'n1');
    const after = semanticSourceHash(assembleDocumentContext(db, 'n1')!, '');
    expect(after).toBe(before);
  });

  it('adds nothing to the context for the default people field, so stored vectors stay current', () => {
    insertNode('n1', 'Sync', 'Notes/Sync.md', 'body');
    insertType('n1', 'meeting');
    insertField('n1', 'people involved', { json: ['Ada', 'Bo'] });
    insertField('n1', 'attendees', { json: ['Cy'] });
    insertLink('n1', 'Ada');
    expect(semanticPriorityFields('people involved')).toBeUndefined();
    expect(semanticPriorityFields('People Involved')).toBeUndefined();

    // The default map, stored or not, renders exactly the context of the hard-coded list.
    const hardCoded = [
      'Source: node', 'Title: Sync', 'Path: Notes/Sync.md', 'Types: meeting',
      'people involved: Ada, Bo', 'Links: Ada', 'attendees: Cy',
    ].join('\n');
    const defaultContext = assembleDocumentContext(db, 'n1')!;
    expect(defaultContext).not.toHaveProperty('priorityFields');
    expect(renderSemanticContext(boundDocumentContext(defaultContext))).toBe(hardCoded);
    const before = semanticSourceHash(defaultContext, 'body');
    setStoredSettings(db, 'vault', { peopleField: 'people involved' });
    expect(assembleDocumentContext(db, 'n1')).toEqual(defaultContext);
    expect(semanticSourceHash(assembleDocumentContext(db, 'n1')!, 'body')).toBe(before);

    // Another people field reorders the context, so the hash moves and the node re-embeds.
    setStoredSettings(db, 'vault', { peopleField: 'attendees' });
    const custom = assembleDocumentContext(db, 'n1')!;
    expect(custom.priorityFields).toEqual(['aliases', 'project', 'people', 'attendees', 'tags', 'context', 'author']);
    expect(renderSemanticContext(boundDocumentContext(custom)).split('\n').slice(4)).toEqual([
      'attendees: Cy', 'Links: Ada', 'people involved: Ada, Bo',
    ]);
    expect(semanticSourceHash(custom, 'body')).not.toBe(before);
  });

  it('embeds the version constant', () => {
    expect(SEMANTIC_CONTEXT_VERSION).toBe('semantic-context-v3');
  });
});
