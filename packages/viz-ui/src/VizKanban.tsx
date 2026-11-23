import type { VizRow } from './viz-spec.js';
import { fieldText, groupRows, statusColorVar } from './viz-state.js';
import type { PreviewRef } from './preview-ref.js';
import { RefValue } from './RefValue.js';
import { clampColumnWidth, startColumnResize } from './column-resize.js';
import { useStatusScale } from './viz-client-context.js';

/** Clamp a kanban column width (px) to the resizable range. */
export const clampColWidth = clampColumnWidth;

const GROUPED_ON_LIST_HINT = 'Grouped by a field that can hold several values. Edit them in the note.';

export function VizKanban({ rows, groupBy, displayFields, onOpenPreview, refFields, onSetStatus, columnWidths, onColumnWidthChange }: {
  rows: VizRow[];
  groupBy: string;
  displayFields: string[];
  onOpenPreview?: (ref: PreviewRef) => void;
  refFields?: Set<string>;
  onSetStatus?: (rowId: string, field: string, value: string) => void;
  /** Per-column pixel widths keyed by group value; absent columns use the CSS default. */
  columnWidths?: Record<string, number>;
  /** Persist a resized column width. When omitted, columns are not resizable. */
  onColumnWidthChange?: (value: string, width: number) => void;
}) {
  const scale = useStatusScale();
  const metaFields = displayFields.filter((f) => f !== groupBy).slice(0, 2);
  // A column of a list field is its values joined into one label, and a drop writes one
  // value, which would replace the card's whole list (#285). Such a board stays read-only.
  const groupsOnList = rows.some((r) => Array.isArray(r.fields[groupBy]));
  const setStatus = groupsOnList ? undefined : onSetStatus;

  // Drag the right-edge handle to resize a column. The live width is written
  // directly to the DOM during the drag (no React churn); the final width is
  // committed via onColumnWidthChange, which round-trips back through the spec.
  function startResize(e: React.PointerEvent<HTMLElement>, value: string) {
    if (!onColumnWidthChange) return;
    const col = (e.currentTarget as HTMLElement).closest('.kcol') as HTMLElement | null;
    if (!col) return;
    startColumnResize(
      e,
      col,
      (width) => { col.style.width = `${width}px`; },
      (width) => onColumnWidthChange(value, width),
    );
  }

  return (
    <div className="viz-body">
      <div className="vkanban">
        {groupRows(rows, groupBy, scale).map((g) => {
          const width = columnWidths?.[g.value];
          return (
            <div
              className="kcol"
              key={g.value}
              style={width ? { width: `${width}px` } : undefined}
              onDragOver={setStatus ? (e) => e.preventDefault() : undefined}
              onDrop={setStatus ? (e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                if (id) setStatus(id, groupBy, g.value);
              } : undefined}
            >
              <div className="kcol-head">
                <span className="d" style={{ background: `var(${statusColorVar(g.value, scale)})` }} />
                <span className="kt">{g.label}</span>
                <span className="kc">{g.rows.length}</span>
              </div>
              <div className="kcards">
                {g.rows.map((r) => (
                  <div
                    className="kcard"
                    key={r.id}
                    draggable={setStatus ? true : undefined}
                    onDragStart={setStatus ? (e) => e.dataTransfer.setData('text/plain', r.id) : undefined}
                    title={groupsOnList && onSetStatus ? GROUPED_ON_LIST_HINT : undefined}
                  >
                    <div className="kc-title">{onOpenPreview ? <button className="viz-ref" onClick={() => onOpenPreview({ nodeId: r.id })}>{r.title}</button> : r.title}</div>
                    <div className="kc-meta">
                      {metaFields.map((f) => {
                        const raw = r.fields[f];
                        if (refFields?.has(f) && fieldText(raw)) return <span className="kc-tag" key={f}><RefValue raw={raw} isRef onOpenPreview={onOpenPreview} className="" /></span>;
                        const text = fieldText(raw);
                        return text ? <span className="kc-tag" key={f}>{text}</span> : null;
                      })}
                    </div>
                  </div>
                ))}
              </div>
              {onColumnWidthChange && (
                <div
                  className="kcol-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`resize ${g.label} column`}
                  onPointerDown={(e) => startResize(e, g.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
