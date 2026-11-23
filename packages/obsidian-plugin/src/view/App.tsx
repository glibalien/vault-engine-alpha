import { useState } from 'react';
import { VizCard, type VizSpec } from '@vault/viz-ui';
import type { PreviewRef } from '@vault/viz-ui';
import type { CallFn } from '@vault/query-core';
import type { VaultMapIndex } from '../engine/vault-map.js';
import { VaultVizProvider } from './vault-viz-provider.js';

const DEFAULT_SPEC: VizSpec = {
  kind: 'table',
  title: 'Recent nodes',
  query: { sort_by: 'file_mtime', sort_order: 'desc', limit: 25 },
  display_fields: [],
};

export function App({ call, onOpenPreview, vaultMap }: { call: CallFn; onOpenPreview?: (ref: PreviewRef) => void; vaultMap?: VaultMapIndex }) {
  const [spec, setSpec] = useState<VizSpec>(DEFAULT_SPEC);
  return (
    <VaultVizProvider call={call} vaultMap={vaultMap}>
      <div className="ve-root">
        <VizCard spec={spec} onOpenPreview={onOpenPreview} onSpecChange={setSpec} />
      </div>
    </VaultVizProvider>
  );
}
