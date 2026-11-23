import { describe, it, expect } from 'vitest';
import {
  READ_ONLY_TOOLS,
  DRY_RUNNABLE_WRITES,
  UNVALIDATABLE_WRITES,
  toolKind,
} from './tools-readwrite.js';
import { classifyTurn } from './classify.js';

function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((x) => b.has(x));
}

describe('tools-readwrite', () => {
  it('the three sets are pairwise disjoint', () => {
    expect(intersection(READ_ONLY_TOOLS, DRY_RUNNABLE_WRITES)).toEqual([]);
    expect(intersection(READ_ONLY_TOOLS, UNVALIDATABLE_WRITES)).toEqual([]);
    expect(intersection(DRY_RUNNABLE_WRITES, UNVALIDATABLE_WRITES)).toEqual([]);
  });

  it('toolKind classifies known reads and writes', () => {
    expect(toolKind('query-nodes')).toBe('read');
    expect(toolKind('update-node')).toBe('write-dry-runnable');
    expect(toolKind('wiki-write')).toBe('write-unvalidatable');
  });

  it('toolKind returns unknown for unlisted tools (e.g. curator-connection tools)', () => {
    expect(toolKind('create-wiki')).toBe('unknown');
  });

  it('client-side present-viz and load-vault-tools are reads', () => {
    expect(toolKind('present-viz')).toBe('read');
    expect(toolKind('load-vault-tools')).toBe('read');
  });
});

describe('classifyTurn', () => {
  it('empty turn is trivial', () => {
    expect(classifyTurn([])).toBe('trivial');
  });

  it('single write tool is single-write', () => {
    expect(classifyTurn(['update-node'])).toBe('single-write');
  });

  it('single read tool is single-read', () => {
    expect(classifyTurn(['query-nodes'])).toBe('single-read');
  });

  it('a turn with a write mixed into reads is complex, even at 3 calls', () => {
    expect(classifyTurn(['query-nodes', 'get-node', 'update-node'])).toBe('complex');
  });

  it('two reads is multi-read', () => {
    expect(classifyTurn(['query-nodes', 'get-node'])).toBe('multi-read');
  });

  it('5 or more reads is complex', () => {
    expect(
      classifyTurn(['query-nodes', 'get-node', 'get-board', 'get-conversation', 'get-memory'])
    ).toBe('complex');
  });
});
