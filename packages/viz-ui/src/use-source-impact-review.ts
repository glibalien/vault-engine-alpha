import { useLayoutEffect, useMemo, useReducer } from 'react';
import type {
  Issue,
  ProvenanceImpactData,
  ProvenanceImpactOutput,
} from '@vault/query-core';
import { useVizClient } from './viz-client-context.js';
import {
  emptyRead,
  type InspectorTarget,
  type ReadState,
} from './provenance-inspector.js';

export type ImpactReviewPage = {
  impact: ProvenanceImpactData;
  targets: Record<string, InspectorTarget>;
  hydrationError: string | null;
};

export type ImpactCandidate = {
  impact: ProvenanceImpactOutput;
  target: InspectorTarget;
  checkedAt: string;
};

export type SourceImpactReviewOptions = {
  target: InspectorTarget | null;
  connectionKey: number;
  hasInspectionTool: boolean;
  hasImpactTool: boolean;
};

export type SourceImpactReviewState = {
  capability: 'loading' | 'ready' | 'unsupported' | 'error';
  capabilityError: string | null;
  namespace: string | null;
  currentPages: ReadState<ImpactReviewPage>[];
  historicalPages: ReadState<ImpactReviewPage>[];
  currentCandidates: ImpactCandidate[];
  historicalCandidates: ImpactCandidate[];
  selectedCandidate: ImpactCandidate | null;
};

type Stream = 'current' | 'historical';
type MutableState = Omit<
  SourceImpactReviewState,
  'currentCandidates' | 'historicalCandidates'
>;

const FEATURES = ['output_input_comparisons_v1', 'input_text_v1'] as const;
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Impact review read failed';

const initial = (): MutableState => ({
  capability: 'loading',
  capabilityError: null,
  namespace: null,
  currentPages: [],
  historicalPages: [],
  selectedCandidate: null,
});

const success = <T>(data: T, warnings: Issue[]): ReadState<T> => ({
  data,
  loading: false,
  error: null,
  stale: false,
  readAt: new Date().toISOString(),
  warnings,
});

function fallbackTarget(output: ProvenanceImpactOutput): InspectorTarget {
  return {
    nodeId: output.receipt.output_node_id,
    title: null,
    path: null,
  };
}

function candidates(pages: ReadState<ImpactReviewPage>[]): ImpactCandidate[] {
  return pages.flatMap((page) => {
    const data = page.data;
    if (!data) return [];
    return data.impact.outputs.map((impact) => ({
      impact,
      target:
        data.targets[impact.receipt.output_node_id] ?? fallbackTarget(impact),
      checkedAt: page.readAt ?? data.impact.as_of,
    }));
  });
}

