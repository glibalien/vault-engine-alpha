// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CallFn } from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context.js';
import { useProvenanceInspector } from '../src/use-provenance-inspector.js';
import {
  defaultCall,
  deferred,
  env,
  status,
  inputPage,
} from './helpers/provenance-inspector.js';
afterEach(cleanup);
const target = { nodeId: 'home', title: 'Home', path: 'Home.md' };
it('stops before history on an older Engine', async () => {
  const calls: string[] = [];
  const call: CallFn = async (req) => {
    calls.push(String(req.arguments.select));
    return env(status(false));
  };
  const { result } = renderHook(
    () =>
      useProvenanceInspector({
        target,
        connectionKey: 1,
        hasInspectionTool: true,
      }),
    {
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.capability).toBe('unsupported'));
  expect(calls).toEqual(['status']);
});
it('ignores late input results after a target switch', async () => {
  const late = deferred<Awaited<ReturnType<CallFn>>>();
  let outputCalls = 0;
  const call: CallFn = (req) =>
    req.arguments.select === 'output'
      ? outputCalls++ === 0
        ? late.promise
        : Promise.resolve(env(inputPage('out', 'other')))
      : defaultCall(req);
  const { result, rerender } = renderHook(
    ({ t }) =>
      useProvenanceInspector({
        target: t,
        connectionKey: 1,
        hasInspectionTool: true,
      }),
    {
      initialProps: { t: target },
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(outputCalls).toBe(1));
  rerender({ t: { ...target, nodeId: 'other' } });
  await waitFor(() => expect(outputCalls).toBe(2));
  await waitFor(() =>
    expect(
      result.current.outputPages[0]?.data?.output.receipt.output_node_id,
    ).toBe('other'),
  );
  await act(async () => late.resolve(env(inputPage('WRONG'))));
  expect(
    result.current.outputPages[0]?.data?.output.receipt.output_revision_id,
  ).toBe('out');
});
it('clears text on refresh and revocation instead of combining pages', async () => {
  let revoked = false;
  const call: CallFn = (req) =>
    revoked && req.arguments.select === 'input_text'
      ? Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: {
                  code: 'VALIDATION_FAILED',
                  message: 'PROVENANCE_REVOKED',
                  details: { reason: 'PROVENANCE_REVOKED' },
                },
                warnings: [],
              }),
            },
          ],
        })
      : defaultCall(req);
  const { result } = renderHook(
    () =>
      useProvenanceInspector({
        target,
        connectionKey: 1,
        hasInspectionTool: true,
      }),
    {
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  act(() => result.current.selectInput('input'));
  await waitFor(() => expect(result.current.text.data).toBeTruthy());
  revoked = true;
  act(() => result.current.nextText());
  await waitFor(() =>
    expect(result.current.text.error).toContain('PROVENANCE_REVOKED'),
  );
  expect(result.current.text.data).toBeNull();
  expect(result.current.canPreviousText).toBe(false);
  act(() => result.current.refresh());
  expect(result.current.text.data).toBeNull();
});
it('retains a selected historical generation outside the refreshed first page', async () => {
  let latest = 'out';
  const call: CallFn = (req) =>
    req.arguments.select === 'node'
      ? Promise.resolve(
          env({
            select: 'node',
            outputs: [{ ...(inputPage(latest) as any).output }],
            current_provenance: 'captured',
            next_cursor: null,
          }),
        )
      : defaultCall(req);
  const { result } = renderHook(
    () =>
      useProvenanceInspector({
        target,
        connectionKey: 1,
        hasInspectionTool: true,
      }),
    {
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  act(() => result.current.selectOutput('old'));
  await waitFor(() => expect(result.current.selectedOutputId).toBe('old'));
  latest = 'new';
  act(() => result.current.refresh());
  await waitFor(() =>
    expect(
      result.current.history[0]?.data?.outputs[0]?.receipt.output_revision_id,
    ).toBe('new'),
  );
  await waitFor(() =>
    expect(
      result.current.outputPages[0]?.data?.output.receipt.output_revision_id,
    ).toBe('old'),
  );
});
it('loads a preferred generation outside the first history page', async () => {
  const calls: string[] = [];
  const call: CallFn = async (request) => {
    if (request.arguments.select === 'output')
      calls.push(String(request.arguments.output_revision_id));
    return defaultCall(request);
  };
  const { result } = renderHook(
    () =>
      useProvenanceInspector({
        target,
        connectionKey: 1,
        hasInspectionTool: true,
        preferredOutputId: 'historical-impact',
      }),
    {
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() =>
    expect(result.current.selectedOutputId).toBe('historical-impact'),
  );
  expect(calls).toContain('historical-impact');
});
it('clears displayed text immediately on connection replacement and ignores the late page', async () => {
  const late = deferred<Awaited<ReturnType<CallFn>>>();
  const call: CallFn = (req) =>
    req.arguments.select === 'input_text' ? late.promise : defaultCall(req);
  const { result, rerender } = renderHook(
    ({ key }) =>
      useProvenanceInspector({
        target,
        connectionKey: key,
        hasInspectionTool: true,
      }),
    {
      initialProps: { key: 1 },
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  act(() => result.current.selectInput('input'));
  rerender({ key: 2 });
  await act(async () =>
    late.resolve(
      await defaultCall({
        name: 'inspect-provenance',
        arguments: {
          select: 'input_text',
          output_revision_id: 'out',
          input_id: 'input',
        },
      }),
    ),
  );
  expect(result.current.text.data).toBeNull();
  expect(result.current.selectedInputId).toBeNull();
});
it('can select a generation while an older history page is in flight', async () => {
  const late = deferred<Awaited<ReturnType<CallFn>>>();
  const call: CallFn = (req) =>
    req.arguments.select === 'node'
      ? req.arguments.cursor
        ? late.promise
        : defaultCall(req).then((r) => {
            const v = JSON.parse((r.content[0] as any).text);
            return env({ ...v.data, next_cursor: 'older' });
          })
      : defaultCall(req);
  const { result } = renderHook(
    () =>
      useProvenanceInspector({
        target,
        connectionKey: 1,
        hasInspectionTool: true,
      }),
    {
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  act(() => result.current.loadOlder());
  act(() => result.current.selectOutput('old'));
  await act(async () =>
    late.resolve(
      env({
        select: 'node',
        outputs: [],
        current_provenance: 'captured',
        next_cursor: null,
      }),
    ),
  );
  expect(result.current.history.some((p) => p.loading)).toBe(false);
});
it('invalidates pending text when history reports the selected capture purged', async () => {
  const late = deferred<Awaited<ReturnType<CallFn>>>();
  let purged = false;
  const call: CallFn = (req) => {
    if (req.arguments.select === 'node')
      return Promise.resolve(
        env({
          select: 'node',
          outputs: req.arguments.cursor
            ? [{ ...(inputPage('old') as any).output, availability: 'purged' }]
            : [(inputPage() as any).output],
          current_provenance: 'captured',
          next_cursor: req.arguments.cursor ? null : 'older',
        }),
      );
    if (req.arguments.select === 'input_text' && req.arguments.cursor)
      return late.promise;
    if (req.arguments.select === 'output' && purged)
      return Promise.resolve(
        env({
          ...inputPage(req.arguments.output_revision_id as string),
          output: {
            ...(inputPage('old') as any).output,
            availability: 'purged',
          },
        }),
      );
    return defaultCall(req);
  };
  const { result } = renderHook(
    () =>
      useProvenanceInspector({
        target,
        connectionKey: 1,
        hasInspectionTool: true,
      }),
    {
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  act(() => result.current.selectOutput('old'));
  await waitFor(() =>
    expect(
      result.current.outputPages[0]?.data?.output.receipt.output_revision_id,
    ).toBe('old'),
  );
  act(() => result.current.selectInput('input'));
  await waitFor(() => expect(result.current.text.data).toBeTruthy());
  act(() => result.current.nextText());
  purged = true;
  act(() => result.current.loadOlder());
  await waitFor(() => expect(result.current.history).toHaveLength(2));
  await act(async () =>
    late.resolve(
      await defaultCall({
        name: 'inspect-provenance',
        arguments: {
          select: 'input_text',
          output_revision_id: 'old',
          input_id: 'input',
          cursor: 'next',
        },
      }),
    ),
  );
  expect(result.current.text.data).toBeNull();
  expect(result.current.canPreviousText).toBe(false);
});
it('keeps namespace replacement rejected across repeated refreshes', async () => {
  let namespace = 'fixture',
    wrongReads = 0;
  const call: CallFn = (req) => {
    if (req.arguments.select === 'status')
      return Promise.resolve(env({ ...status(), vault_namespace: namespace }));
    if (namespace === 'replacement' && req.arguments.select === 'node')
      wrongReads++;
    return defaultCall(req);
  };
  const { result } = renderHook(
    () =>
      useProvenanceInspector({
        target,
        connectionKey: 1,
        hasInspectionTool: true,
      }),
    {
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.outputPages[0]?.data).toBeTruthy());
  namespace = 'replacement';
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.capability).toBe('error'));
  act(() => result.current.refresh());
  await act(async () => {});
  expect(wrongReads).toBe(0);
  expect(result.current.capability).toBe('error');
});
