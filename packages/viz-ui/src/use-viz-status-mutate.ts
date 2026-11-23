import { useEffect, useRef, useState } from 'react';
import type { Client } from '@vault/query-core';
import { useVizClient } from './viz-client-context.js';
import type { VizRow } from './viz-spec.js';

export interface StatusMutateAPI {
  rows: VizRow[];
  setStatus(rowId: string, field: string, value: string): void;
  error: string | null;
}

export function useVizStatusMutate(inputRows: VizRow[], onRefresh?: () => void): StatusMutateAPI {
  // Defensive client read: throws if no provider (D7 graceful degradation).
  // The try wraps only the context read — hooks rule is satisfied because the
  // context.useContext call is unconditional; the try/catch just handles the
  // no-provider throw.
  let client: Client | null;
  try {
    client = useVizClient();
  } catch {
    client = null;
  }

  const [rows, setRows] = useState<VizRow[]>(inputRows);
  const [error, setError] = useState<string | null>(null);

  // Resync when the upstream rows change identity (a refetch).
  const seenRef = useRef(inputRows);
  useEffect(() => {
    if (seenRef.current !== inputRows) {
      seenRef.current = inputRows;
      setRows(inputRows);
    }
  }, [inputRows]);

  const setStatus = (rowId: string, field: string, value: string): void => {
    if (!client) return;

    // Capture snapshot of current rows for the closure — we need the pre-optimistic state.
    // Read the row from the latest rows state via a functional setter trick, but since
    // we need the row synchronously for the optimistic update, we read from the current
    // rows state (captured in the closure). This works because setStatus is re-created
    // each render, so rows here is the latest render's rows.
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;

    const prev = row.fields[field];
    if (prev === value) return;

    setError(null);
    // Optimistic update — synchronous, immediate.
    setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, fields: { ...r.fields, [field]: value } } : r)));

    void (async () => {
      try {
        let version = row.version;
        if (version === undefined) {
          const g = await client!.getNode({ node_id: rowId });
          // get-node returns the node FLAT in data (not data.node).
          version = g.ok ? (g.data as { version?: number })?.version : undefined;
        }
        const env = await client!.updateNode({
          node_id: rowId,
          set_fields: { [field]: value },
          expected_version: version,
        });
        if (!env.ok) throw new Error(env.error?.message ?? 'update failed');
        onRefresh?.();
      } catch (e) {
        // Revert the optimistic update on failure.
        setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, fields: { ...r.fields, [field]: prev } } : r)));
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  return { rows, setStatus, error };
}
