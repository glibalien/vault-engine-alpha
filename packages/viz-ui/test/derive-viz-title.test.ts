import { expect, test } from 'vitest';
import { deriveVizTitle } from '../src/viz-spec.js';
test('user-set title wins', () => {
  expect(deriveVizTitle({ title: 'My board' } as any, 'task')).toBe('My board');
});
test('empty title derives from locked type', () => {
  expect(deriveVizTitle({ title: '' } as any, 'meeting')).toBe('meeting');
});
test('whitespace-only title is treated as empty (trim guard)', () => {
  expect(deriveVizTitle({ title: '   ' } as any, 'task')).toBe('task');
});
test('empty title + no lock → Mixed results', () => {
  expect(deriveVizTitle({ title: '' } as any, null)).toBe('Mixed results');
});