export function useSourceImpactReview({
  target,
  connectionKey,
  hasInspectionTool,
  hasImpactTool,
}: SourceImpactReviewOptions) {
  const client = useVizClient();
  const [, render] = useReducer((value) => value + 1, 0);
  const session = useMemo(
    () => ({
      state: initial(),
      boundNamespace: null as string | null,
      alive: false,
      epoch: 0,
      pageEpoch: {
        current: [] as number[],
        historical: [] as number[],
      },
      cursors: {
        current: [] as Array<string | undefined>,
        historical: [] as Array<string | undefined>,
      },
    }),
    [client, target, connectionKey, hasInspectionTool, hasImpactTool],
  );
  const notify = () => {
    if (session.alive) render();
  };
  const valid = (
    epoch: number,
    stream?: Stream,
    index?: number,
    pageEpoch?: number,
  ) =>
    session.alive &&
    session.epoch === epoch &&
    (stream === undefined ||
      session.pageEpoch[stream][index!] === pageEpoch);
  const pagesFor = (stream: Stream) =>
    stream === 'current'
      ? session.state.currentPages
      : session.state.historicalPages;
  const setPages = (stream: Stream, pages: ReadState<ImpactReviewPage>[]) => {
    if (stream === 'current') session.state.currentPages = pages;
    else session.state.historicalPages = pages;
  };

  async function loadPage(
    stream: Stream,
    cursor: string | undefined,
    index: number,
  ): Promise<void> {
    if (!target || !session.state.namespace) return;
    const epoch = session.epoch;
    const pageEpoch = (session.pageEpoch[stream][index] ?? 0) + 1;
    session.pageEpoch[stream][index] = pageEpoch;
    const pages = [...pagesFor(stream)];
    pages[index] = { ...emptyRead(), loading: true };
    setPages(stream, pages);
    session.cursors[stream][index] = cursor;
    notify();

    try {
      const envelope = await client.findAffectedOutputs({
        sources: [
          {
            kind: 'node',
            namespace: session.state.namespace,
            native_id: target.nodeId,
          },
        ],
        currentness: stream,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      if (!valid(epoch, stream, index, pageEpoch)) return;
      if (!envelope.ok) throw Error(envelope.error.message);

      const outputIds = [
        ...new Set(
          envelope.data.outputs.map((output) => output.receipt.output_node_id),
        ),
      ];
      const targets: Record<string, InspectorTarget> = {};
      for (const output of envelope.data.outputs) {
        targets[output.receipt.output_node_id] = fallbackTarget(output);
      }
      if (!valid(epoch, stream, index, pageEpoch)) return;
      const completed = [...pagesFor(stream)];
      const published = success(
        { impact: envelope.data, targets, hydrationError: null },
        envelope.warnings ?? [],
      );
      completed[index] = published;
      setPages(stream, completed);
      notify();

      if (outputIds.length > 0) {
        let hydrationError: string | null = null;
        const hydratedTargets = { ...targets };
        try {
          const hydrated = await client.queryNodes({
            node_ids: outputIds,
            limit: outputIds.length,
          });
          if (!valid(epoch, stream, index, pageEpoch)) return;
          if (!hydrated.ok) throw Error(hydrated.error.message);
          for (const node of hydrated.data.nodes) {
            if (!outputIds.includes(node.id)) continue;
            hydratedTargets[node.id] = {
              nodeId: node.id,
              title: node.title,
              path: node.file_path,
            };
          }
        } catch (error) {
          if (!valid(epoch, stream, index, pageEpoch)) return;
          hydrationError = message(error);
        }
        if (!valid(epoch, stream, index, pageEpoch)) return;
        const hydratedPages = [...pagesFor(stream)];
        hydratedPages[index] = {
          ...published,
          data: {
            impact: envelope.data,
            targets: hydratedTargets,
            hydrationError,
          },
        };
        setPages(stream, hydratedPages);
      }
    } catch (error) {
      if (!valid(epoch, stream, index, pageEpoch)) return;
      const failed = [...pagesFor(stream)];
      failed[index] = { ...emptyRead(), error: message(error) };
      setPages(stream, failed);
    }
    notify();
  }

  async function discover(): Promise<void> {
    if (!target) return;
    if (!hasInspectionTool || !hasImpactTool) {
      session.state.capability = 'unsupported';
      notify();
      return;
    }
    const epoch = session.epoch;
    try {
      const envelope = await client.inspectProvenance({ select: 'status' });
      if (!valid(epoch)) return;
      if (!envelope.ok) throw Error(envelope.error.message);
      const data = envelope.data;
      if (data.select !== 'status') throw Error('Invalid inspection status');
      const features = data.inspection_features ?? [];
      if (!FEATURES.every((feature) => features.includes(feature))) {
        session.state.capability = 'unsupported';
        notify();
        return;
      }
      if (
        session.boundNamespace &&
        session.boundNamespace !== data.vault_namespace
      ) {
        throw Error(
          'Engine vault changed. Review the current source again before reading impact.',
        );
      }
      session.boundNamespace ??= data.vault_namespace;
      session.state.capability = 'ready';
      session.state.capabilityError = null;
      session.state.namespace = session.boundNamespace;
      notify();
      await loadPage('current', undefined, 0);
    } catch (error) {
      if (!valid(epoch)) return;
      session.state.capability = 'error';
      session.state.capabilityError = message(error);
      notify();
    }
  }

  useLayoutEffect(() => {
    session.alive = true;
    void discover();
    return () => {
      session.alive = false;
      session.epoch++;
      session.state = initial();
      session.boundNamespace = null;
      session.pageEpoch.current = [];
      session.pageEpoch.historical = [];
      session.cursors.current = [];
      session.cursors.historical = [];
    };
  }, [session]);

  const loadMore = (stream: Stream) => {
    const pages = pagesFor(stream);
    if (pages.some((page) => page.loading)) return;
    const cursor = pages.at(-1)?.data?.impact.next_cursor;
    if (cursor) void loadPage(stream, cursor, pages.length);
  };
  const retry = (stream: Stream, index: number) => {
    if (pagesFor(stream)[index]?.loading) return;
    void loadPage(stream, session.cursors[stream][index], index);
  };
  const currentCandidates = candidates(session.state.currentPages);
  const historicalCandidates = candidates(session.state.historicalPages);

  return {
    ...session.state,
    currentCandidates,
    historicalCandidates,
    loadMoreCurrent: () => loadMore('current'),
    loadHistorical: () => {
      if (session.state.historicalPages.length === 0)
        void loadPage('historical', undefined, 0);
    },
    loadMoreHistorical: () => loadMore('historical'),
    retryCurrentPage: (index: number) => retry('current', index),
    retryHistoricalPage: (index: number) => retry('historical', index),
    selectCandidate: (candidate: ImpactCandidate) => {
      session.state.selectedCandidate = candidate;
      notify();
    },
    clearSelection: () => {
      session.state.selectedCandidate = null;
      notify();
    },
    refresh: () => {
      session.epoch++;
      session.state = initial();
      session.pageEpoch.current = [];
      session.pageEpoch.historical = [];
      session.cursors.current = [];
      session.cursors.historical = [];
      notify();
      void discover();
    },
  };
}
