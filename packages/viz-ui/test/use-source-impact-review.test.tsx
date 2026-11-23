// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CallFn } from '@vault/query-core';
import { VizClientProvider } from '../src/viz-client-context.js';
import {
  useSourceImpactReview,
  type SourceImpactReviewOptions,
} from '../src/use-source-impact-review.js';
import {
  deferred,
  env,
  status,
} from './helpers/provenance-inspector.js';
import {
  impactOutput,
  impactPage,
} from './helpers/source-impact-review.js';

afterEach(cleanup);

const sourceTarget = {
  nodeId: 'source-input',
  title: 'Source',
  path: 'Source.md',
};

const defaults: SourceImpactReviewOptions = {
  target: sourceTarget,
  connectionKey: 1,
  hasInspectionTool: true,
  hasImpactTool: true,
};

function nodePage(id = 'generated-home') {
  return {
    nodes: [
      {
        id,
        file_path: 'Wikis/Home.md',
        title: 'Home',
        version: 2,
        types: ['wiki'],
        field_count: 0,
      },
    ],
    total: 1,
  };
}

function renderImpactHook(
  call: CallFn,
  initialProps: SourceImpactReviewOptions = defaults,
) {
  return renderHook(
    (props: SourceImpactReviewOptions) => useSourceImpactReview(props),
    {
      initialProps,
      wrapper: ({ children }) => (
        <VizClientProvider call={call}>{children}</VizClientProvider>
      ),
    },
  );
}

it('continues after an empty filtered page and finds the next candidate', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return env(status());
    if (request.name === 'find-affected-outputs') {
      calls.push(request.arguments);
      return env(
        request.arguments.cursor
          ? impactPage([impactOutput()])
          : impactPage([], 'scan-cursor'),
      );
    }
    if (request.name === 'query-nodes') return env(nodePage());
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() =>
    expect(result.current.currentPages[0]?.data?.impact.outputs).toEqual([]),
  );
  act(() => result.current.loadMoreCurrent());
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(1));
  expect(calls).toEqual([
    {
      sources: [
        { kind: 'node', namespace: 'fixture', native_id: 'source-input' },
      ],
      currentness: 'current',
      limit: 20,
    },
    {
      sources: [
        { kind: 'node', namespace: 'fixture', native_id: 'source-input' },
      ],
      currentness: 'current',
      limit: 20,
      cursor: 'scan-cursor',
    },
  ]);
});

it('keeps an impact receipt when node hydration fails', async () => {
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return env(status());
    if (request.name === 'find-affected-outputs')
      return env(impactPage([impactOutput()]));
    if (request.name === 'query-nodes') throw Error('Hydration unavailable');
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(1));
  expect(result.current.currentCandidates[0]?.target).toEqual({
    nodeId: 'generated-home',
    title: null,
    path: null,
  });
  expect(result.current.currentPages[0]?.data?.hydrationError).toBe(
    'Hydration unavailable',
  );
});

it('publishes stable-ID candidates while optional hydration is pending', async () => {
  const hydration = deferred<Awaited<ReturnType<CallFn>>>();
  const call: CallFn = (request) => {
    if (request.name === 'inspect-provenance')
      return Promise.resolve(env(status()));
    if (request.name === 'find-affected-outputs')
      return Promise.resolve(env(impactPage([impactOutput()])));
    if (request.name === 'query-nodes') return hydration.promise;
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result, unmount } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(1));
  expect(result.current.currentCandidates[0]?.target).toEqual({
    nodeId: 'generated-home',
    title: null,
    path: null,
  });
  expect(result.current.currentPages[0]?.loading).toBe(false);
  unmount();
  await act(async () => hydration.resolve(env(nodePage())));
});

it('preserves earlier-page hydration while a later page loads', async () => {
  const firstHydration = deferred<Awaited<ReturnType<CallFn>>>();
  const call: CallFn = (request) => {
    if (request.name === 'inspect-provenance')
      return Promise.resolve(env(status()));
    if (request.name === 'find-affected-outputs')
      return Promise.resolve(
        env(
          request.arguments.cursor
            ? impactPage([impactOutput('second-revision', 'second-node')])
            : impactPage(
                [impactOutput('first-revision', 'first-node')],
                'next-page',
              ),
        ),
      );
    if (request.name === 'query-nodes') {
      const nodeIds = request.arguments.node_ids as string[];
      return nodeIds.includes('first-node')
        ? firstHydration.promise
        : Promise.resolve(env(nodePage('second-node')));
    }
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(1));
  expect(result.current.currentCandidates[0]?.target.title).toBeNull();

  act(() => result.current.loadMoreCurrent());
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(2));
  await act(async () => firstHydration.resolve(env(nodePage('first-node'))));

  await waitFor(() =>
    expect(result.current.currentCandidates[0]?.target.title).toBe('Home'),
  );
});

