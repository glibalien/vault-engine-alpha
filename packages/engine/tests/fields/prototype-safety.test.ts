import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';
import { renderNode } from '../../src/renderer/render.js';
import { overlayExplicitNullFields } from '../../src/fields/explicit-null.js';
import { validateProposedState } from '../../src/validation/validate.js';
import { loadSchemaContext } from '../../src/pipeline/schema-context.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createTestDb } from '../helpers/db.js';
import { evaluateTemplate } from '../../src/schema/paths.js';
import { coerceValue } from '../../src/validation/coerce.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { createTempVault } from '../helpers/vault.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const names = ['__proto__', 'prototype', 'constructor', 'toString'];

describe('prototype-sensitive field values', () => {
  it.each(names)('indexes %s with supported duplicate YAML keys', name => {
    const db = createTestDb();
    const { vaultPath, cleanup } = createTempVault();
    try {
      const path = join(vaultPath, 'Duplicate.md');
      writeFileSync(path, `---\n${name}: Keep\nx: first\nx: last\n---\nBody`);
      indexFile(path, vaultPath, db);
      expect(db.prepare('SELECT value_text, value_raw_text FROM node_fields WHERE field_name = ?').get(name))
        .toEqual({ value_text: 'Keep', value_raw_text: null });
      expect(db.prepare('SELECT value_text FROM node_fields WHERE field_name = ?').get('x'))
        .toEqual({ value_text: 'last' });
    } finally {
      db.close();
      cleanup();
    }
  });

  it.each(names)('uses only own field values in filename templates for %s', name => {
    expect(evaluateTemplate(`{${name}}.md`, 'Title', {})).toBeNull();
    expect(evaluateTemplate(`{${name}}.md`, 'Title', Object.fromEntries([[name, 'Own name']]))).toBe('Own name.md');
  });

  it.each(names)('round-trips the own orphan field %s without inherited raw text', name => {
    const fields = Object.fromEntries([[name, 'Keep this value']]);
    const rendered = renderNode({
      types: [], fields, body: 'Body', fieldOrdering: [{ field: name, category: 'orphan' }],
      referenceFields: new Set(), listReferenceFields: new Set(), orphanRawValues: {},
      explicitNullFields: new Set(),
    });
    expect(parseFrontmatter(rendered).fields.get(name)).toBe('Keep this value');
  });

  it.each(names)('preserves an explicit-null marker for %s', name => {
    const overlay = overlayExplicitNullFields({}, [name]);
    expect(Object.hasOwn(overlay.fields, name)).toBe(true);
    expect(overlay.fields[name]).toBeNull();
    const rendered = renderNode({
      types: [], fields: {}, body: '', fieldOrdering: [], referenceFields: new Set(),
      listReferenceFields: new Set(), orphanRawValues: {}, explicitNullFields: new Set([name]),
    });
    expect(parseFrontmatter(rendered).fields.has(name)).toBe(true);
    expect(parseFrontmatter(rendered).fields.get(name)).toBeNull();
  });

  it.each(names)('validates own values and missing required fields for %s', name => {
    const db = createTestDb();
    try {
      createGlobalField(db, { name, field_type: 'string', required: true });
      createSchemaDefinition(db, { name: 'Task', field_claims: [{ field: name }] });
      const { claimsByType, globalFields } = loadSchemaContext(db, ['Task']);
      const absent = validateProposedState({}, ['Task'], claimsByType, globalFields);
      expect(absent.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: name, code: 'REQUIRED_MISSING' })]));
      const present = validateProposedState(Object.fromEntries([[name, 'Own value']]), ['Task'], claimsByType, globalFields);
      expect(present.valid).toBe(true);
      expect(Object.hasOwn(present.coerced_state, name)).toBe(true);
      expect(present.coerced_state[name].value).toBe('Own value');
    } finally {
      db.close();
    }
  });

  it('preserves nested YAML keys while extracting wikilinks', () => {
    const parsed = parseFrontmatter('---\ncustom:\n  __proto__: "[[Target]]"\n  constructor: literal\n---\n');
    const value = parsed.fields.get('custom') as Record<string, unknown>;
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value['__proto__']).toBe('Target');
    expect(value.constructor).toBe('literal');
    expect(parsed.wikiLinks).toEqual([expect.objectContaining({ target: 'Target', context: 'custom' })]);
  });

  it('retains ordinary object coercion for nested YAML values', () => {
    const parsed = parseFrontmatter('---\nstatus:\n  nested: value\n---\n');
    expect(coerceValue(parsed.fields.get('status'), 'enum', { enum_values: ['open', 'closed'] }))
      .toMatchObject({ ok: false });
  });
});
