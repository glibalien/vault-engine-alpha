import { useEffect, useState } from 'react';
import type { VizRow, VizSpec } from './viz-spec.js';
import { rowsFromCallResult, vizQueryArgs } from './viz-spec.js';
import { useVizCall, useVizVocabulary } from './viz-client-context.js';

interface VizData {
  rows: VizRow[];
  total: number;
  /** The rows came back in search relevance order (see rowsFromCallResult). */
  ranked: boolean;
  loading: boolean;
  error: string | null;
}

/** Resolve a spec live through the host's MCP bridge; refresh every 30s. */
export function useVizData(spec: VizSpec, paused = false): VizData & { refresh: () => void } {
  const [state, setState] = useState<VizData>({ rows: [], total: 0, ranked: false, loading: true, error: null });
  const [tick, setTick] = useState(0);
  // The query identity, not the object identity, drives refetches.
  const specKey = JSON.stringify(vizQueryArgs(spec, useVizVocabulary()));
  const call = useVizCall();

  useEffect(() => {
    if (paused) return; // collapsed: defer the initial fetch until the card is expanded
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    void call({ name: 'query-nodes', arguments: JSON.parse(specKey) as Record<string, unknown> })
      .then((result) => {
        if (!alive) return;
        const parsed = rowsFromCallResult(result);
        if ('error' in parsed) setState((s) => ({ ...s, loading: false, error: parsed.error }));
        else setState({ rows: parsed.rows, total: parsed.total, ranked: parsed.ranked === true, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (alive) setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
      });
    return () => { alive = false; };
  }, [specKey, tick, paused, call]);

  useEffect(() => {
    if (paused) return; // don't poll hidden (collapsed) cards
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [paused]);

  return { ...state, refresh: () => setTick((n) => n + 1) };
}
