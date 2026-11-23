import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './icon.js';
import type { TableSort, VizRow } from './viz-spec.js';
import { isServerColumn } from './viz-spec.js';
import { fieldText, filterRows, groupRows, sortRows, statusColorVar, isStatus, MISSING_BUCKET } from './viz-state.js';
import type { RowGroup, SortState } from './viz-state.js';
import type { PreviewRef } from './preview-ref.js';
import { RefValue } from './RefValue.js';
import type { VizCellEditAPI } from './use-viz-cell-edit.js';
import type { VizBulkAPI } from './use-viz-bulk.js';
import type { Schema } from "@vault/query-core";
import { isReferenceListField, widgetForField } from "@vault/query-core";
import { TITLE_FIELD, LINK_COUNT_COLUMN, LINK_COUNT_HINT, LINK_COUNT_KINDS, LINK_COUNT_LABEL } from "@vault/query-core";
import { cellEditorFor, ReferenceListCellEditor } from './cell-editors/index.js';
import { PromotePill, CellErrorMsg, StaleReloadBar } from './CellConfirm.js';
import { DRAFT_ROW_ID, draftRowFor, useDraftEditAdapter } from './use-draft-edit-adapter.js';
import type { VizDraftAPI } from './use-viz-draft.js';
import type { VizExpandAPI } from './use-viz-expand.js';
import { nodeRowToVizRow, childDisplayFields, childRefFields } from './use-viz-expand.js';
import { useDismissOnOutside } from './use-dismiss-on-outside.js';
import { clampColumnWidth, startColumnResize } from './column-resize.js';
import { useStatusScale } from './viz-client-context.js';

const HEADER_ICON: Record<string, IconName> = {
  text: 'b-text', textarea: 'b-text', enum: 'b-enum', number: 'b-hash', date: 'b-calendar',
  bool: 'b-checkbox', link: 'b-link', tags: 'b-tag',
};

/** A list-of-references cell's links, as stored, for the list editor. */
function linkValues(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return items.filter((v) => v != null && String(v).trim() !== '').map(String);
}

/** True when a row's API can edit a list-of-references field one member at a time
 *  (#285). Real rows can; the draft row can't, because its node doesn't exist yet. */
function editsMembers(schema: Schema | null | undefined, field: string, rowEdit: VizCellEditAPI): boolean {
  const f = schema?.fields.find((s) => s.name === field);
  return !!f && isReferenceListField(f) && !!rowEdit.editReferenceMember;
}

/** True for a list-of-references cell holding more than one link, on a row with no
 *  member editor. The one-value editor would replace the whole list and silently
 *  drop the other links (#285), so such a cell stays read-only. */
function holdsSeveralLinks(schema: Schema | null | undefined, field: string, raw: unknown, rowEdit: VizCellEditAPI): boolean {
  const f = schema?.fields.find((s) => s.name === field);
  if (!f || !isReferenceListField(f) || rowEdit.editReferenceMember) return false;
  return linkValues(raw).length > 1;
}

const SEVERAL_LINKS_HINT = 'Holds several links. Edit them in the note.';

const BULK_COLUMN_WIDTH = 28;
const ROW_NUMBER_COLUMN_WIDTH = 48;
const VERSION_COLUMN_WIDTH = 72;
const LINK_COUNT_COLUMN_WIDTH = 96;

/** Table and List sections (#573): the rows grouped by one field, some sections folded shut. */
export interface RowSections {
  field: string;
  /** Set when the field is a date: the time zone its values are read in, one section per day. */
  byDay?: string;
  /** Folded sections, by group value (`''` for the "—" section). */
  folded: ReadonlySet<string>;
  onToggle: (value: string) => void;
}

