import { afterEach, expect, it } from 'vitest';
import { inspectionFixture } from './inspection-fixture.js';
import { bundleFixture } from './fixture.js';
import { inputDigest } from '../../src/provenance/validation.js';
import { inspectProvenance } from '../../src/provenance/inspect.js';
import { clearDerivation } from '../../src/provenance/purge.js';
const fixtures: ReturnType<typeof inspectionFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.db.close()));
const fixture = (bundle = bundleFixture('aé😀z')) => {
  const f = inspectionFixture(bundle);
  fixtures.push(f);
  return f;
};
it('returns exact retained input with UTF-8 pages and bound coordinates', () => {
  const { db, inputId } = fixture();
  let cursor: string | undefined;
  let restored = '';
  const seen = new Set<string>();
  do {
    const page = inspectProvenance(db, {
      select: 'input_text',
      output_revision_id: 'output',
      input_id: inputId,
      max_bytes: 4,
      cursor,
    });
    if (page.select !== 'input_text') throw Error('selector');
    expect(
      page.segments.reduce((n, s) => n + Buffer.byteLength(s.text), 0),
    ).toBeLessThanOrEqual(4);
    expect(
      page.segments.every(
        (s) => s.start >= s.span_start && s.end <= s.span_end,
      ),
    ).toBe(true);
    restored += page.segments.map((s) => s.text).join('');
    cursor = page.next_cursor ?? undefined;
    if (cursor) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
    }
  } while (cursor);
  expect(restored).toBe('aé😀z');
});
it.each(['purged', 'expired'] as const)(
  'revokes continuation after %s, but not after ordinary source deletion',
  (availability) => {
    const { db, inputId, prepared } = fixture();
    const req = {
      select: 'input_text' as const,
      output_revision_id: 'output',
      input_id: inputId,
      max_bytes: 4,
    };
    db.prepare("DELETE FROM nodes WHERE id='source'").run();
    const first = inspectProvenance(db, req);
    if (first.select !== 'input_text') throw Error('selector');
    expect(first.segments[0]?.text).toBe('aé');
    db.transaction(() =>
      clearDerivation(
        db,
        prepared.derivation_id,
        availability,
        new Date().toISOString(),
      ),
    )();
    expect(() =>
      inspectProvenance(db, { ...req, cursor: first.next_cursor! }),
    ).toThrow('PROVENANCE_REVOKED');
    expect(inspectProvenance(db, req)).toMatchObject({
      availability,
      input_digest: null,
      segments: [],
      next_cursor: null,
    });
  },
);
it('bounds empty spans and preserves repeated/disjoint spans', () => {
  const b = bundleFixture('aé😀z');
  const item = b.items[0]!;
  item.spans = [
    ...Array.from({ length: 65 }, () => ({
      field: 'evidence',
      start: 0,
      end: 0,
    })),
    { field: 'evidence', start: 3, end: 7 },
    { field: 'evidence', start: 0, end: 3 },
    { field: 'evidence', start: 3, end: 7 },
  ];
  item.retained_bytes = 11;
  item.input_digest = inputDigest(item.spans, b.decoded_fields);
  const { db, inputId } = fixture(b);
  const req = {
    select: 'input_text' as const,
    output_revision_id: 'output',
    input_id: inputId,
  };
  const first = inspectProvenance(db, req);
  if (first.select !== 'input_text') throw Error('selector');
  expect(first.segments).toHaveLength(64);
  expect(first.next_cursor).toBeTruthy();
  const second = inspectProvenance(db, { ...req, cursor: first.next_cursor! });
  if (second.select !== 'input_text') throw Error('selector');
  expect(second.segments.map((s) => [s.span_index, s.text])).toEqual([
    [64, ''],
    [65, '😀'],
    [66, 'aé'],
    [67, '😀'],
  ]);
  expect(second.next_cursor).toBeNull();
});
it('rejects mismatched ownership, corrupt captures and cursor reuse', () => {
  const { db, inputId } = fixture();
  const req = {
    select: 'input_text' as const,
    output_revision_id: 'output',
    input_id: inputId,
    max_bytes: 4,
  };
  expect(() =>
    inspectProvenance(db, { ...req, input_id: 'different' }),
  ).toThrow('PROVENANCE_UNAVAILABLE');
  expect(() => inspectProvenance(db, { ...req, cursor: 'bad' })).toThrow(
    'PROVENANCE_LIMIT',
  );
  db.prepare(
    "UPDATE provenance_payloads SET text='corrupt' WHERE kind='attribution'",
  ).run();
  expect(() => inspectProvenance(db, req)).toThrow('PROVENANCE_UNAVAILABLE');
});
it('rejects corrupt span metadata and cursor reuse against another input', () => {
  const { db, inputId } = fixture();
  const req = {
    select: 'input_text' as const,
    output_revision_id: 'output',
    input_id: inputId,
    max_bytes: 4,
  };
  const first = inspectProvenance(db, req);
  if (first.select !== 'input_text') throw Error('selector');
  const cursor = JSON.parse(
    Buffer.from(first.next_cursor!, 'base64url').toString('utf8'),
  );
  cursor.offset = 2;
  expect(() =>
    inspectProvenance(db, {
      ...req,
      cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'),
    }),
  ).toThrow('PROVENANCE_LIMIT');
  const row = db.prepare('SELECT * FROM provenance_inputs').get() as Record<
    string,
    unknown
  >;
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO provenance_inputs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
  ).run(
    ...keys.map((k) =>
      k === 'id' ? 'other' : k === 'item_key' ? 'other' : row[k],
    ),
  );
  expect(() =>
    inspectProvenance(db, {
      ...req,
      input_id: 'other',
      cursor: first.next_cursor!,
    }),
  ).toThrow('PROVENANCE_UNAVAILABLE');
  db.prepare("UPDATE provenance_inputs SET spans='[]' WHERE id=?").run(inputId);
  expect(() => inspectProvenance(db, req)).toThrow('PROVENANCE_UNAVAILABLE');
});
