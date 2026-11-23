/**
 * use-viz-schema.ts
 *
 * React hooks for fetching and caching schema + type data from the engine.
 *
 * Module-level caches so data survives component unmounts/remounts.
 * In-flight maps dedupe concurrent fetches for the same key.
 */
import { useState, useEffect } from "react";
import type { Schema } from "@vault/query-core";
import { useVizClient } from "./viz-client-context.js";

// ---------- module-level cache ----------

const schemaCache = new Map<string, Schema>();
const schemaInFlight = new Map<string, Promise<Schema | null>>();

let typesCache: string[] | null = null;
let typesInFlight: Promise<string[]> | null = null;
let typeCountsCache: Record<string, number> | null = null;

/** Clear all caches. Exposed for testing only — do not call in production. */
export function _resetCachesForTest(): void {
  schemaCache.clear();
  schemaInFlight.clear();
  typesCache = null;
  typesInFlight = null;
  typeCountsCache = null;
}

// ---------- hooks ----------

/**
 * Fetch and cache a schema for the given type name.
 * Returns null while loading, null for a null type, and null on !ok envelope.
 * Never throws — degrades gracefully.
 */
export function useVizSchema(type: string | null): Schema | null {
  const [schema, setSchema] = useState<Schema | null>(() =>
    type !== null ? (schemaCache.get(type) ?? null) : null
  );
  const client = useVizClient();

  useEffect(() => {
    if (type === null) return;

    // Already cached — sync it into local state (handles remounts)
    const cached = schemaCache.get(type);
    if (cached !== undefined) {
      setSchema(cached);
      return;
    }

    // Dedupe concurrent in-flight requests
    let inFlight = schemaInFlight.get(type);
    if (!inFlight) {
      inFlight = client
        .describeSchema(type)
        .then((env) => {
          if (env.ok && Array.isArray(env.data.fields)) {
            schemaCache.set(type, env.data);
            return env.data;
          }
          return null;
        })
        .catch(() => null)
        .finally(() => {
          schemaInFlight.delete(type);
        });
      schemaInFlight.set(type, inFlight);
    }

    let cancelled = false;
    inFlight.then((result) => {
      if (!cancelled) setSchema(result);
    });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  return schema;
}

/**
 * Fetch and cache all vault schemas, returning a Map<string, Schema> keyed by type name.
 * Drives off useVizTypes(); reuses module-level schemaCache for hits.
 * Returns an empty Map while loading or on failure. Never throws.
 */
export function useVizSchemas(): Map<string, Schema> {
  const types = useVizTypes();
  const [schemas, setSchemas] = useState<Map<string, Schema>>(() => new Map());
  const client = useVizClient();

  useEffect(() => {
    if (types.length === 0) return;

    // Seed synchronous hits first
    const syncMap = new Map<string, Schema>();
    for (const type of types) {
      const cached = schemaCache.get(type);
      if (cached !== undefined) syncMap.set(type, cached);
    }

    // Fetch the misses
    const misses = types.filter((t) => !schemaCache.has(t));

    if (misses.length === 0) {
      setSchemas(syncMap);
      return;
    }

    let cancelled = false;

    const fetchMiss = (type: string): Promise<Schema | null> => {
      let inFlight = schemaInFlight.get(type);
      if (!inFlight) {
        inFlight = client
          .describeSchema(type)
          .then((env) => {
            if (env.ok && Array.isArray(env.data.fields)) {
              schemaCache.set(type, env.data);
              return env.data;
            }
            return null;
          })
          .catch(() => null)
          .finally(() => {
            schemaInFlight.delete(type);
          });
        schemaInFlight.set(type, inFlight);
      }
      return inFlight;
    };

    Promise.all(misses.map(fetchMiss)).then(() => {
      if (cancelled) return;
      const result = new Map<string, Schema>();
      for (const type of types) {
        const cached = schemaCache.get(type);
        if (cached !== undefined) result.set(type, cached);
      }
      setSchemas(result);
    });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join(",")]);

  return schemas;
}

/**
 * Fetch and cache the list of all type names in the vault.
 * Returns [] while loading or on !ok envelope. Never throws.
 */
export function useVizTypes(): string[] {
  const [types, setTypes] = useState<string[]>(() => typesCache ?? []);
  const client = useVizClient();

  useEffect(() => {
    if (typesCache !== null) {
      setTypes(typesCache);
      return;
    }

    if (!typesInFlight) {
      typesInFlight = client
        .listTypes()
        .then((env) => {
          if (env.ok) {
            const names = env.data.map((t) => t.type);
            typesCache = names;
            typeCountsCache = Object.fromEntries(env.data.map((t) => [t.type, t.count]));
            return names;
          }
          return [];
        })
        .catch(() => [])
        .finally(() => {
          typesInFlight = null;
        });
    }

    let cancelled = false;
    typesInFlight.then((result) => {
      if (!cancelled) setTypes(result);
    });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return types;
}

/**
 * Fetch and cache per-type counts from the engine.
 * Returns {} while loading or on !ok envelope. Never throws.
 * Reuses the in-flight listTypes() promise started by useVizTypes (whose .then
 * also writes typeCountsCache), so mounting both hooks together — as VizCard does —
 * issues a single listTypes() round-trip rather than two concurrent ones.
 */
export function useVizTypeCounts(): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>(() => typeCountsCache ?? {});
  const client = useVizClient();

  useEffect(() => {
    if (typeCountsCache) { setCounts(typeCountsCache); return; }
    let cancelled = false;
    // Reuse the in-flight listTypes() promise started by useVizTypes (whose .then
    // also populates typeCountsCache) so a cold-cache mount of both hooks issues a
    // SINGLE request. Only start our own flight if none is pending.
    const flight =
      typesInFlight ??
      client
        .listTypes()
        .then((env) => {
          if (env.ok) {
            typeCountsCache = Object.fromEntries(env.data.map((t) => [t.type, t.count]));
            return env.data.map((t) => t.type);
          }
          return [];
        })
        .catch(() => []);
    flight.then(() => {
      if (!cancelled && typeCountsCache) setCounts(typeCountsCache);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return counts;
}
