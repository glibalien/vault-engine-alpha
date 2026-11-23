import { useState } from 'react';
import { VizCard, type VizSpec, type PreviewRef } from '@vault/viz-ui';

/**
 * Inline chat viz card: holds ephemeral collapsed + spec state around the shared VizCard.
 * When onPin is provided, a pin affordance appears; clicking it calls onPin with the card's
 * current spec (which may have been edited by the user since the card was rendered).
 * The parts loop keys this by toolCallId, so a new AI viz remounts and re-seeds from its prop.
 */
export function PluginVizCard({ spec: initialSpec, collapsed: initialCollapsed, onOpenPreview, onPin }: {
  spec: VizSpec;
  collapsed?: boolean;
  onOpenPreview?: (ref: PreviewRef) => void;
  onPin?: (spec: VizSpec) => void;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed ?? false);
  const [spec, setSpec] = useState(initialSpec);
  return (
    <VizCard
      spec={spec}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      onOpenPreview={onOpenPreview}
      onSpecChange={setSpec}
      onPin={onPin ? () => onPin(spec) : undefined}
    />
  );
}
