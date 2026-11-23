// Reading a note's frontmatter fields with their own lines, choosing which ones a
// re-render keeps as typed, and writing them back in place (#501).

import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import { keptFileFields, readFileFields, type FileField, type KeepRule } from '../../src/pipeline/kept-file-fields.js';
import { renderNode } from '../../src/renderer/render.js';
import type { EffectiveField, EffectiveFieldSet, GlobalFieldDefinition } from '../../src/validation/types.js';
import type { RenderInput } from '../../src/renderer/types.js';

describe('readFileFields', () => {
  it('reads each top-level field with its value, its stored form, and its own lines', () => {
    const content = '---\ntypes:\n  - task\nstatus: "Bogus"  # typed\nowner: "[[Someone|S]]"\n'
      + 'scores:\n  - 1\n  - two\n\n# a comment line\nnote: |\n  line one\n  line two\nflow: [a, 1]\n---\nBody\n';
    const fields = readFileFields(content);
    expect(fields.map(f => f.name)).toEqual(['types', 'status', 'owner', 'scores', 'note', 'flow']);
    const byName = new Map(fields.map(f => [f.name, f]));
    expect(byName.get('status')).toEqual({ name: 'status', raw: 'Bogus', value: 'Bogus', text: 'status: "Bogus"  # typed' });
    expect(byName.get('owner')).toMatchObject({ raw: '[[Someone|S]]', value: 'Someone', text: 'owner: "[[Someone|S]]"' });
    expect(byName.get('scores')).toMatchObject({ raw: [1, 'two'], text: 'scores:\n  - 1\n  - two' });
    expect(byName.get('note')).toMatchObject({ raw: 'line one\nline two\n', text: 'note: |\n  line one\n  line two' });
    expect(byName.get('flow')).toMatchObject({ raw: ['a', 1], text: 'flow: [a, 1]' });
  });

  it('drops the carriage returns of a CRLF file and reads past a byte-order mark', () => {
    const fields = readFileFields('﻿---\r\ntypes:\r\n  - task\r\nlist:\r\n  - x\r\n  - y\r\nstatus: bogus\r\n---\r\nBody\r\n');
    const byName = new Map(fields.map(f => [f.name, f]));
    expect(byName.get('list')?.text).toBe('list:\n  - x\n  - y');
    expect(byName.get('status')?.text).toBe('status: bogus');
  });

  it('takes the last of a key held twice, as the parser does', () => {
    const fields = readFileFields('---\nstatus: first\nother: 1\nstatus: second\n---\n');
    expect(fields.map(f => [f.name, f.raw, f.text])).toEqual([['other', 1, 'other: 1'], ['status', 'second', 'status: second']]);
  });

  it('has no lines for a field it cannot cut out on whole lines', () => {
    expect(readFileFields('---\n{status: bogus, size: 2}\n---\n').map(f => f.text)).toEqual([null, null]);
    expect(readFileFields('---\n  status: bogus\n  size: 2\n---\n').map(f => f.text)).toEqual([null, null]);
  });

  it('reads nothing from a file without frontmatter or with frontmatter that does not parse', () => {
    expect(readFileFields(null)).toEqual([]);
    expect(readFileFields('Just a body\n')).toEqual([]);
    expect(readFileFields('---\nstatus: [unclosed\n---\n')).toEqual([]);
    expect(readFileFields('---\n- a\n- b\n---\n')).toEqual([]);
    expect(readFileFields('---\nstatus: *missing\n---\n')).toEqual([]);
  });
});

function enumField(name: string, values: string[]): EffectiveField {
  const global_field: GlobalFieldDefinition = {
    name,
    field_type: 'enum',
    enum_values: values,
    reference_target: null,
    description: null,
    default_value: null,
    required: false,
    ai_guessable: false,
    overrides_allowed: { required: false, default_value: false, enum_values: false, ai_guessable: false },
    list_item_type: null,
    ui_hints: null,
  };
  return {
    field: name,
    global_field,
    resolved_label: null,
    resolved_description: null,
    resolved_order: 1,
    resolved_required: false,
    resolved_ai_guessable: false,
    resolved_default_value: null,
    default_source: 'global',
    claiming_types: ['task'],
  };
}