/** A section's heading: fold toggle, value, row count. A click anywhere on it folds or opens it. */
export function SectionHead({ group, folded, onToggle }: { group: RowGroup; folded: boolean; onToggle: () => void }) {
  const scale = useStatusScale();
  const name = group.missing ? MISSING_BUCKET : group.label;
  return (
    <div className={`vsection-head${folded ? ' folded' : ''}`} onClick={onToggle}>
      <button
        type="button"
        className="vsection-toggle"
        aria-expanded={!folded}
        aria-label={`${name} section`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        <Icon name="b-chevron-down" />
      </button>
      <span className="vsection-label">
        {!group.missing && isStatus(group.label, scale) ? <StatusPill value={group.label} /> : name}
      </span>
      <span className="vsection-count">{group.rows.length}</span>
    </div>
  );
}

export function StatusPill({ value }: { value: string }) {
  const cv = statusColorVar(value, useStatusScale());
  return (
    <span className="spill" style={{ color: `var(${cv})`, background: `color-mix(in srgb, var(${cv}) 15%, transparent)` }}>
      <span className="d" />{value}
    </span>
  );
}

// ─── Keyboard nav helper ──────────────────────────────────────────────────────
// Returns a stable [rowIndex, colIndex] given a data-cell-key attribute value.
// colIndex 0 = title column; colIndex 1..n = displayFields[colIndex-1]
function parseCellKey(key: string | null): [number, number] | null {
  if (!key) return null;
  const parts = key.split(':');
  if (parts.length !== 2) return null;
  return [parseInt(parts[0]!, 10), parseInt(parts[1]!, 10)];
}

/** Stand-ins so useDraftEditAdapter can be called unconditionally (Rules of Hooks)
 *  when the table is read-only or no draft hook was passed. Never user-visible:
 *  `editFor()` below returns undefined when there is no real edit API, which keeps
 *  the read-only render path byte-identical. */
const NO_EDIT: VizCellEditAPI = {
  cellValue: (row, field) => row.fields[field],
  cellTitle: (row) => row.title,
  editing: null, pending: null, cellError: null,
  isStale: () => false, isFlashing: () => false, isEditing: false, busy: false,
  beginEdit: () => {}, submitEdit: async () => {}, confirmPending: async () => {},
  cancelEdit: () => {}, reloadRow: async () => {},
};

const NO_DRAFT: VizDraftAPI = {
  draft: null, isDrafting: false, createdCount: 0,
  start: () => {}, editCell: () => {}, setField: () => {}, setTitle: () => {},
  commit: async () => {}, commitWithTitle: async () => {}, commitWithField: async () => {},
  confirmCreate: async () => {},
  cancel: () => {}, exitEdit: () => {},
};

export function VizTable({ rows, displayFields, groupField, onOpenPreview, refFields, density, showRowNumbers, showVersion, showLinkCounts, columnWidths, onColumnWidthChange, edit, editable, schema, bulk, draft, lockedType, seedFields, expand, allSchemas, variant: variantProp, justAddedIds, showRowFilter = true, sort: sortProp, onSort, sections }: {
  rows: VizRow[];
  /** Group the rows into sections by a field (#573). Absent: one run of rows. */
  sections?: RowSections;
  displayFields: string[];
  groupField: string;
  onOpenPreview?: (ref: PreviewRef) => void;
  refFields?: Set<string>;
  density?: 'compact' | 'cozy' | 'comfy';
  showRowNumbers?: boolean;
  showVersion?: boolean;
  /** Trailing Links in / Links out / Unresolved links columns, read from each row's link_counts. */
  showLinkCounts?: boolean;
  /** Per-column pixel widths keyed by field name; `title` controls the title column. */
  columnWidths?: Record<string, number>;
  /** Persist a resized field width. When omitted, table columns are not resizable. */
  onColumnWidthChange?: (field: string, width: number) => void;
  edit?: VizCellEditAPI;
  editable?: boolean;
  schema?: Schema | null;
  /** Shared bulk-hook instance. When editable, adds a leading checkbox column. */
  bulk?: VizBulkAPI;
  /** Render the client-side "filter rows…" box above the table. VizCard turns it off: its
   *  toolbar search covers the same need. Defaults to true for standalone use. */
  showRowFilter?: boolean;
  /** Shared draft-hook instance. When editable + lockedType + schema, renders the draft row. */
  draft?: VizDraftAPI;
  /** The locked type name (e.g. "task"). Required for the draft row to render. */
  lockedType?: string;
  /** Seed field values from active filter chips — passed to draft.start(). */
  seedFields?: Record<string, unknown>;
  /** Sub-table expansion API. When provided + hasCaret, adds leading caret column. */
  expand?: VizExpandAPI;
  /** Map of all schemas — used to look up child schema for sub-table rendering. */
  allSchemas?: Map<string, Schema>;
  /** 'main' (default) or 'sub'. Sub hides filter bar + caret column. */
  variant?: 'main' | 'sub';
  /** Rows whose id is in this set render with the viz-just-added cue class. */
  justAddedIds?: ReadonlySet<string>;
  /** The view's sort (VizCard: `tableSortOf(spec)`); null = the order the query returned. Only
   *  read with `onSort`. The table sorts rows itself only for a client sort; a server sort
   *  arrives already in order. */
  sort?: TableSort | null;
  /** Header click, with the clicked column's sort key (`title` for Name). When given, the table's
   *  sort is controlled: the host saves the view's sort and passes it back as `sort`. Without it
   *  (sub-tables, standalone use) the table keeps its own header sort, title ascending to start. */
  onSort?: (key: string) => void;
}) {
  const variant = variantProp ?? 'main';

  // Presents the open draft (if any) through the SAME VizCellEditAPI as real rows,
  // so the row loop below never needs to know which kind of row it is drawing.
  const draftEdit = useDraftEditAdapter(edit ?? NO_EDIT, draft ?? NO_DRAFT);

  // PER-ROW projection. `VizCellEditAPI` carries ONE editing/pending/cellError for
  // the whole table, so the draft's state and the real rows' can only coexist if
  // each row is answered by the API that owns it. Wrapping the table in the adapter
  // instead made an open draft cell mask `edit.editing` — no real row could open an
  // editor (and a draft error hid a real row's) until the draft closed.
  // `undefined` keeps the read-only render path untouched when there is no edit API.
  const editFor = (rowId: string): VizCellEditAPI | undefined =>
    edit ? (rowId === DRAFT_ROW_ID ? draftEdit : edit) : undefined;

  // Keyboard nav is ONLY active in the parent (main) table — child cells must NOT
  // carry data-cell-key or the parent's querySelector would collide.
  const navEnabled = !!editable && variant === 'main';
  const [ownSort, setOwnSort] = useState<SortState>({ key: 'title', dir: 1 });
  const scale = useStatusScale();
  const [q, setQ] = useState('');
  const controlled = onSort !== undefined;
  const sortState = (s: TableSort): SortState => ({ key: s.key, dir: s.order === 'asc' ? 1 : -1 });
  // Rows are sorted here only by a client sort. A server sort (or a search's relevance order)
  // is already the order the query returned.
  const rowSort: SortState | null = controlled ? (sortProp?.client ? sortState(sortProp) : null) : ownSort;
  // The header arrow: a client sort's column, or the column of an Engine sort (Name, a link count).
  // The other server sorts (modified, indexed) have no column, so no arrow.
  const arrow: SortState | null = controlled
    ? (sortProp && (sortProp.client || isServerColumn(sortProp.key)) ? sortState(sortProp) : null)
    : ownSort;
  const clickHeader = (sortKey: string): void => {
    if (onSort) onSort(sortKey);
    else setOwnSort((s) => ({ key: sortKey, dir: s.key === sortKey ? (-s.dir as 1 | -1) : 1 }));
  };

  const rowSortKey = rowSort?.key;
  const rowSortDir = rowSort?.dir;
  const visible = useMemo(() => {
    const filtered = filterRows(rows, q, groupField, null);
    return rowSortKey === undefined ? filtered : sortRows(filtered, { key: rowSortKey, dir: rowSortDir ?? 1 }, scale);
  }, [rows, q, rowSortKey, rowSortDir, groupField, scale]);

  // The draft, when open, always renders as the LAST row — regardless of sort or
  // the local row filter, and independent of whether it would match either.
  // Requires `edit` too: without it, `editFor()` returns undefined and the draft's cells
  // would fall through to the read-only render path — which, for the title cell,
  // means a "view note" button wired to a node id (DRAFT_ROW_ID) that does not exist.
  const draftOpen = !!(editable && edit && draft && lockedType && schema);
  const draftRow = draftOpen ? draftRowFor(draft!.draft, lockedType!) : null;

  // Sections (#573): the sorted rows bucketed by the group field, so the sort holds within each.
  // A folded section keeps its heading but draws no rows, and select-all and Tab skip them.
  const sectionField = variant === 'main' ? sections?.field : undefined;
  const sectionDay = sections?.byDay;
  const groups = useMemo(
    () => (sectionField === undefined ? null : groupRows(visible, sectionField, scale, sectionDay)),
    [visible, sectionField, sectionDay, scale],
  );
  const isFolded = (g: RowGroup): boolean => !!sections?.folded.has(g.value);
  const shown = groups ? groups.flatMap((g) => (isFolded(g) ? [] : g.rows)) : visible;
  // Row numbers count every grouped row, folded or not, so folding a section renumbers nothing.
  const rowNumber = useMemo(
    () => (groups ? new Map(groups.flatMap((g) => g.rows).map((r, k) => [r.id, k + 1])) : null),
    [groups],
  );
  const bodyRows = draftRow ? [...shown, draftRow] : shown;

  // ─── One editor at a time ────────────────────────────────────────────────
  // The draft row and a real row must never both hold an open editor: both grab
  // Enter, and a create landing mid-edit unmounts one of them under the user's
  // fingers (the pre-React flows/create.ts cleared cell-edit state in startDraft
  // for exactly this reason). Opening either side closes the other. Both helpers
  // are no-ops when there is nothing to close, so the common path costs no render.
  // Only an open EDITOR is closed. A promote pill has no autofocus and no Enter
  // handler, so it never competes for the keystroke this rule protects — and it is
  // one click from Confirm, so cancelling it would silently drop the user's edit.
  // (A cellError keeps its editor open, so `editing` already covers that case.)
  const closeRealEdit = useCallback(() => {
    if (edit?.editing) edit.cancelEdit();
  }, [edit]);

  // exitEdit only closes the draft's cell editor — the draft itself, and every
  // value staged into it, survives clicking away to a real row.
  const closeDraftEdit = useCallback(() => {
    if (draft?.draft && draft.draft.editing !== null) draft.exitEdit();
  }, [draft]);

  /** Open a cell editor, whichever row it belongs to. The single entry point:
   *  click on a title cell, click on a field cell, and Tab navigation all use it. */
  const openCell = useCallback((rowId: string, field: string) => {
    if (!edit) return;
    if (rowId === DRAFT_ROW_ID) {
      closeRealEdit();
      draftEdit.beginEdit(rowId, field);
    } else {
      closeDraftEdit();
      edit.beginEdit(rowId, field);
    }
  }, [edit, draftEdit, closeRealEdit, closeDraftEdit]);

  /** Open a fresh draft row (collapsed "+ New" click, and the streak below). */
  const startDraft = useCallback(() => {
    closeRealEdit();
    draft?.start(seedFields);
  }, [closeRealEdit, draft, seedFields]);

  // Rescue strip: a create was rejected over a field with no column of its own,
  // so the error (and the only way to fix it) would otherwise render nowhere.
  // Absent whenever the error names the title or a field that already has a
  // column — those already surface the error in their normal cell.
  const blockedField = (() => {
    const err = draftOpen ? draft!.draft?.error : null;
    if (!err || err.field === TITLE_FIELD || displayFields.includes(err.field)) return null;
    return { err, field: schema?.fields.find((f) => f.name === err.field) ?? null };
  })();

  // Streak: every successful create opens a fresh seeded row below, so several
  // rows can be added without reaching for the mouse. createdCount changes only
  // on a real create — promote and inline-error leave the draft open.
  // startDraft (not draft.start) so the reopened row's title editor is the only one
  // on screen: a create can land while the user has already clicked into a real row,
  // and two live editors means the next keystroke lands in whichever one focus won.
  const seenCreated = useRef(draft?.createdCount ?? 0);
  useEffect(() => {
    if (!draftOpen || !draft) return;
    if (draft.createdCount === seenCreated.current) return;
    seenCreated.current = draft.createdCount;
    startDraft();
  }, [draft?.createdCount, draftOpen, seedFields]);

  const columnRefs = useRef(new Map<string, HTMLTableColElement>());
  // Bases-style property-type glyph before each header label.
  const headIcon = (columnKey: string): IconName => {
    if (columnKey === TITLE_FIELD) return 'b-file';
    const field = schema?.fields.find((f) => f.name === columnKey);
    if (!field) return refFields?.has(columnKey) ? 'b-link' : 'b-text';
    return HEADER_ICON[widgetForField(field)] ?? 'b-text';
  };
  const head = (columnKey: string, sortKey: string, label: string) => (
    <th key={columnKey} onClick={() => clickHeader(sortKey)}>
      <span className="vth">
        <Icon name={headIcon(columnKey)} className="vth-icon" />
        <span className="vth-label">{label}</span>
        {arrow?.key === sortKey && <span className="sortar" aria-label={arrow.dir > 0 ? 'sorted ascending' : 'sorted descending'}><Icon name={arrow.dir > 0 ? 'b-arrow-up' : 'b-arrow-down'} /></span>}
      </span>
      {onColumnWidthChange && (
        <span
          className="vtable-col-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={`resize ${label} column`}
          aria-valuemin={90}
          aria-valuemax={520}
          aria-valuenow={clampColumnWidth(columnWidths?.[columnKey] ?? 140)}
          tabIndex={0}
          onPointerDown={(event) => {
            const header = event.currentTarget.closest('th');
            const column = columnRefs.current.get(columnKey);
            if (!header || !column) return;
            startColumnResize(
              event,
              header,
              (width) => { column.style.width = `${width}px`; },
              (width) => onColumnWidthChange(columnKey, width),
            );
          }}
          onKeyDown={(event) => {
            const column = columnRefs.current.get(columnKey);
            if (!column) return;
            const current = clampColumnWidth(column.offsetWidth || columnWidths?.[columnKey] || 140);
            const step = event.shiftKey ? 40 : 10;
            const next = event.key === 'ArrowLeft' ? current - step
              : event.key === 'ArrowRight' ? current + step
                : event.key === 'Home' ? 90
                  : event.key === 'End' ? 520
                    : null;
            if (next === null) return;
            event.preventDefault();
            event.stopPropagation();
            const width = clampColumnWidth(next);
            column.style.width = `${width}px`;
            onColumnWidthChange(columnKey, width);
          }}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </th>
  );

  const densityClass = `viz-density-${density ?? 'cozy'}`;

  // ─── Expand-menu outside-click dismissal ─────────────────────────────────
  // menuRef is attached to the caret-col <td> of the row whose menu is open.
  const menuRef = useRef<HTMLTableCellElement>(null);
  useDismissOnOutside(
    menuRef,
    variant === 'main' && expand?.expandMenuFor != null,
    () => expand?.closeMenu(),
  );

  // ─── Keyboard nav: Tab/Shift+Tab between editable cells ──────────────────
  const tableRef = useRef<HTMLTableElement>(null);

  const handleCellKeyDown = useCallback((
    e: React.KeyboardEvent<HTMLTableCellElement>,
    rowIndex: number,
    colIndex: number,
  ) => {
    if (!navEnabled || !edit) return;
    if (e.key !== 'Tab') return;

    e.preventDefault();
    const totalCols = displayFields.length + 1; // +1 for title
    let nextRow = rowIndex;
    let nextCol = colIndex + (e.shiftKey ? -1 : 1);

    if (nextCol >= totalCols) {
      nextCol = 0;
      nextRow++;
    } else if (nextCol < 0) {
      nextCol = totalCols - 1;
      nextRow--;
    }

    if (nextRow < 0 || nextRow >= bodyRows.length) return;

    // Find and focus the next cell
    const nextKey = `${nextRow}:${nextCol}`;
    const nextCell = tableRef.current?.querySelector(`[data-cell-key="${nextKey}"]`) as HTMLElement | null;
    if (nextCell) {
      nextCell.focus();
      // Begin edit on the next cell
      const row = bodyRows[nextRow];
      if (row) {
        const field = nextCol === 0 ? TITLE_FIELD : displayFields[nextCol - 1]!;
        const rowEdit = row.id === DRAFT_ROW_ID ? draftEdit : edit;
        if (!holdsSeveralLinks(schema, field, rowEdit.cellValue(row, field), rowEdit)) openCell(row.id, field);
      }
    }
  }, [navEnabled, edit, draftEdit, schema, openCell, displayFields, bodyRows]);

  // ─── Render a single editable-or-read-only field cell ────────────────────
  const renderFieldCell = (row: VizRow, field: string, rowIndex: number, colIndex: number) => {
    // The row picks its own API (draft vs real); everything below is one path.
    const cellEdit = editFor(row.id);
    if (!editable || !cellEdit) {
      // Read-only path: byte-identical to before
      const raw = row.fields[field];
      const text = fieldText(raw);
      if (refFields?.has(field)) return <RefValue raw={raw} isRef onOpenPreview={onOpenPreview} />;
      return isStatus(text, scale) ? <StatusPill value={text} /> : <span className="mono">{text}</span>;
    }

    const isEditingThisCell = cellEdit.editing?.id === row.id && cellEdit.editing?.field === field;
    const isPendingThisCell = cellEdit.pending?.id === row.id && cellEdit.pending?.field === field;
    const isErrorThisCell = cellEdit.cellError?.id === row.id && cellEdit.cellError?.field === field;
    const flashing = cellEdit.isFlashing(row.id, field);

    // Effective value: overlay overrides row
    const raw = cellEdit.cellValue(row, field);
    const text = fieldText(raw);

    const schemaField = schema?.fields.find((f) => f.name === field);
    const locked = holdsSeveralLinks(schema, field, raw, cellEdit);

    // Cell content
    let content: React.ReactNode;
    if (isEditingThisCell && schemaField && editsMembers(schema, field, cellEdit)) {
      content = (
        <>
          <ReferenceListCellEditor
            values={linkValues(raw)}
            field={schemaField}
            busy={cellEdit.busy}
            onAdd={(candidate) => void cellEdit.editReferenceMember!(row, field, { action: 'add', nodeId: candidate.id })}
            onRemove={(storedValue) => void cellEdit.editReferenceMember!(row, field, { action: 'remove', storedValue })}
            onClose={() => cellEdit.cancelEdit()}
          />
          {isErrorThisCell && cellEdit.cellError && <CellErrorMsg error={cellEdit.cellError} />}
        </>
      );
    } else if (isEditingThisCell && schemaField && !locked) {
      const widget = widgetForField(schemaField);
      const Editor = cellEditorFor(widget);
      content = (
        <>
          <Editor
            initial={raw}
            field={schemaField}
            onSubmit={(rawVal, meta) => void cellEdit.submitEdit(row, field, rawVal, meta)}
            onStage={cellEdit.stageEdit && ((rawVal) => cellEdit.stageEdit!(row, field, rawVal))}
            onCancel={() => cellEdit.cancelEdit()}
          />
          {isErrorThisCell && cellEdit.cellError && <CellErrorMsg error={cellEdit.cellError} />}
        </>
      );
    } else if (isPendingThisCell && cellEdit.pending) {
      content = (
        <PromotePill
          pending={cellEdit.pending}
          onConfirm={() => void cellEdit.confirmPending()}
          onCancel={() => cellEdit.cancelEdit()}
        />
      );
    } else {
      if (refFields?.has(field)) {
        content = <RefValue raw={raw} isRef onOpenPreview={onOpenPreview} />;
      } else {
        // Use a non-breaking space when the value is empty so the span (and its
        // .cell-inner parent) has non-zero layout height in a real browser — an
        // empty <span> collapses to zero, making the click target invisible.
        content = isStatus(text, scale) ? <StatusPill value={text} /> : <span className="mono">{text || ' '}</span>;
      }
    }

    const handleClick = () => {
      if (!locked && !isEditingThisCell && !isPendingThisCell) {
        openCell(row.id, field);
      }
    };

    return (
      <div
        className={`cell-inner${flashing ? ' cell-flash' : ''}`}
        onClick={handleClick}
        style={{ cursor: locked ? 'default' : 'pointer' }}
        title={locked ? SEVERAL_LINKS_HINT : undefined}
      >
        {content}
      </div>
    );
  };

  // ─── Render the title cell ─────────────────────────────────────────────────
  const renderTitleCell = (row: VizRow, rowIndex: number) => {
    // The row picks its own API (draft vs real); everything below is one path.
    const cellEdit = editFor(row.id);
    if (!editable || !cellEdit) {
      // Read-only path: byte-identical to before
      return onOpenPreview
        ? <button className="viz-ref" onClick={() => onOpenPreview({ nodeId: row.id })}>{row.title}</button>
        : row.title;
    }

    const effectiveTitle = cellEdit.cellTitle(row);
    const isEditingTitle = cellEdit.editing?.id === row.id && cellEdit.editing?.field === TITLE_FIELD;
    const isPendingTitle = cellEdit.pending?.id === row.id && cellEdit.pending?.field === TITLE_FIELD;
    const isErrorTitle = cellEdit.cellError?.id === row.id && cellEdit.cellError?.field === TITLE_FIELD;
    const flashing = cellEdit.isFlashing(row.id, TITLE_FIELD);

    // Synthetic title field for the editor
    const titleSchemaField = {
      name: TITLE_FIELD,
      type: 'string' as const,
      required: true,
      default_value: null,
      ui: null,
      label: 'Title',
    };

    let content: React.ReactNode;
    if (isEditingTitle) {
      const Editor = cellEditorFor('text');
      content = (
        <>
          <Editor
            initial={effectiveTitle}
            field={titleSchemaField}
            onSubmit={(raw) => void cellEdit.submitEdit(row, TITLE_FIELD, raw)}
            onStage={cellEdit.stageEdit && ((raw) => cellEdit.stageEdit!(row, TITLE_FIELD, raw))}
            onCancel={() => cellEdit.cancelEdit()}
          />
          {isErrorTitle && cellEdit.cellError && <CellErrorMsg error={cellEdit.cellError} />}
        </>
      );
    } else if (isPendingTitle && cellEdit.pending) {
      content = (
        <PromotePill
          pending={cellEdit.pending}
          onConfirm={() => void cellEdit.confirmPending()}
          onCancel={() => cellEdit.cancelEdit()}
        />
      );
    } else {
      // Editable, not currently editing: plain title text. Plain click → edit
      // (handleClick); ⌘/Ctrl-click or middle-click → open the note (when wired).
      content = effectiveTitle;
    }

    // A draft row has no node to open — ⌘/Ctrl-click must fall through to edit.
    const openNote = onOpenPreview && row.id !== DRAFT_ROW_ID ? () => onOpenPreview({ nodeId: row.id }) : null;
    const handleClick = (e: React.MouseEvent) => {
      if (isEditingTitle || isPendingTitle) return;
      if (openNote && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openNote();
        return;
      }
      openCell(row.id, TITLE_FIELD);
    };

    return (
      <div
        className={`cell-inner${flashing ? ' cell-flash' : ''}`}
        onClick={handleClick}
        onAuxClick={openNote ? (e) => { if (e.button === 1) { e.preventDefault(); openNote(); } } : undefined}
        style={{ cursor: 'pointer' }}
        title={openNote ? 'Click to rename · ⌘/Ctrl-click (or middle-click) to open' : undefined}
      >
        {content}
      </div>
    );
  };

  // Caret column is visible only in the main variant when the expand API has pairs
  const showCaret = variant === 'main' && !!(expand?.hasCaret);

  // Leading / trailing non-field columns. The draft row mirrors these so its cells
  // stay under the right headers; totalCols is the sub-table-row colSpan.
  const leadingCols = (showCaret ? 1 : 0) + (editable && bulk ? 1 : 0) + (showRowNumbers ? 1 : 0);
  const trailingCols = (showLinkCounts ? LINK_COUNT_KINDS.length : 0) + (showVersion ? 1 : 0);
  const totalCols = leadingCols + 1 /* title */ + displayFields.length + trailingCols;
  const resizableKeys = [TITLE_FIELD, ...displayFields];
  const auxiliaryWidth = (editable && bulk ? BULK_COLUMN_WIDTH : 0)
    + (showRowNumbers ? ROW_NUMBER_COLUMN_WIDTH : 0)
    + (showLinkCounts ? LINK_COUNT_KINDS.length * LINK_COUNT_COLUMN_WIDTH : 0)
    + (showVersion ? VERSION_COLUMN_WIDTH : 0);
  const tableWidth = resizableKeys.every((key) => columnWidths?.[key] !== undefined)
    ? auxiliaryWidth + resizableKeys.reduce((total, key) => total + (columnWidths?.[key] ?? 0), 0)
    : undefined;

  // ─── One table row (and its open sub-table), at index i of bodyRows ──────
  const renderRow = (r: VizRow, i: number) => {
    const isDraft = r.id === DRAFT_ROW_ID;
    const rowEdit = editFor(r.id);
    // Sub-table expansion: look up the open group for this row
    const group = (!isDraft && variant === 'main' && expand?.isOpen(r.id))
      ? expand.expanded.get(r.id)
      : undefined;
    const childSchema = group ? (allSchemas?.get(group.childType) ?? null) : null;

    return (
      <Fragment key={r.id}>
        <tr className={!isDraft && justAddedIds?.has(r.id) ? 'viz-just-added' : isDraft ? 'draft-row' : undefined}>
          {/* Caret column (main variant only) */}
          {showCaret && expand && !isDraft && (
            <td
              className="caret-col"
              ref={(variant === 'main' && expand.expandMenuFor === r.id) ? menuRef : undefined}
            >
              <button
                className={'row-caret' + (expand.isOpen(r.id) ? ' open' : '')}
                aria-label={expand.isOpen(r.id) ? 'collapse' : 'expand'}
                onClick={() => expand.caretClick(r.id)}
              >▸</button>
              {expand.expandMenuFor === r.id && expand.pairs.length > 1 && (
                <div className="cell-popover expand-menu">
                  {expand.pairs.map((p) => (
                    <div
                      key={`${p.childType}:${p.viaField}`}
                      className="opt"
                      onClick={() => void expand.toggle(r.id, p)}
                    >
                      {p.childType}
                    </div>
                  ))}
                </div>
              )}
            </td>
          )}
          {showCaret && isDraft && <td className="caret-col" />}
          {editable && bulk && (
            <td className="c-bulk-check">
              {!isDraft && (
                <input
                  type="checkbox"
                  aria-label={`select row ${r.title}`}
                  checked={bulk.isSelected(r.id)}
                  onChange={() => bulk.toggleRow(r.id)}
                />
              )}
            </td>
          )}
          {showRowNumbers && <td className="c-rownum">{isDraft ? visible.length + 1 : rowNumber?.get(r.id) ?? i + 1}</td>}
          {/* Title cell */}
          <td
            className="c-title"
            data-cell-key={navEnabled ? `${i}:0` : undefined}
            tabIndex={navEnabled ? 0 : undefined}
            onKeyDown={navEnabled ? (e) => handleCellKeyDown(e, i, 0) : undefined}
          >
            {renderTitleCell(r, i)}
            {/* StaleReloadBar for this row (title column hosts it) */}
            {editable && rowEdit?.isStale(r.id) && (
              <StaleReloadBar onReload={() => void rowEdit.reloadRow(r)} />
            )}
          </td>
          {/* Field cells */}
          {displayFields.map((f, fi) => (
            <td
              key={f}
              data-field={f}
              data-cell-key={navEnabled ? `${i}:${fi + 1}` : undefined}
              tabIndex={navEnabled ? 0 : undefined}
              onKeyDown={navEnabled ? (e) => handleCellKeyDown(e, i, fi + 1) : undefined}
            >
              {renderFieldCell(r, f, i, fi + 1)}
            </td>
          ))}
          {showLinkCounts && LINK_COUNT_KINDS.map((kind) => (
            <td key={kind} className="c-link-count" data-link-count={kind}>{r.link_counts?.[kind] ?? ''}</td>
          ))}
          {showVersion && <td className="c-version">{r.version ?? ''}</td>}
        </tr>
        {/* Sub-table expansion row (main variant only, when open) */}
        {group && (
          <tr className="sub-table-row">
            <td colSpan={totalCols}>
              <div className="sub-wrap">
                {group.busy || !childSchema ? (
                  <div className="sub-loading">
                    {group.busy ? 'Loading…' : `No schema for ${group.childType}`}
                  </div>
                ) : group.rows.length === 0 ? (
                  <div className="sub-empty">No linked rows.</div>
                ) : (
                  <>
                    {group.unresolvedWarning && (
                      <div className="sub-hint">Some links unresolved.</div>
                    )}
                    <VizTable
                      variant="sub"
                      rows={group.rows.map(nodeRowToVizRow)}
                      displayFields={childDisplayFields(childSchema)}
                      groupField="status"
                      schema={childSchema}
                      edit={edit}
                      editable={editable}
                      refFields={childRefFields(childSchema)}
                      onOpenPreview={onOpenPreview}
                    />
                    {group.total > group.rows.length && (
                      <div className="sub-more">showing {group.rows.length} of {group.total}</div>
                    )}
                  </>
                )}
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="vtable-root">
      {variant !== 'sub' && showRowFilter && (
        <div className="vfilter">
          <div className="fsearch">
            <Icon name="search" />
            <input placeholder="filter rows…" aria-label="Filter rows" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
      )}
      <div className={`viz-body ${densityClass}`}>
        <table className={`vtable${variant === 'sub' ? ' sub-tbl' : ''}`} ref={tableRef} style={tableWidth ? { width: `${tableWidth}px`, tableLayout: 'fixed' } : undefined}>
          <colgroup>
            {showCaret && <col className="caret-col" />}
            {editable && bulk && <col className="c-bulk-check" style={{ width: `${BULK_COLUMN_WIDTH}px` }} />}
            {showRowNumbers && <col className="c-rownum" style={{ width: `${ROW_NUMBER_COLUMN_WIDTH}px` }} />}
            <col ref={(column) => { if (column) columnRefs.current.set(TITLE_FIELD, column); else columnRefs.current.delete(TITLE_FIELD); }} style={columnWidths?.[TITLE_FIELD] ? { width: `${columnWidths[TITLE_FIELD]}px` } : undefined} />
            {displayFields.map((field) => (
              <col key={field} ref={(column) => { if (column) columnRefs.current.set(field, column); else columnRefs.current.delete(field); }} style={columnWidths?.[field] ? { width: `${columnWidths[field]}px` } : undefined} />
            ))}
            {showLinkCounts && LINK_COUNT_KINDS.map((kind) => (
              <col key={kind} className="c-link-count" style={{ width: `${LINK_COUNT_COLUMN_WIDTH}px` }} />
            ))}
            {showVersion && <col className="c-version" style={{ width: `${VERSION_COLUMN_WIDTH}px` }} />}
          </colgroup>
          <thead>
            <tr>
              {showCaret && <th className="caret-col" />}
              {editable && bulk && (
                <th className="c-bulk-check">
                  <input
                    type="checkbox"
                    aria-label="select all"
                    checked={bulk.allSelected(shown)}
                    onChange={() => bulk.toggleAll(shown)}
                  />
                </th>
              )}
              {showRowNumbers && <th className="c-rownum">#</th>}
              {head(TITLE_FIELD, 'title', 'Name')}
              {displayFields.map((f) => head(f, f, f))}
              {showLinkCounts && LINK_COUNT_KINDS.map((kind) => {
                const sortKey = LINK_COUNT_COLUMN[kind];
                return (
                  <th key={sortKey} className="c-link-count" title={LINK_COUNT_HINT[kind]} onClick={() => clickHeader(sortKey)}>
                    <span className="vth">
                      <Icon name="b-hash" className="vth-icon" />
                      <span className="vth-label">{LINK_COUNT_LABEL[kind]}</span>
                      {arrow?.key === sortKey && <span className="sortar" aria-label={arrow.dir > 0 ? 'sorted ascending' : 'sorted descending'}><Icon name={arrow.dir > 0 ? 'b-arrow-up' : 'b-arrow-down'} /></span>}
                    </span>
                  </th>
                );
              })}
              {showVersion && <th className="c-version">version</th>}
            </tr>
          </thead>
          <tbody>
            {(() => {
              if (!groups) return bodyRows.map((r, i) => renderRow(r, i));
              // Each section's first row index in bodyRows: Tab and the cell keys run over the
              // rows on screen, in order, skipping folded sections.
              let next = 0;
              return (
                <>
                  {groups.map((g) => {
                    const folded = isFolded(g);
                    const start = next;
                    if (!folded) next += g.rows.length;
                    return (
                      <Fragment key={`section:${g.value}`}>
                        <tr className="vsection-row">
                          <td colSpan={totalCols}>
                            <SectionHead group={g} folded={folded} onToggle={() => sections!.onToggle(g.value)} />
                          </td>
                        </tr>
                        {!folded && g.rows.map((r, k) => renderRow(r, start + k))}
                      </Fragment>
                    );
                  })}
                  {draftRow && renderRow(draftRow, bodyRows.length - 1)}
                </>
              );
            })()}
            {blockedField && (
              <tr className="draft-blocked-row">
                {/* flex on the inner div: a <td> with display:flex leaves table layout,
                    which ignores colSpan and stretches the table (measured 558→858px). */}
                <td className="draft-blocked-cell" colSpan={totalCols}>
                  <div className="draft-blocked-inner">
                    <span className="draft-blocked-field" data-field={blockedField.err.field}>
                      <span className="draft-blocked-label">{blockedField.field?.label ?? blockedField.err.field}</span>
                      {/* No schema entry for the rejected field → no widget to open, so
                          offer no button: it would call editCell and re-render this same
                          branch, a control that visibly does nothing. The message alone
                          still names what blocked the create. */}
                      {blockedField.field && (
                        draft!.draft?.editing === blockedField.err.field ? (
                          (() => {
                            const Editor = cellEditorFor(widgetForField(blockedField.field));
                            return (
                              <Editor
                                initial={draft!.draft?.fields[blockedField.err.field]}
                                field={blockedField.field}
                                // Supplying the value RETRIES the create — the user already
                                // asked for the row; this strip only exists because the engine
                                // demanded one more field. Staging and stopping would clear the
                                // error, drop the strip, and leave a row that looks committed
                                // with nothing behind it. Unlike a field cell in the row, a
                                // mouse pick retries too: here the pick IS the intent.
                                onSubmit={(raw) => void draft!.commitWithField(blockedField.err.field, raw)}
                                onCancel={() => draft!.exitEdit()}
                              />
                            );
                          })()
                        ) : (
                          <button type="button" className="draft-blocked-btn" onClick={() => openCell(DRAFT_ROW_ID, blockedField.err.field)}>
                            set {blockedField.err.field}
                          </button>
                        )
                      )}
                    </span>
                    <span className="draft-inline-error" role="alert">{blockedField.err.message}</span>
                  </div>
                </td>
              </tr>
            )}
            {draftOpen && !draft!.isDrafting && (
              <tr className="draft-add-row" onClick={() => startDraft()} aria-label={`Add new ${lockedType}`}>
                <td className="draft-add-cell" colSpan={totalCols}>
                  <span className="draft-plus">+ New {lockedType}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