it('stops before impact when the tool or required inspection features are absent', async () => {
  const impact = vi.fn();
  const call: CallFn = async (request) => {
    if (request.name === 'find-affected-outputs') {
      impact();
      return env(impactPage([]));
    }
    return env(status(false));
  };
  const withoutTool = renderImpactHook(call, {
    ...defaults,
    hasImpactTool: false,
  });
  await waitFor(() =>
    expect(withoutTool.result.current.capability).toBe('unsupported'),
  );
  withoutTool.unmount();
  const withoutFeatures = renderImpactHook(call);
  await waitFor(() =>
    expect(withoutFeatures.result.current.capability).toBe('unsupported'),
  );
  expect(impact).not.toHaveBeenCalled();
});

it('starts historical reads only on action and keeps stream cursors separate', async () => {
  const calls: Array<{ currentness: unknown; cursor: unknown }> = [];
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return env(status());
    if (request.name === 'find-affected-outputs') {
      calls.push({
        currentness: request.arguments.currentness,
        cursor: request.arguments.cursor,
      });
      const historical = request.arguments.currentness === 'historical';
      return env(
        impactPage(
          [impactOutput(historical ? 'historical' : 'current')],
          request.arguments.cursor ? null : historical ? 'history-next' : 'current-next',
        ),
      );
    }
    if (request.name === 'query-nodes') return env(nodePage());
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(1));
  expect(calls).toEqual([{ currentness: 'current', cursor: undefined }]);
  act(() => result.current.loadHistorical());
  await waitFor(() =>
    expect(result.current.historicalCandidates).toHaveLength(1),
  );
  act(() => result.current.loadMoreCurrent());
  act(() => result.current.loadMoreHistorical());
  await waitFor(() => expect(calls).toHaveLength(4));
  expect(calls).toEqual([
    { currentness: 'current', cursor: undefined },
    { currentness: 'historical', cursor: undefined },
    { currentness: 'current', cursor: 'current-next' },
    { currentness: 'historical', cursor: 'history-next' },
  ]);
});

it('selects the clicked snapshot when a revision appears in both streams', async () => {
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return env(status());
    if (request.name === 'find-affected-outputs')
      return env(
        impactPage([
          impactOutput(
            'shared-revision',
            'generated-home',
            request.arguments.currentness === 'historical'
              ? 'missing'
              : 'changed',
          ),
        ]),
      );
    if (request.name === 'query-nodes') return env(nodePage());
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(1));
  act(() => result.current.loadHistorical());
  await waitFor(() =>
    expect(result.current.historicalCandidates).toHaveLength(1),
  );
  act(() =>
    result.current.selectCandidate(result.current.historicalCandidates[0]!),
  );
  expect(
    result.current.selectedCandidate?.impact.inputs[0]?.comparison,
  ).toBe('missing');
});

it('keeps same-node revisions distinct and preserves uncertainty values', async () => {
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance') return env(status());
    if (request.name === 'find-affected-outputs')
      return env(
        impactPage([
          impactOutput('revision-a', 'generated-home', 'comparison_unknown'),
          impactOutput('revision-b', 'generated-home', 'unavailable'),
        ]),
      );
    if (request.name === 'query-nodes') {
      expect(request.arguments.node_ids).toEqual(['generated-home']);
      return env(nodePage());
    }
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(2));
  expect(
    result.current.currentCandidates.map(
      (candidate) => candidate.impact.receipt.output_revision_id,
    ),
  ).toEqual(['revision-a', 'revision-b']);
  expect(
    result.current.currentCandidates.map(
      (candidate) => candidate.impact.inputs[0]?.comparison,
    ),
  ).toEqual(['comparison_unknown', 'unavailable']);
});

