// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VizClientProvider, useVizCall, useVizClient, useVizVocabulary } from '../src/viz-client-context';
import { DEFAULT_VIEW_VOCABULARY } from '../src/view-vocabulary';

const okResult = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
});

describe('VizClientProvider', () => {
  it('useVizCall yields the injected CallFn', async () => {
    const call = async () => okResult({ nodes: [], total: 0 });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(VizClientProvider, { call }, children);
    const { result } = renderHook(() => useVizCall(), { wrapper });
    const res = await result.current({ name: 'query-nodes', arguments: {} });
    expect(res.content?.[0]).toMatchObject({ type: 'text' });
  });

  it('useVizClient wraps the CallFn into a typed Client', async () => {
    const call = async () => okResult({ nodes: [{ id: 'n1' }], total: 1 });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(VizClientProvider, { call }, children);
    const { result } = renderHook(() => useVizClient(), { wrapper });
    const env = await result.current.queryNodes({});
    expect(env.ok).toBe(true);
  });

  it('useVizClient returns the injected client override (test seam)', () => {
    const fakeClient = { queryNodes: async () => ({ ok: true }) } as unknown as import('@vault/query-core').Client;
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(VizClientProvider, { client: fakeClient }, children);
    const { result } = renderHook(() => useVizClient(), { wrapper });
    expect(result.current).toBe(fakeClient);
  });

  it('keeps the same client when a new vocabulary arrives (#449)', () => {
    const call = async () => okResult({});
    let vocabulary = DEFAULT_VIEW_VOCABULARY;
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(VizClientProvider, { call, vocabulary }, children);
    const { result, rerender } = renderHook(() => ({ client: useVizClient(), vocabulary: useVizVocabulary() }), { wrapper });
    const first = result.current.client;
    vocabulary = { ...DEFAULT_VIEW_VOCABULARY, taskType: 'todo' };
    rerender();
    expect(result.current.vocabulary.taskType).toBe('todo');
    expect(result.current.client).toBe(first);
  });

  it('useVizCall throws outside a provider', () => {
    expect(() => renderHook(() => useVizCall())).toThrow();
  });
});
