import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icon.js';
import type { VizKind, VizRow, VizSpec } from './viz-spec.js';
import { columnLabel, defaultDisplayFields, deriveVizTitle, foldedGroups, groupByOptions, groupsByDay, nextTableSort, sectionField, showsLinkCounts, specWithFoldToggled, tableSortOf, type ServerSortKey } from './viz-spec.js';
import { VizTable, type RowSections } from './VizTable.js';
import { VizKanban } from './VizKanban.js';
import { VizTaskList } from './VizTaskList.js';
import { VizCalendar } from './VizCalendar.js';
import { VizToolbar } from './VizToolbar.js';
import { useVizData } from './use-viz-data.js';
import { useVizRefFields } from './use-viz-refs.js';
import { useVizQuery } from './use-viz-query.js';
import { useVizTypes, useVizSchema, useVizSchemas, useVizTypeCounts } from './use-viz-schema.js';
import type { PreviewRef } from './preview-ref.js';
import { calendarFieldOptions, calendarZone, resolveDateField } from './calendar-grid.js';
import { useVizCellEdit } from './use-viz-cell-edit.js';
import type { VizCellEditAPI } from './use-viz-cell-edit.js';
import { useVizBulk } from './use-viz-bulk.js';
import { BulkBar } from './BulkBar.js';
import { useVizDraft } from './use-viz-draft.js';
import type { VizDraftAPI } from './use-viz-draft.js';
import { useVizJustCreated, mergeJustCreated } from './use-viz-just-created.js';
import { useVizExpand } from './use-viz-expand.js';
import type { VizExpandAPI } from './use-viz-expand.js';
import { useSeedFields } from './use-seed-fields.js';
import { useVizClient, useVizTimeZone, useVizVocabulary } from './viz-client-context.js';
import { calendarDateFields, enumValuesOf, viewStatusField } from './view-vocabulary.js';
import { useVizStatusMutate } from './use-viz-status-mutate.js';
import type { Schema } from "@vault/query-core";

type ColumnWidthMap = Record<string, number>;
type ColumnWidthGroups = { kanban?: ColumnWidthMap; table?: ColumnWidthMap };

function isColumnWidthMap(value: unknown): value is ColumnWidthMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((width) => typeof width === 'number');
}

/** Legacy specs stored Kanban widths directly. New writes keep each view kind isolated. */
function widthsFor(kind: 'kanban' | 'table', widths: unknown): ColumnWidthMap | undefined {
  if (typeof widths !== 'object' || widths === null || Array.isArray(widths)) return undefined;
  const groups = widths as ColumnWidthGroups;
  if (isColumnWidthMap(groups[kind])) return groups[kind];
  return kind === 'kanban' && isColumnWidthMap(widths) ? widths : undefined;
}

function withColumnWidth(kind: 'kanban' | 'table', widths: unknown, key: string, width: number): ColumnWidthGroups {
  const legacyKanban = isColumnWidthMap(widths) ? widths : undefined;
  const groups = (typeof widths === 'object' && widths !== null && !Array.isArray(widths) ? widths : {}) as ColumnWidthGroups;
  const kanban = isColumnWidthMap(groups.kanban) ? groups.kanban : (legacyKanban ?? {});
  const table = isColumnWidthMap(groups.table) ? groups.table : {};
  return { kanban, table, [kind]: { ...(kind === 'kanban' ? kanban : table), [key]: width } };
}

