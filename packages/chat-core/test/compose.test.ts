import { describe, expect, it } from 'vitest';
import type { ModelMessage, UIMessage } from 'ai';
import { composeSystem, currentDateLine, withoutDataParts, withoutEmptyAssistantMessages } from '../src/compose.js';

const NOW = new Date(2026, 6, 10); // local July 10 2026 — a Friday
const DATE_LINE = () => currentDateLine(NOW);

describe('currentDateLine', () => {
  it('formats weekday, local ISO date, and timezone', () => {
    expect(currentDateLine(NOW)).toMatch(/^Today is Friday, 2026-07-10 \(.+\)\.$/);
  });
  it('defaults to now', () => {
    expect(currentDateLine()).toMatch(/^Today is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
  });
});

describe('composeSystem', () => {
  it('appends the date line to the base when there is no context or stash', () => {
    expect(composeSystem('BASE', '', undefined, NOW)).toBe(`BASE\n\n${DATE_LINE()}`);
  });
  it('appends the date line, then the context block, then the stash, in order', () => {
    const out = composeSystem('BASE', '## Working context\nX', 'STASH', NOW);
    expect(out).toBe(`BASE\n\n${DATE_LINE()}\n\n## Working context\nX\n\n## Live app context (from an embedded surface)\nSTASH`);
  });
  it('appends only what is present (date line always)', () => {
    expect(composeSystem('BASE', '## ctx', undefined, NOW)).toBe(`BASE\n\n${DATE_LINE()}\n\n## ctx`);
    expect(composeSystem('BASE', '', 'STASH', NOW)).toBe(`BASE\n\n${DATE_LINE()}\n\n## Live app context (from an embedded surface)\nSTASH`);
  });
});

const textPart = { type: 'text' as const, text: 'hello' };
const dataPart = {
  type: 'data-ui' as const, id: 'c1',
  data: { toolCallId: 'c1', toolName: 'query-nodes', input: {}, output: {} },
};
const dynamicToolPart = {
  type: 'dynamic-tool' as const, toolName: 'query-nodes', toolCallId: 'c1',
  state: 'output-available' as const, input: {}, output: {},
};
const dynamicToolInputPart = {
  type: 'dynamic-tool' as const, toolName: 'query-nodes', toolCallId: 'c2',
  state: 'input-available' as const, input: {},
};

function makeMsg(parts: UIMessage['parts']): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as UIMessage;
}

describe('withoutDataParts', () => {
  it('strips data-ui parts from messages', () => {
    const result = withoutDataParts([makeMsg([textPart, dataPart])]);
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[0]?.parts[0]?.type).toBe('text');
  });
  it('preserves text parts', () => {
    const result = withoutDataParts([makeMsg([textPart])]);
    expect(result[0]?.parts).toEqual([textPart]);
  });
  it('preserves terminal dynamic-tool parts (output-available)', () => {
    const result = withoutDataParts([makeMsg([dynamicToolPart])]);
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[0]?.parts[0]?.type).toBe('dynamic-tool');
  });
  it('preserves non-terminal dynamic-tool parts (input-available) — withoutDataParts only strips data-* types', () => {
    const result = withoutDataParts([makeMsg([dynamicToolInputPart])]);
    expect(result[0]?.parts).toHaveLength(1);
  });
  it('does not mutate the original messages', () => {
    const parts = [textPart, dataPart];
    const msgs = [makeMsg(parts)];
    withoutDataParts(msgs);
    expect(msgs[0]?.parts).toHaveLength(2);
  });
  it('handles messages with no data parts unchanged', () => {
    const result = withoutDataParts([makeMsg([textPart, dynamicToolPart])]);
    expect(result[0]?.parts).toHaveLength(2);
  });
});

describe('withoutEmptyAssistantMessages', () => {
  const user: ModelMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
  const reasoning = { type: 'reasoning' as const, text: 'thinking' };
  const call = { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'query-nodes', input: {} };

  it('drops assistant messages with only reasoning, blank text, or nothing', () => {
    const dropped: ModelMessage[] = [
      { role: 'assistant', content: [reasoning] },
      { role: 'assistant', content: [reasoning, { type: 'text', text: '  \n' }] },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '   ' },
    ];
    expect(withoutEmptyAssistantMessages([user, ...dropped, user])).toEqual([user, user]);
  });

  it('keeps assistant messages with text, a tool call, or any other part', () => {
    const kept: ModelMessage[] = [
      { role: 'assistant', content: 'answer' },
      { role: 'assistant', content: [reasoning, { type: 'text', text: 'answer' }] },
      { role: 'assistant', content: [reasoning, call] },
      { role: 'assistant', content: [{ type: 'file', data: 'aGk=', mediaType: 'text/plain' }] },
    ];
    expect(withoutEmptyAssistantMessages(kept)).toEqual(kept);
  });

  it('leaves other roles alone', () => {
    const others: ModelMessage[] = [
      { role: 'system', content: '' },
      { role: 'user', content: '' },
      { role: 'tool', content: [] },
    ];
    expect(withoutEmptyAssistantMessages(others)).toEqual(others);
  });
});
