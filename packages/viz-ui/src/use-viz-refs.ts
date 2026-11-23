import { useEffect, useState } from 'react';
import type { CallFn } from '@vault/query-core';
import { referenceFieldNames } from './viz-refs.js';
import { useVizCall } from './viz-client-context.js';

const cache = new Map<string, string[]>(); // schema type -> reference field names

async function fetchRefFields(type: string, call: CallFn): Promise<string[]> {
  const hit = cache.get(type);
  if (hit) return hit;
  try {
    const res = await call({ name: 'describe-schema', arguments: { name: type } });
    const text = (res as { content?: Array<{ type: string; text?: string }> }).content?.find((c) => c.type === 'text')?.text;
    const env = text ? (JSON.parse(text) as { ok?: boolean; data?: { fields?: Array<{ name: string; reference_target?: string | null }> } }) : { ok: false };
    const names = env.ok && env.data ? referenceFieldNames(env.data.fields) : [];
    cache.set(type, names);
    return names;
  } catch { return []; }
}

/** The union of reference field names across the viz's types. Empty until the schema(s) resolve. */
export function useVizRefFields(types: string[] | undefined): Set<string> {
  const [set, setSet] = useState<Set<string>>(() => new Set());
  const key = (types ?? []).join(',');
  const call = useVizCall();
  useEffect(() => {
    const list = types?.filter(Boolean) ?? [];
    if (list.length === 0) { setSet(new Set()); return; }
    let alive = true;
    void Promise.all(list.map((t) => fetchRefFields(t, call))).then((lists) => { if (alive) setSet(new Set(lists.flat())); });
    return () => { alive = false; };
  }, [key, call]); // eslint-disable-line react-hooks/exhaustive-deps
  return set;
}