export function VizCardView({ spec, kind, rows, total, ranked, loading, error, onKind, onRefresh, onPin, pinned, onClose, collapsed, onToggleCollapse, onOpenPreview, refFields, onSpecChange, edit: editProp, bulk: bulkProp, draft: draftProp, expand: expandProp, allSchemas: allSchemasProp, justAddedIds, presentation = 'card', toolbarActions }: {
  spec: VizSpec;
  kind: VizKind;
  rows: VizRow[];
  total: number;
  /** The rows came back in search relevance order (useVizData). Omitted: any search counts as ranked. */
  ranked?: boolean;
  loading: boolean;
  error: string | null;
  onKind: (kind: VizKind) => void;
  onRefresh: () => void;
  onPin?: () => void;
  pinned?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenPreview?: (ref: PreviewRef) => void;
  refFields?: Set<string>;
  onSpecChange?: (next: VizSpec) => void;
  /** Shared edit-hook instance from VizCard. When absent (standalone use), VizCardView creates its own. */
  edit?: VizCellEditAPI;
  /** Shared bulk-hook instance from VizCard. When absent (standalone use), VizCardView creates its own. */
  bulk?: ReturnType<typeof useVizBulk>;
  /** Shared draft-hook instance from VizCard. When absent (standalone use), VizCardView creates its own. */
  draft?: VizDraftAPI;
  /** Shared expand-hook instance from VizCard. When absent (standalone use), VizCardView creates its own. */
  expand?: VizExpandAPI;
  /** Map of all schemas — used to compute expansion pairs. When absent, VizCardView creates its own. */
  allSchemas?: Map<string, Schema>;
  /** Row ids that were just created and may be out-of-filter — rendered with the viz-just-added cue. */
  justAddedIds?: ReadonlySet<string>;
  /** 'card' (default): bordered card with a title row (chat, MCP app). 'pane': flush, fills its
   *  container and drops the title row — the host already names the view (a board tab). */
  presentation?: VizPresentation;
  /** Host buttons placed in the toolbar before New (e.g. the board composer's sparkles). */
  toolbarActions?: ReactNode;
}) {
  const vocabulary = useVizVocabulary();
  const timeZone = useVizTimeZone();
  // The kanban's column field: the spec's, else the vault map's task status field. None: one column.
  const groupField = viewStatusField(spec, vocabulary);
  const hasRows = rows.length > 0;
  // A refresh failure with prior data is non-destructive: keep the last-good body, show a banner.
  // Only blank the card to a full-bleed error when there is nothing to fall back to.
  const staleError = error && hasRows ? error : null;

  // Editable-gating: only table kind + !collapsed.
  // onSpecChange is required for edit UI (it implies "editable mode").
  const editable = kind === 'table' && !collapsed && onSpecChange !== undefined;

  // When VizCardView is used standalone (no shared instance from VizCard), create its own.
  // The hooks are always called (Rules of Hooks); the active instance is selected after.
  const ownClient = useVizClient();
  const ownEdit = useVizCellEdit(ownClient, onRefresh);
  const edit = editProp ?? ownEdit;

  // ONE shared bulk hook instance — same client as the edit hook.
  // Passed down to both the checkbox column in VizTable and the BulkBar above the table.
  const ownBulk = useVizBulk(ownClient, rows, onRefresh);
  const bulk = bulkProp ?? ownBulk;

  // Editable filter UI — only rendered when onSpecChange is provided and card is not collapsed.
  // The hooks (useVizQuery, useVizTypes, useVizSchema) are always called (Rules of Hooks),
  // but their output is only used when the editable panel is visible.
  const vm = useVizQuery(spec, onSpecChange ?? (() => {}));
  const availableTypes = useVizTypes();
  const typeCounts = useVizTypeCounts();
  const schema = useVizSchema(vm.lockedType);

  // ONE shared draft hook — always called (Rules of Hooks). When VizCardView is used
  // standalone (no draftProp from VizCard), create its own.
  const emptySchema = useMemo(() => ({ name: '', display_name: null, fields: [] }), []);
  const ownDraft = useVizDraft(ownClient, vm.lockedType ?? '', schema ?? emptySchema, onRefresh);
  const draft = draftProp ?? ownDraft;

  // ONE shared expand hook — always called (Rules of Hooks). When VizCardView is used
  // standalone (no expandProp from VizCard), create its own.
  const ownAllSchemas = useVizSchemas();
  const ownExpand = useVizExpand(ownClient, ownAllSchemas, vm.lockedType ?? '');
  const expand = expandProp ?? ownExpand;
  const allSchemas = allSchemasProp ?? ownAllSchemas;

  // Status mutation hook — always called (Rules of Hooks); self-disables when no client.
  // Powers kanban drag-to-reorder and list checkbox toggle (D7 ambient interactivity).
  const sm = useVizStatusMutate(rows, onRefresh);

  // Reconcile-on-refresh: prune vanished parents + re-query open groups on every refetch.
  // reconcile() early-returns when nothing is expanded — safe on every render.
  // expand's methods are stable useCallbacks; the returned API object is a fresh literal each
  // render, so we intentionally depend only on rows — adding expand would re-fire reconcile
  // every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void expand.reconcile(rows); }, [rows]);

  // Seed values from active filter chips — incl. async-resolved reference (link)
  // filters so a board "filtered by project" inherits the project into new rows.
  const seedFields = useSeedFields(vm.lockedType ? schema : null, vm.chips, vm.fragments);

  // Map addableFields (string[]) to SchemaField[] for FieldChips
  const addableSchemaFields = schema
    ? vm.addableFields
        .map((name) => schema.fields.find((f) => f.name === name))
        .filter((f): f is NonNullable<typeof f> => f !== undefined)
    : [];

  const showFilterUI = !collapsed && onSpecChange !== undefined;

  // The field a calendar plots by: the saved one, else today's fallback (the first of the vault
  // map's due/date/scheduled fields on the first loaded row). Its Layout menu offers the date
  // fields of the view's types.
  const calendarField = spec.date_field ?? resolveDateField(spec, rows[0] ? Object.keys(rows[0].fields) : [], calendarDateFields(vocabulary));
  const calendarOptions = useMemo(
    () => {
      const types = spec.query['types'];
      const names = Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string') : [];
      return calendarFieldOptions(names, allSchemas, [calendarField, spec.end_date_field]);
    },
    [spec.query, allSchemas, calendarField, spec.end_date_field],
  );

  // Table and List sections (#573): by the view's group_by, none without one. A date field gives one
  // section per day, in the calendar's zone. Folded sections are saved on the view; a view that
  // can't be saved (no onSpecChange) keeps them folded while it stays open.
  const sectionBy = sectionField({ kind, group_by: spec.group_by });
  const viewTypes = useMemo(() => {
    const t = spec.query['types'];
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
  }, [spec.query]);
  const sectionDay = useMemo(
    () => (sectionBy !== null && groupsByDay(sectionBy, viewTypes, allSchemas, rows) ? calendarZone(timeZone) : undefined),
    [sectionBy, viewTypes, allSchemas, rows, timeZone],
  );
  const [localFolds, setLocalFolds] = useState<{ field: string | null; values: string[] }>({ field: null, values: [] });
  const foldValues = onSpecChange ? foldedGroups(spec) : localFolds.field === sectionBy ? localFolds.values : [];
  // JSON, not a join: [] and [''] (only the "—" section folded) must not share a key.
  const foldKey = JSON.stringify(foldValues);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const folded = useMemo(() => new Set(foldValues), [foldKey]);
  const sections: RowSections | undefined = sectionBy === null ? undefined : {
    field: sectionBy,
    byDay: sectionDay,
    folded,
    onToggle: (value) => {
      if (onSpecChange) onSpecChange(specWithFoldToggled(spec, value));
      else setLocalFolds({ field: sectionBy, values: folded.has(value) ? foldValues.filter((v) => v !== value) : [...foldValues, value] });
    },
  };
  // The Layout menu's Group by: a kanban's column field (its default included), else the sections'.
  const groupPickerField = kind === 'kanban' ? groupField : sectionBy;
  const groupOptions = useMemo(
    () => groupByOptions(viewTypes, allSchemas, [...new Set(rows.flatMap((r) => Object.keys(r.fields)))], groupPickerField),
    [viewTypes, allSchemas, rows, groupPickerField],
  );

  // One sort per table view (#393): the header arrow, the toolbar's Sort and the saved spec agree.
  // Name sorts on the Engine (every row); other columns sort the loaded rows here. Read-only cards
  // (no onSpecChange) can't save a sort, so their table keeps its own local header sort.
  const tableSort = tableSortOf(spec, ranked);
  const sortByColumn = (key: string): void => {
    if (!onSpecChange) return;
    const next = nextTableSort(spec, key, ranked);
    if (next.client) onSpecChange({ ...spec, column_sort: { field: next.key, order: next.order } });
    else vm.setSort(next.key as ServerSortKey, next.order);
  };
  // A column sort and sections (#573) both work on the loaded rows only: say so when the limit cut
  // the result off, since a section's count (or a whole section) can then come up short.
  const cutOff = total > rows.length;
  const sortsLoaded = kind === 'table' && !!onSpecChange && !!tableSort?.client && cutOff;
  const groupsLoaded = sections !== undefined && cutOff;
  const sortNote = sortsLoaded && groupsLoaded
    ? `Sorted by ${columnLabel(tableSort!.key)} and grouped within the ${rows.length} loaded rows, not all ${total}.`
    : sortsLoaded
      ? `Sorted by ${columnLabel(tableSort!.key)} within the ${rows.length} loaded rows, not all ${total}.`
      : groupsLoaded
        ? `Grouped within the ${rows.length} loaded rows, not all ${total}.`
        : null;

  const body = error && !hasRows ? (
    <div className="viz-error">{error}</div>
  ) : !hasRows && loading ? (
    <div className="viz-loading">Loading vault items…</div>
  ) : kind === 'table' ? (
    <>
      {editable && (bulk.selectedCount > 0 || bulk.outcome !== null) && (
        <BulkBar bulk={bulk} schema={schema} />
      )}
      <VizTable
        rows={rows}
        displayFields={spec.display_fields}
        groupField={groupField ?? ''}
        onOpenPreview={onOpenPreview}
        refFields={refFields}
        density={spec.density}
        showRowNumbers={spec.show_row_numbers}
        showVersion={spec.show_version}
        showLinkCounts={showsLinkCounts(spec)}
        columnWidths={widthsFor('table', spec.column_widths)}
        onColumnWidthChange={onSpecChange ? (field, width) => onSpecChange({ ...spec, column_widths: withColumnWidth('table', spec.column_widths, field, width) }) : undefined}
        edit={editable ? edit : undefined}
        editable={editable}
        schema={schema}
        bulk={editable ? bulk : undefined}
        draft={editable ? draft : undefined}
        lockedType={vm.lockedType ?? undefined}
        seedFields={seedFields}
        expand={editable ? expand : undefined}
        allSchemas={allSchemas}
        justAddedIds={justAddedIds}
        showRowFilter={false}
        sort={tableSort}
        onSort={onSpecChange ? sortByColumn : undefined}
        sections={sections}
      />
    </>
  ) : kind === 'kanban' ? (
    <VizKanban
      rows={sm.rows}
      groupBy={groupField ?? ''}
      displayFields={spec.display_fields}
      onOpenPreview={onOpenPreview}
      refFields={refFields}
      onSetStatus={groupField !== null ? sm.setStatus : undefined}
      columnWidths={widthsFor('kanban', spec.column_widths)}
      onColumnWidthChange={onSpecChange ? (value, width) => onSpecChange({ ...spec, column_widths: withColumnWidth('kanban', spec.column_widths, value, width) }) : undefined}
    />
  ) : kind === 'calendar' ? (
    <VizCalendar
      rows={rows}
      dateField={calendarField}
      endField={spec.end_date_field ?? null}
      timeZone={timeZone}
      canPickField={showFilterUI}
      onOpenPreview={onOpenPreview}
    />
  ) : (
    // The view's type's schema (already fetched above) says whether the status field is an enum and
    // what it takes: no checkbox whose click Engine would refuse (#488). Only the current type's:
    // useVizSchema keeps the last schema while another loads, and after the type is unlocked.
    <VizTaskList
      rows={sm.rows}
      displayFields={spec.display_fields}
      onOpenPreview={onOpenPreview}
      refFields={refFields}
      onToggle={sm.setStatus}
      statusEnum={vm.lockedType !== null && schema?.name === vm.lockedType ? enumValuesOf(schema, vocabulary.taskStatusField) : undefined}
      sections={sections}
    />
  );

  const pane = presentation === 'pane';
  const showTitleRow = !pane || !!onToggleCollapse || !!onPin || !!onClose;
  const types = (spec.query['types'] as string[] | undefined) ?? [];
  const canNew = editable && !!vm.lockedType && !!schema;

  return (
    <div className={`viz viz--${presentation}`}>
      {showTitleRow && (
        <div className="viz-head">
          {onToggleCollapse && (
            <button
              type="button"
              className="viz-chev"
              title={collapsed ? 'expand' : 'collapse'}
              aria-expanded={!collapsed}
              onClick={onToggleCollapse}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          )}
          <span className="vt">
            <span className="q">{deriveVizTitle(spec, vm.lockedType)}</span>
            {types.length > 0 && <span className="vsub">{types.join(' + ')}</span>}
          </span>
          <span className="vactions">
            <span className="viz-live" title="Live vault results · refreshes every 30s"><span className="viz-live-dot" />Live</span>
            {onPin && (
              <button type="button" className={`viz-btn${pinned ? ' pinned' : ''}`} onClick={onPin} aria-pressed={pinned ?? false}>
                <Icon name="b-pin" />{pinned ? 'pinned' : 'pin'}
              </button>
            )}
            {onClose && <button type="button" className="viz-iconbtn" title="remove from canvas" aria-label="remove from canvas" onClick={onClose}><Icon name="b-x" /></button>}
          </span>
        </div>
      )}
      {!collapsed && (
        <>
          <VizToolbar
            kind={kind}
            onKind={onKind}
            shown={rows.length}
            total={total}
            loading={loading}
            onRefresh={onRefresh}
            query={showFilterUI ? {
              spec,
              onSpecChange: onSpecChange!,
              vm,
              schema,
              availableTypes,
              typeCounts,
              addableSchemaFields,
              ...(kind === 'table' ? { tableSort: { sort: tableSort, onColumn: sortByColumn } } : {}),
              ...(kind === 'calendar' ? { calendar: { dateField: calendarField, options: calendarOptions } } : {}),
              ...(kind !== 'calendar' ? { grouping: { field: groupPickerField, options: groupOptions, allowNone: kind !== 'kanban' } } : {}),
            } : undefined}
            onNew={canNew && kind === 'table' ? () => draft.start(seedFields) : undefined}
            newLabel={vm.lockedType ? `New ${vm.lockedType}` : undefined}
            actions={toolbarActions}
          />
          {staleError && <div className="viz-stale" role="status">Couldn’t refresh. Showing previous results: {staleError}</div>}
          {sm.error && <div className="viz-stale" role="status">Couldn’t update this item: {sm.error}</div>}
          {sortNote && <div className="viz-sort-note" role="note">{sortNote}</div>}
          <div className="viz-main">{body}</div>
        </>
      )}
    </div>
  );
}

