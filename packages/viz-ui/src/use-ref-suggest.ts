/**
 * useRefSuggest — debounced reference-picker suggestion hook.
 *
 * Calls useVizClient() (context client) .queryNodes via suggestArgs/toCandidates (query-core).
 * - search("") → recent nodes (sort_by file_mtime desc)
 * - search(q)  → title_contains search
 * - Scoped to field.reference_target type when present.
 * - Out-of-order guarded: a stale earlier response never overwrites a newer one.
 * - Unmount-guarded: setState is never called after unmount.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import type { RefCandidate, SchemaField } from "@vault/query-core";
import { suggestArgs, toCandidates } from "@vault/query-core";
import { useVizClient } from "./viz-client-context.js";

const DEBOUNCE_MS = 200;

export interface RefSuggestResult {
  candidates: RefCandidate[];
  loading: boolean;
  search(query: string): void;
}

export function useRefSuggest(field: SchemaField): RefSuggestResult {
  const [candidates, setCandidates] = useState<RefCandidate[]>([]);
  const [loading, setLoading] = useState(false);

  // Monotonically increasing request sequence — last issued wins.
  const seqRef = useRef(0);
  // Unmount guard.
  const mountedRef = useRef(true);
  // Debounce timer.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable client reference — seeded from context and kept current.
  const client = useVizClient();
  const clientRef = useRef(client);
  useEffect(() => { clientRef.current = client; }, [client]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current != null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const search = useCallback(
    (query: string): void => {
      if (debounceRef.current != null) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        const seq = ++seqRef.current;
        setLoading(true);

        const args = suggestArgs(field, query);
        void clientRef.current.queryNodes(args).then((envelope) => {
          if (!mountedRef.current) return;
          if (seq !== seqRef.current) return; // stale — a newer query supersedes this one

          setLoading(false);
          if (envelope.ok) {
            setCandidates(toCandidates(envelope.data.nodes));
          } else {
            setCandidates([]);
          }
        }).catch(() => {
          if (!mountedRef.current) return;
          if (seq !== seqRef.current) return;
          setLoading(false);
          setCandidates([]);
        });
      }, DEBOUNCE_MS);
    },
    [field],
  );

  return { candidates, loading, search };
}
