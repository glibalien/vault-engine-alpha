import { describe, expect, it } from 'vitest';
import { flattenTranscript } from '../src/transcript.js';

/** Real part-type mix observed in the live DB: dynamic-tool 25.1 MB, reasoning
 *  2.18 MB, text 927 KB, data-ui 858 KB, data-viz 81 KB, step-start 47 KB. */
const msg = (role: string, parts: unknown[]) => ({ id: 'm', role, parts });

describe('flattenTranscript', () => {
  it('keeps text parts and attributes roles', () => {
    const r = flattenTranscript([
      msg('user', [{ type: 'text', text: 'switch the curator to qwen' }]),
      msg('assistant', [{ type: 'text', text: 'done' }]),
    ]);
    expect(r.turns).toEqual([
      { role: 'user', text: 'switch the curator to qwen' },
      { role: 'assistant', text: 'done' },
    ]);
    expect(r.userChars).toBe('switch the curator to qwen'.length);
    expect(r.droppedParts).toBe(0);
  });

  it('drops every non-text part type and counts them', () => {
    const r = flattenTranscript([
      msg('assistant', [
        { type: 'step-start' },
        { type: 'reasoning', text: 'the user probably means X' },
        { type: 'dynamic-tool', toolName: 'query-nodes', output: { nodes: [] } },
        { type: 'data-ui', data: { big: 'blob' } },
        { type: 'data-viz', data: { spec: {} } },
        { type: 'tool-web_search', output: {} },
        { type: 'text', text: 'kept' },
      ]),
    ]);
    expect(r.turns).toEqual([{ role: 'assistant', text: 'kept' }]);
    expect(r.droppedParts).toBe(6);
  });

  it('drops unrecognized part types (allowlist, not blocklist)', () => {
    const r = flattenTranscript([msg('user', [{ type: 'some-future-type', text: 'nope' }])]);
    expect(r.turns).toEqual([]);
    expect(r.droppedParts).toBe(1);
    expect(r.userChars).toBe(0);
  });

  it('userChars counts user text only', () => {
    const r = flattenTranscript([
      msg('user', [{ type: 'text', text: 'abcde' }]),
      msg('assistant', [{ type: 'text', text: 'a much longer assistant reply' }]),
    ]);
    expect(r.userChars).toBe(5);
  });

  it('joins multiple text parts in one message with a blank line', () => {
    const r = flattenTranscript([msg('user', [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])]);
    expect(r.turns).toEqual([{ role: 'user', text: 'first\n\nsecond' }]);
  });

  it('emits no turn for a message whose parts are all dropped', () => {
    const r = flattenTranscript([
      msg('assistant', [{ type: 'dynamic-tool', output: {} }]),
      msg('user', [{ type: 'text', text: 'kept' }]),
    ]);
    expect(r.turns).toEqual([{ role: 'user', text: 'kept' }]);
  });

  it('tolerates malformed input without throwing', () => {
    expect(flattenTranscript([]).turns).toEqual([]);
    expect(flattenTranscript([null, undefined, 'x', 42]).turns).toEqual([]);
    expect(flattenTranscript([msg('user', [])]).turns).toEqual([]);
    expect(flattenTranscript([{ id: 'm', role: 'user' }]).turns).toEqual([]);
    expect(flattenTranscript([msg('user', [null, { type: 'text' }, { type: 'text', text: 7 }])]).turns).toEqual([]);
    expect(flattenTranscript([msg('system', [{ type: 'text', text: 'ignored' }])]).turns).toEqual([]);
  });

  it('skips empty and whitespace-only text parts without counting them as dropped', () => {
    const r = flattenTranscript([msg('user', [{ type: 'text', text: '   ' }])]);
    expect(r.turns).toEqual([]);
    expect(r.droppedParts).toBe(0);
  });
});
