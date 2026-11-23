import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { VizClientProvider } from '@vault/viz-ui';
import type { CallFn } from '@vault/query-core';
import { DEFAULT_VAULT_MAP, type VaultMapIndex } from '../engine/vault-map.js';

const noSubscription = (): (() => void) => () => {};
const defaults = () => DEFAULT_VAULT_MAP;

/**
 * VizClientProvider with Engine's vault map: the views below read the task kind, status field and
 * values, and date fields from it, and the calendar its time zone. The map is read when this mounts (if stale), and the views
 * re-render when a read changes it. Without an index, the map's defaults (today's names).
 */
export function VaultVizProvider({ call, vaultMap, children }: { call: CallFn; vaultMap?: VaultMapIndex; children: ReactNode }) {
  const map = useSyncExternalStore(vaultMap?.subscribe ?? noSubscription, vaultMap?.current ?? defaults);
  useEffect(() => { vaultMap?.refresh(); }, [vaultMap]);
  return <VizClientProvider call={call} vocabulary={map.vault} timeZone={map.timeZone}>{children}</VizClientProvider>;
}
