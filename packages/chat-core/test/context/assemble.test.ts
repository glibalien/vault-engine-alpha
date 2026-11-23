import { describe, expect, it } from 'vitest';
import { assembleContext } from '../../src/context/assemble.js';
import type { ContextProvider, ContextProviderInput } from '../../src/context/types.js';

const input: ContextProviderInput = {
  call: async () => ({ content: [] }),
  manifest: {},
  state: { doc: true, board: true, nodes: [] },
  estimateTokens: (t) => t.length,
};
const fixed = (key: string, text: string | null): ContextProvider => ({
  key,
  build: async () => (text === null ? null : { label: key, text, tokens: text.length }),
});

describe('assembleContext', () => {
  it('returns empty when no provider contributes', async () => {
    expect(await assembleContext([fixed('a', null)], input)).toEqual({ text: '', sections: [] });
  });
  it('composes contributed sections under a Working context heading', async () => {
    const r = await assembleContext([fixed('doc', 'D'), fixed('skip', null), fixed('board', 'B')], input);
    expect(r.text).toBe('## Working context\nD\n\nB');
    expect(r.sections).toEqual([{ label: 'doc', tokens: 1 }, { label: 'board', tokens: 1 }]);
  });
  it('skips a throwing provider without failing the turn', async () => {
    const boom: ContextProvider = { key: 'boom', build: async () => { throw new Error('x'); } };
    const r = await assembleContext([boom, fixed('board', 'B')], input);
    expect(r.text).toBe('## Working context\nB');
  });
});