export type VizPresentation = 'card' | 'pane';

export function VizCard({ spec, onPin, pinned, onClose, collapsed, onToggleCollapse, onOpenPreview, onSpecChange, presentation, toolbarActions }: {
  spec: VizSpec;
  onPin?: () => void;
  pinned?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenPreview?: (ref: PreviewRef) => void;
  onSpecChange?: (next: VizSpec) => void;
  presentation?: VizPresentation;
  toolbarActions?: ReactNode;
}) {
  const [kind, setKind] = useState<VizKind>(spec.kind);
  // An external spec change (a composer tweak, a persisted layout switch) re-seeds the layout.
  useEffect(() => { setKind(spec.kind); }, [spec.kind]);
  // A layout switch is part of the view: editable hosts persist it on the spec, read-only
  // hosts (chat transcript cards) keep it local as before.
  const changeKind = (next: VizKind): void => {
    setKind(next);
    if (onSpecChange && next !== spec.kind) onSpecChange({ ...spec, kind: next });
  };

  // Single stable client — provided by VizClientProvider above this card.
  const client = useVizClient();

  // Mutable ref so the edit hook's onAfterCommit always calls the latest refresh,
  // even though edit is created before useVizData (which provides refresh).
  const refreshRef = useRef<() => void>(() => {});

  // ONE shared edit-hook instance. Its isEditing feeds the poll-pause below,
  // AND its mutation methods are threaded down to VizTable via VizCardView.
  // onAfterCommit calls refreshRef.current so it always invokes the latest refresh.
  const edit = useVizCellEdit(client, () => refreshRef.current());

  // Derive lockedType from spec.query for the draft hook (stays in sync as spec updates).
  const lockedType = (spec.query['types'] as string[] | undefined)?.[0] ?? '';
  const schema = useVizSchema(lockedType || null);

  // When a synthesized spec carries display_fields:[] (Inc 6 query-nodes auto-cards),
  // derive default columns from the locked type's schema (scalar fields, capped at 6).
  // Once schema is loaded, effectiveSpec carries those defaults — both useVizData and
  // VizCardView receive it so the live query's include_fields and the rendered columns agree.
  // When display_fields is non-empty OR schema hasn't loaded yet, effectiveSpec === spec.
  const effectiveSpec = useMemo(
    () => (spec.display_fields.length > 0 || !schema ? spec : { ...spec, display_fields: defaultDisplayFields(schema) }),
    [spec, schema],
  );

  // Pin just-created rows visible until the query identity (filters/sort/type) changes.
  const queryKey = useMemo(() => JSON.stringify(effectiveSpec.query), [effectiveSpec]);
  const justCreated = useVizJustCreated(queryKey);

  // ONE shared draft-hook instance. Its isDrafting feeds the poll-pause below.
  // onAfterCreate adds the created row to the pin set, then triggers a refresh.
  const draft = useVizDraft(client, lockedType, schema ?? { name: '', display_name: null, fields: [] }, (created) => {
    justCreated.add(created);
    refreshRef.current();
  });

  // ONE shared expand-hook instance. Passed to VizCardView so sub-table state
  // is stable across spec-change re-renders of VizCardView.
  const allSchemas = useVizSchemas();
  const expand = useVizExpand(client, allSchemas, lockedType);

  // Poll is paused while collapsed OR while an edit/draft is in flight.
  // All hook instances are the SAME ones VizTable uses — no split-brain.
  // (bulk.pending is not available here since bulk depends on rows from useVizData.)
  const { rows, total, ranked, loading, error, refresh } = useVizData(
    effectiveSpec,
    (collapsed ?? false) || edit.isEditing || draft.isDrafting,
  );

  // Keep the ref in sync with the latest refresh callback each render.
  refreshRef.current = refresh;

  // Merge just-created pinned rows with live query rows.
  // Query rows win on id collision; extras (out-of-filter) are flagged with justAddedIds.
  const { rows: displayRows, justAddedIds } = useMemo(
    () => mergeJustCreated(rows, justCreated.pinnedRows),
    [rows, justCreated.pinnedRows],
  );

  // ONE shared bulk-hook instance. Passed to both the checkbox column (VizTable)
  // and the BulkBar above the table. Uses the same stable client as the edit hook.
  // onAfterCommit triggers a refresh via the ref so it always calls the latest refresh.
  const bulk = useVizBulk(client, displayRows, () => refreshRef.current());

  const refFields = useVizRefFields(spec.query['types'] as string[] | undefined);
  return (
    <VizCardView
      spec={effectiveSpec}
      kind={kind}
      rows={displayRows}
      total={total}
      ranked={ranked}
      loading={loading}
      error={error}
      onKind={changeKind}
      onRefresh={refresh}
      onPin={onPin}
      pinned={pinned}
      onClose={onClose}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      onOpenPreview={onOpenPreview}
      refFields={refFields}
      onSpecChange={onSpecChange}
      edit={edit}
      bulk={bulk}
      draft={draft}
      expand={expand}
      allSchemas={allSchemas}
      justAddedIds={justAddedIds}
      presentation={presentation}
      toolbarActions={toolbarActions}
    />
  );
}
