import { Fragment } from 'react';
import { fieldText } from './viz-state.js';
import type { PreviewRef } from './preview-ref.js';

/** A field value rendered as preview link(s) when it's a reference field, else plain text. */
export function RefValue({ raw, isRef, onOpenPreview, className = 'mono' }: {
  raw: unknown;
  isRef: boolean;
  onOpenPreview?: (ref: PreviewRef) => void;
  className?: string;
}) {
  const text = fieldText(raw);
  if (!isRef || !onOpenPreview || !text) return <span className={className}>{text}</span>;
  const vals = Array.isArray(raw) ? raw.map((v) => String(v).trim()).filter(Boolean) : [text];
  // A comma between links: without it, several links in one cell read as one name
  // (each button is inline-flex and nowrap, with no gap between them). The space
  // after the comma is where a narrow cell wraps.
  return <>{vals.map((v, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="viz-ref-sep">, </span>}
      <button className="viz-ref" onClick={() => onOpenPreview({ title: v })}>{v}</button>
    </Fragment>
  ))}</>;
}
