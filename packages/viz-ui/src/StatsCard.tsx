import React, { useCallback, useEffect, useState } from 'react';
import { useVizCall } from './viz-client-context.js';
import { readCardEnvelope } from './card-envelope.js';
import type { StatsCardSpec } from './board-card-spec.js';

export const WATCHER_STALE_MS = 24 * 60 * 60 * 1000;

interface StatsPayload {
  node_count?: number; type_counts?: Array<{ type: string; count: number }>; relationship_count?: number;
  orphan_count?: number; retained_transcripts?: number; db_bytes?: number;
  watcher?: { last_event_at: string | null; state: string };
}

function humanBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
const fmt = (n: number | undefined): string => (n ?? 0).toLocaleString('en-US');

/** Curated glanceable tile set — deliberately not a payload dump. Read-only; mount + ↻ fetch, no polling. */
export function StatsCard({ spec, actions }: { spec: StatsCardSpec; actions?: React.ReactNode }): React.ReactElement {
  const call = useVizCall();
  const [payload, setPayload] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const envl = readCardEnvelope(await call({ name: 'vault-stats', arguments: {} }));
      if (!envl.ok) { setError(envl.error?.message ?? 'vault-stats failed'); return; }
      setError(null);
      setPayload(envl.data as StatsPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [call]);
  useEffect(() => { void load(); }, [load, tick]);

  const watcherAge = payload?.watcher?.last_event_at ? Date.now() - Date.parse(payload.watcher.last_event_at) : Infinity;
  const watcherStale = watcherAge > WATCHER_STALE_MS;

  return (
    <div className="vz-statscard">
      <div className="vz-card-head">
        <span className="vz-card-title">{spec.title.trim() || 'Vault stats'}</span>
        {actions}
        <button type="button" aria-label="refresh" className="vz-card-refresh" onClick={() => setTick((n) => n + 1)}>↻</button>
      </div>
      {error && <div className="vz-card-error" role="alert">{error}</div>}
      {!error && payload && (
        <div className="vz-stat-grid">
          <div className="vz-stat"><b>{fmt(payload.node_count)}</b><span>nodes</span></div>
          <div className="vz-stat"><b>{fmt((payload.type_counts ?? []).length)}</b><span>types</span></div>
          <div className="vz-stat"><b>{fmt(payload.relationship_count)}</b><span>links</span></div>
          <div className="vz-stat"><b>{fmt(payload.orphan_count)}</b><span>orphans</span></div>
          <div className="vz-stat"><b>{fmt(payload.retained_transcripts)}</b><span>transcripts</span></div>
          <div className="vz-stat"><b>{humanBytes(payload.db_bytes ?? 0)}</b><span>db</span></div>
          <div className={`vz-stat${watcherStale ? ' vz-stat-warn' : ''}`}>
            <b>{payload.watcher?.state ?? '?'}</b>
            <span>watcher{payload.watcher?.last_event_at ? '' : ' · never'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
