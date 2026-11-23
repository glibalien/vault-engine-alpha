import { describe, expect, it } from 'vitest';
import { buildIdentityIndex } from '../../src/reference-edits/identity.js';

describe('reference member identity', () => {
  const rows = [
    { id: 'a', title: 'Alpha', file_path: 'Projects/Alpha.md' },
    { id: 'b', title: 'Other', file_path: 'Else/Alpha.md' },
    { id: 'c', title: 'Café', file_path: 'Café.md' },
  ];
  it('uses the first complete matching tier, without guessing the shortest path', () => {
    const index = buildIdentityIndex(rows);
    expect(index.candidates('Projects/Alpha.md').map(n => n.id)).toEqual(['a']);
    expect(index.candidates('Alpha').map(n => n.id)).toEqual(['a']);
    expect(index.candidates('Alpha.md').map(n => n.id)).toEqual(['a', 'b']);
    expect(index.candidates('ALPHA').map(n => n.id)).toEqual(['a', 'b']);
    expect(index.candidates('CAFE\u0301').map(n => n.id)).toEqual(['c']);
    expect(index.candidates('Projects/Alpha')).toEqual([]);
    expect(buildIdentityIndex([...rows, { id: 'd', title: 'Alpha', file_path: 'A.md' }]).candidates('Alpha')).toHaveLength(2);
  });
  it('requires safe spelling and unique filename resolution when adding', () => {
    expect(() => buildIdentityIndex(rows).additionTitle('a')).toThrow(/ambiguous/i);
    expect(buildIdentityIndex(rows).additionTitle('c')).toBe('Café');
    for (const title of [' Name', 'A|B', 'A#B', '[[A]]', 'A\nB', 'A^B', '']) {
      expect(() => buildIdentityIndex([{ id: 'x', title, file_path: `${title}.md` }]).additionTitle('x')).toThrow();
    }
    expect(() => buildIdentityIndex([{ id: 'x', title: 'A:B', file_path: 'A-B.md' }]).additionTitle('x')).toThrow();
  });
  it('accepts the catalog boundary and stops at the first excessive row', () => {
    const nodes = Array.from({ length: 50_000 }, (_, i) => ({ id: String(i), title: String(i), file_path: `${i}.md` }));
    expect(buildIdentityIndex(nodes).candidates('49999')).toHaveLength(1);
    let consumed = 0;
    function* excessive() { for (const node of [...nodes, nodes[0], nodes[0]]) { consumed++; yield node; } }
    expect(() => buildIdentityIndex(excessive())).toThrow(/limit/i);
    expect(consumed).toBe(50_001);
    expect(() => buildIdentityIndex([{ id: 'x', title: '界'.repeat(6_000_000), file_path: 'x.md' }])).toThrow(/limit/i);
  });
  it('enforces the exact encoded metadata byte boundary', () => {
    const empty = { id: 'x', file_path: 'x.md', title: '' };
    const padding = 16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty), 'utf8');
    const row = { ...empty, title: 'x'.repeat(padding) };
    expect(buildIdentityIndex([row]).candidates('x.md')).toHaveLength(1);
    expect(() => buildIdentityIndex([{ ...row, title: row.title + 'x' }])).toThrow(/limit/i);
  });
});