describe('keptFileFields', () => {
  const effectiveFields: EffectiveFieldSet = new Map([['status', enumField('status', ['open', 'closed'])]]);
  const file = (yaml: string) => readFileFields(`---\ntypes:\n  - task\n${yaml}---\n`);
  const rule = (over: Partial<KeepRule> = {}): KeepRule => ({
    stored: {},
    touched: [],
    explicitNull: new Set(),
    effectiveFields,
    keepUnstored: false,
    ...over,
  });
  const names = (kept: Map<string, FileField>) => [...kept.keys()];

  it('keeps a value that fails validation and that the database does not hold', () => {
    expect(names(keptFileFields(file('status: bogus\n'), rule()))).toEqual(['status']);
    expect(names(keptFileFields(file('status: bogus\n'), rule({ stored: { status: 'open' } })))).toEqual(['status']);
  });

  it('does not keep a value the database holds as given, or one that passes validation', () => {
    expect(names(keptFileFields(file('status: bogus\n'), rule({ stored: { status: 'bogus' } })))).toEqual([]);
    expect(names(keptFileFields(file('status: Open\n'), rule({ stored: { status: 'open' } })))).toEqual([]);
    expect(names(keptFileFields(file('note: free\n'), rule()))).toEqual([]);
  });

  it('keeps a field the database holds nothing for when the file is the one it last read', () => {
    expect(names(keptFileFields(file('note: free\nstatus: open\n'), rule({ keepUnstored: true })))).toEqual(['note', 'status']);
    expect(names(keptFileFields(file('note: free\n'), rule({ keepUnstored: true, stored: { note: 'other' } })))).toEqual([]);
  });

  it('never keeps a field the write names, stores as null, or changes', () => {
    expect(names(keptFileFields(file('status: bogus\n'), rule({ touched: ['status'] })))).toEqual([]);
    expect(names(keptFileFields(file('status: bogus\n'), rule({ explicitNull: new Set(['status']) })))).toEqual([]);
    expect(names(keptFileFields(file('status: bogus\n'), rule({ before: {}, stored: { status: 'open' } })))).toEqual([]);
    expect(names(keptFileFields(file('status: bogus\n'), rule({ before: { status: 'closed' }, stored: { status: 'open' } })))).toEqual([]);
  });

  it('keeps a value while the write fills the field with its default', () => {
    expect(names(keptFileFields(file('status: bogus\n'),
      rule({ before: {}, stored: { status: 'open' }, defaulted: new Set(['status']) })))).toEqual(['status']);
  });

  it('never keeps the type key or an empty value', () => {
    expect(names(keptFileFields(readFileFields('---\ntypes: 3\nstatus:\n---\n'), rule({ keepUnstored: true })))).toEqual([]);
  });
});

describe('renderNode with kept fields', () => {
  const base = (over: Partial<RenderInput>): RenderInput => ({
    types: ['task'],
    fields: {},
    body: 'Body\n',
    fieldOrdering: [],
    referenceFields: new Set(),
    listReferenceFields: new Set(),
    orphanRawValues: {},
    explicitNullFields: new Set(),
    ...over,
  });
  const keptFrom = (yaml: string) => new Map(readFileFields(`---\n${yaml}---\n`).map(f => [f.name, f]));

  it('writes a kept field\'s own lines in its place, byte for byte', () => {
    const keptFields = keptFrom('status: "Bogus"  # typed\nscores:\n    - 1\n    - two\n');
    const out = renderNode(base({
      fields: { size: 2, note: 'x' },
      fieldOrdering: [
        { field: 'status', category: 'claimed' },
        { field: 'size', category: 'claimed' },
        { field: 'scores', category: 'claimed' },
        { field: 'note', category: 'orphan' },
      ],
      keptFields,
    }));
    expect(out).toBe('---\ntypes:\n  - task\nstatus: "Bogus"  # typed\nsize: 2\nscores:\n    - 1\n    - two\nnote: x\n---\nBody\n');
  });

  it('writes the value as YAML read it when it has no lines of its own', () => {
    const keptFields = new Map([['status', { text: null, raw: 'bogus' }]]);
    const out = renderNode(base({ fieldOrdering: [{ field: 'status', category: 'claimed' }], keptFields }));
    expect(out).toBe('---\ntypes:\n  - task\nstatus: bogus\n---\nBody\n');
  });

  it('falls back to the value when the lines do not read back the same on their own', () => {
    // An alias to an anchor the render does not write.
    const keptFields = new Map([['status', { text: 'status: *missing', raw: 'bogus' }]]);
    const out = renderNode(base({ fieldOrdering: [{ field: 'status', category: 'claimed' }], keptFields }));
    expect(out).toBe('---\ntypes:\n  - task\nstatus: bogus\n---\nBody\n');
    expect(parseDocument(out.split('---\n')[1]).errors).toEqual([]);
  });

  it('falls back to the value when another value holds the placeholder text', () => {
    const keptFields = new Map([['status', { text: 'status:   bogus', raw: 'bogus' }]]);
    const out = renderNode(base({
      fields: { note: 've-kept-field-0-end' },
      fieldOrdering: [{ field: 'status', category: 'claimed' }, { field: 'note', category: 'orphan' }],
      keptFields,
    }));
    expect(out).toBe('---\ntypes:\n  - task\nstatus: bogus\nnote: ve-kept-field-0-end\n---\nBody\n');
  });

  it('renders exactly as before when nothing is kept', () => {
    const input = base({ fields: { size: 2 }, fieldOrdering: [{ field: 'size', category: 'claimed' }] });
    expect(renderNode({ ...input, keptFields: new Map() })).toBe(renderNode(input));
  });
});
