import { createContext, createElement, useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import { makeClient, type CallFn, type Client } from '@vault/query-core';
import { DEFAULT_VIEW_VOCABULARY, type ViewVocabulary } from './view-vocabulary.js';
import { statusScaleFor, type StatusScale } from './viz-state.js';

interface VizClientValue {
  call: CallFn | null;
  client: Client;
  vocabulary: ViewVocabulary;
  timeZone: string | null;
}

const VizClientContext = createContext<VizClientValue | null>(null);

/**
 * Injects the engine transport for every viz component below it.
 * Hosts pass `call` (a CallFn); tests may pass a ready `client` override.
 * `vocabulary` is the vault map's names the views read (the task kind, its status field and
 * values, the date fields); without it the views use today's names. `timeZone` is the configured
 * zone (Curator's `tz`) the calendar takes days in; without it, the viewer's.
 */
export function VizClientProvider({ call, client, vocabulary, timeZone, children }: { call?: CallFn; client?: Client; vocabulary?: ViewVocabulary; timeZone?: string | null; children: ReactNode }): ReactElement {
  const transport = useMemo<Omit<VizClientValue, 'vocabulary' | 'timeZone'>>(() => {
    if (client) return { call: call ?? null, client };
    if (!call) throw new Error('VizClientProvider requires `call` or `client`');
    return { call, client: makeClient(call) };
  }, [call, client]);
  // A new vocabulary (a read of the vault map landing) keeps the client: views mid-edit keep their state.
  const value = useMemo<VizClientValue>(
    () => ({ ...transport, vocabulary: vocabulary ?? DEFAULT_VIEW_VOCABULARY, timeZone: timeZone ?? null }),
    [transport, vocabulary, timeZone],
  );
  return createElement(VizClientContext.Provider, { value }, children);
}

function useCtx(): VizClientValue {
  const v = useContext(VizClientContext);
  if (!v) throw new Error('viz components must be rendered inside <VizClientProvider>');
  return v;
}

/** The raw CallFn — used by the two hooks that parse a raw CallToolResult. */
export function useVizCall(): CallFn {
  const { call } = useCtx();
  if (!call) throw new Error('useVizCall: provider was given a `client` but no `call`');
  return call;
}

/** The typed Client wrapping the host transport. */
export function useVizClient(): Client {
  return useCtx().client;
}

/** The vault map's names for views; today's names outside a provider or when the host passed none. */
export function useVizVocabulary(): ViewVocabulary {
  return useContext(VizClientContext)?.vocabulary ?? DEFAULT_VIEW_VOCABULARY;
}

/** The configured time zone (Curator's `tz`) the host passed; null outside a provider or when it
 *  passed none, and then views take the viewer's zone. */
export function useVizTimeZone(): string | null {
  return useContext(VizClientContext)?.timeZone ?? null;
}

/** The status order and colours for the vault's status values (statusScaleFor), memoized per vocabulary. */
export function useStatusScale(): StatusScale {
  const vocabulary = useVizVocabulary();
  return useMemo(() => statusScaleFor(vocabulary), [vocabulary]);
}