it('ignores late status and impact work after session replacement', async () => {
  const lateStatus = deferred<Awaited<ReturnType<CallFn>>>();
  const lateImpact = deferred<Awaited<ReturnType<CallFn>>>();
  let statusCalls = 0;
  let impactCalls = 0;
  const call: CallFn = (request) => {
    if (request.name === 'inspect-provenance')
      return statusCalls++ === 0
        ? lateStatus.promise
        : Promise.resolve(env(status()));
    if (request.name === 'find-affected-outputs')
      return impactCalls++ === 0
        ? lateImpact.promise
        : Promise.resolve(env(impactPage([impactOutput('fresh', 'other')])));
    if (request.name === 'query-nodes')
      return Promise.resolve(env(nodePage('other')));
    throw Error(`Unexpected tool ${request.name}`);
  };
  const first = renderImpactHook(call);
  first.rerender({ ...defaults, target: { ...sourceTarget, nodeId: 'other' } });
  await waitFor(() => expect(impactCalls).toBe(1));
  act(() => first.result.current.refresh());
  await waitFor(() => expect(impactCalls).toBe(2));
  await waitFor(() => expect(first.result.current.currentCandidates).toHaveLength(1));
  await act(async () => lateStatus.resolve(env(status())));
  await act(async () =>
    lateImpact.resolve(env(impactPage([impactOutput('stale')]))),
  );
  expect(
    first.result.current.currentCandidates.map(
      (candidate) => candidate.impact.receipt.output_revision_id,
    ),
  ).toEqual(['fresh']);
});

it('ignores late hydration after unmount', async () => {
  const hydration = deferred<Awaited<ReturnType<CallFn>>>();
  const call: CallFn = (request) => {
    if (request.name === 'inspect-provenance')
      return Promise.resolve(env(status()));
    if (request.name === 'find-affected-outputs')
      return Promise.resolve(env(impactPage([impactOutput()])));
    if (request.name === 'query-nodes') return hydration.promise;
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result, unmount } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentPages).toHaveLength(1));
  unmount();
  await act(async () => hydration.resolve(env(nodePage())));
});

it('clears selection and previous pages immediately on refresh', async () => {
  const second = deferred<Awaited<ReturnType<CallFn>>>();
  let impactCalls = 0;
  const call: CallFn = (request) => {
    if (request.name === 'inspect-provenance')
      return Promise.resolve(env(status()));
    if (request.name === 'find-affected-outputs')
      return impactCalls++ === 0
        ? Promise.resolve(env(impactPage([impactOutput()])))
        : second.promise;
    if (request.name === 'query-nodes')
      return Promise.resolve(env(nodePage()));
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() => expect(result.current.currentCandidates).toHaveLength(1));
  act(() =>
    result.current.selectCandidate(result.current.currentCandidates[0]!),
  );
  expect(result.current.selectedCandidate?.impact.receipt.output_revision_id).toBe(
    'impact-output',
  );
  act(() => result.current.refresh());
  expect(result.current.currentPages).toEqual([]);
  expect(result.current.selectedCandidate).toBeNull();
  await act(async () => second.resolve(env(impactPage([]))));
});

it('keeps the original vault namespace pinned across repeated refreshes', async () => {
  let vaultNamespace = 'fixture';
  const impactSources: unknown[] = [];
  const call: CallFn = async (request) => {
    if (request.name === 'inspect-provenance')
      return env({ ...status(), vault_namespace: vaultNamespace });
    if (request.name === 'find-affected-outputs') {
      impactSources.push(request.arguments.sources);
      return env(impactPage([]));
    }
    throw Error(`Unexpected tool ${request.name}`);
  };
  const { result } = renderImpactHook(call);
  await waitFor(() => expect(impactSources).toHaveLength(1));

  act(() => result.current.refresh());
  await waitFor(() => expect(impactSources).toHaveLength(2));
  expect(result.current.capability).toBe('ready');

  vaultNamespace = 'replacement';
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.capability).toBe('error'));
  expect(result.current.capabilityError).toMatch(/vault.*changed/i);
  expect(result.current.namespace).toBeNull();
  expect(result.current.currentPages).toEqual([]);
  expect(impactSources).toHaveLength(2);
  expect(impactSources).toEqual([
    [{ kind: 'node', namespace: 'fixture', native_id: 'source-input' }],
    [{ kind: 'node', namespace: 'fixture', native_id: 'source-input' }],
  ]);
});
