import React, { useCallback, useEffect, useState } from 'react';
import { useVizClient } from './viz-client-context.js';
import type { NodeCardSpec } from './board-card-spec.js';
import type { PreviewRef } from './preview-ref.js';

export const BODY_SNIPPET_LINES = 6;

interface NodePayload {
  id: string; title: string; types?: string[];
  fields?: Record<string, { value: unknown }>;
  body?: string;
}

/** Field value → display text; objects are skipped (return null). Arrays of scalars join with ' · '. */
function fieldText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) return value.join(' · ');
  return null;
}

/** Light markdown strip for the snippet: heading markers, emphasis, wikilink brackets. */
function stripMd(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1');
}

/** Compact pinned-note card: header/chips/fields/snippet, expandable body. Read-only; mount fetch. */
export function NodeCard({ spec, onOpenPreview, onSpecChange, actions }: {
  /** Host buttons placed in the card head before refresh (e.g. the board composer's sparkles). */
  actions?: React.ReactNode;
  spec: NodeCardSpec;
  onOpenPreview?: (ref: PreviewRef) => void;
  onSpecChange?: (next: NodeCardSpec) => void;
}): React.ReactElement {
  const client = useVizClient();
  const [node, setNode] = useState<NodePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(spec.expanded === true);

  const load = useCallback(async () => {
    try {
      const envl = await client.getNode({ node_id: spec.node_id, include_embeds: false });
      if (!envl.ok) { setError(`"${spec.title}" could not be loaded — ${envl.error.message}`); return; }
      if (!envl.data) { setError(`"${spec.title}" could not be loaded — not found`); return; }
      setError(null);
      setNode(envl.data as unknown as NodePayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, spec.node_id, spec.title]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setExpanded(spec.expanded === true);
  }, [spec.expanded]);
  const bodyLines = (node?.body ?? '').split('\n').map(stripMd).filter((l) => l.trim() !== '');
  const snippet = bodyLines.slice(0, BODY_SNIPPET_LINES);
  const hasMore = bodyLines.length > BODY_SNIPPET_LINES;

  const fields = Object.entries(node?.fields ?? {})
    .map(([name, f]) => [name, fieldText(f.value)] as const)
    .filter((e): e is readonly [string, string] => e[1] !== null);

  return (
    <div className="vz-nodecard">
      <div className="vz-card-head">
        <span className="vz-nodecard-pin" aria-hidden="true">📌</span>
        {onOpenPreview ? (
          <button type="button" className="vz-card-title vz-nodecard-title" onClick={() => onOpenPreview({ nodeId: spec.node_id })}>
            {node?.title ?? spec.title}
          </button>
        ) : (
          <span className="vz-card-title vz-nodecard-title">{node?.title ?? spec.title}</span>
        )}
        {actions}
        <button type="button" aria-label="refresh" className="vz-card-refresh" onClick={() => void load()}>↻</button>
      </div>
      {error && <div className="vz-card-error" role="alert">{error}</div>}
      {!error && node && (
        <>
          {(node.types ?? []).length > 0 && (
            <div className="vz-nodecard-chips">{(node.types ?? []).map((t) => <span key={t} className="vz-nodecard-chip">{t}</span>)}</div>
          )}
          {fields.length > 0 && (
            <div className="vz-nodecard-fields">
              {fields.map(([name, text]) => <div key={name} className="vz-nodecard-field"><span>{name}</span> {text}</div>)}
            </div>
          )}
          {bodyLines.length > 0 && (
            <div className={`vz-nodecard-body${expanded ? ' expanded' : ''}`}>
              {(expanded ? bodyLines : snippet).map((l, i) => <p key={i}>{l}</p>)}
              {(hasMore || expanded) && (
                <button type="button" className="vz-nodecard-expand" onClick={() => { setExpanded(!expanded); onSpecChange?.({ ...spec, expanded: !expanded }); }}>
                  {expanded ? '▴ collapse' : '▾ expand'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
