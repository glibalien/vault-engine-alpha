import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LinkCountKind, LinkCountOp, LinkCountRule, Schema, SchemaField } from '@vault/query-core';
import { LINK_COUNT_HINT, LINK_COUNT_KINDS, LINK_COUNT_OPS, LINK_COUNT_OP_SYMBOL, linkCountRuleCount, summarizeFragment, withLinkCountRule } from '@vault/query-core';
import { Icon, type IconName } from './icon.js';
import type { TableSort, VizKind, VizSpec } from './viz-spec.js';
import { VIZ_KINDS, SORT_OPTIONS, sortOptionKey, specForTypeChange, tableSortLabel } from './viz-spec.js';
import type { VizQueryVM } from './use-viz-query.js';
import { useDismissOnOutside } from './use-dismiss-on-outside.js';
import { TypeLockChip } from './TypeLockChip.js';
import { FieldChips } from './FieldChips.js';
import { ColumnPicker } from './ColumnPicker.js';
import { VizSettingsPanel } from './VizSettings.js';
import { CalendarFieldsPanel } from './CalendarSettings.js';
import { GroupByPanel } from './GroupBySettings.js';
import { vizWithDisplayFields } from './viz-query.js';
import { useToolbarFit } from './use-toolbar-fit.js';

export const KIND_LABEL: Record<VizKind, string> = { table: 'Table', kanban: 'Kanban', list: 'List', calendar: 'Calendar' };
export const KIND_TOOLBAR_ICON: Record<VizKind, IconName> = { table: 'b-table', kanban: 'b-kanban', list: 'b-list', calendar: 'b-calendar' };

/** Editable-query wiring for the toolbar's Sort / Filter / Properties / Search controls.
 *  Absent for read-only cards (no onSpecChange), which get Layout + Results only. */
export interface VizToolbarQuery {
  spec: VizSpec;
  onSpecChange: (next: VizSpec) => void;
  vm: VizQueryVM;
  schema: Schema | null;
  availableTypes: string[];
  typeCounts?: Record<string, number>;
  addableSchemaFields: SchemaField[];
  /** Tables only: the view's one sort, which the header arrow shows too, and the header-click
   *  action (a column sort's menu item reuses it to flip direction). Absent for other kinds,
   *  whose Sort lists the server orders only. */
  tableSort?: { sort: TableSort | null; onColumn: (key: string) => void };
  /** Calendars only: the field the calendar plots by now (saved, else the fallback it found) and
   *  the date fields its Layout menu offers (calendarFieldOptions). */
  calendar?: { dateField: string | null; options: string[] };
  /** Tables, lists and kanbans: the field the view groups by now (null: none, or a kanban with no
   *  status field), the fields its Layout menu offers, and whether None is one of them (#573). */
  grouping?: { field: string | null; options: string[]; allowNone: boolean };
}

type Pop = 'layout' | 'results' | 'sort' | 'filter' | 'properties' | 'more';

/** Number of active filters shown on the Filter button's badge. */
export function activeFilterCount(vm: VizQueryVM): number {
  return (vm.lockedType ? 1 : 0) + vm.chips.length + vm.fragments.length + (vm.strip.title_contains.trim() ? 1 : 0)
    + linkCountRuleCount(vm.strip.link_counts);
}

/** The count a newly picked comparison starts at: "≤ 1" and "≥ 1" for the few-links and has-links
 *  questions, "= 0" for none. */
const FIRST_COUNT: Record<LinkCountOp, number> = { lte: 1, eq: 0, gte: 1 };

/** The Filter rows' names: the column headers, shortened where the row is narrow. */
const FILTER_ROW_LABEL: Record<LinkCountKind, string> = { incoming: 'links in', outgoing: 'links out', unresolved: 'unresolved' };

/** The filters "+ filter" adds beside the type's fields (#617), in the order their rows show. */
type BuiltinFilter = 'title' | LinkCountKind;
const BUILTIN_FILTERS: readonly BuiltinFilter[] = ['title', ...LINK_COUNT_KINDS];
const BUILTIN_MENU_LABEL: Record<BuiltinFilter, string> = {
  title: 'title contains', incoming: 'links in', outgoing: 'links out', unresolved: 'unresolved links',
};
const isBuiltinFilter = (key: string): key is BuiltinFilter => (BUILTIN_FILTERS as readonly string[]).includes(key);

/** A built-in row's ×: removes the row and clears its filter. */
function RemoveRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="viz-filter-x" aria-label={`remove ${label} filter`} title="Remove filter" onClick={onClick}>
      <Icon name="b-x" />
    </button>
  );
}

/** One Filter row per link count (#611): `links in [any|≤|=|≥] [n] ×`. */
function LinkCountFilterRow({ kind, rule, onChange, onRemove, autoFocus }: {
  kind: LinkCountKind;
  rule: LinkCountRule | undefined;
  onChange: (rule: LinkCountRule | undefined) => void;
  onRemove: () => void;
  autoFocus?: boolean;
}) {
  const label = FILTER_ROW_LABEL[kind];
  return (
    <div className="viz-filter-row">
      <span className="viz-filter-prop" title={LINK_COUNT_HINT[kind]}>{label}</span>
      <select
        aria-label={`${label} comparison`}
        autoFocus={autoFocus}
        value={rule?.op ?? ''}
        onChange={(e) => {
          const op = e.target.value as LinkCountOp | '';
          onChange(op === '' ? undefined : { op, value: rule?.value ?? FIRST_COUNT[op] });
        }}
      >
        <option value="">any</option>
        {LINK_COUNT_OPS.map((op) => <option key={op} value={op}>{LINK_COUNT_OP_SYMBOL[op]}</option>)}
      </select>
      {rule && (
        <input
          aria-label={`${label} count`}
          type="number"
          min={0}
          step={1}
          value={rule.value}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onChange({ op: rule.op, value: Number.isFinite(n) && n >= 0 ? n : 0 });
          }}
        />
      )}
      <RemoveRowButton label={label} onClick={onRemove} />
    </div>
  );
}

/**
 * VizToolbar — the Obsidian Bases-style header row shared by every query view:
 * `[Layout ▾] [N results] ……… [Sort] [Filter n] [Properties] [Search] {actions} [New]`.
 * Popovers are mutually exclusive and dismiss on an outside pointer-down.
 *
 * Always one row (#404): as the toolbar narrows it drops its labels, then moves Sort / Filter /
 * Properties / New into a ⋯ menu, then the results count too (see useToolbarFit). An overflowed
 * control's popover still opens from its own wrap; CSS anchors it to the toolbar instead.
 */
export function VizToolbar({ kind, onKind, shown, total, loading, onRefresh, query, onNew, newLabel, actions }: {
  kind: VizKind;
  onKind: (kind: VizKind) => void;
  shown: number;
  total: number;
  loading: boolean;
  onRefresh: () => void;
  query?: VizToolbarQuery;
  /** Starts a new row (table draft). Absent = no New button. */
  onNew?: () => void;
  newLabel?: string;
  /** Host-supplied buttons rendered before New (e.g. the board composer's sparkles). */
  actions?: ReactNode;
}) {
  const [pop, setPop] = useState<Pop | null>(null);
  const [searchOpen, setSearchOpen] = useState(() => !!query?.vm.strip.query);
  const toggle = (p: Pop) => setPop((cur) => (cur === p ? null : p));
  const close = () => setPop(null);
  // Title and link-count rows the person added from "+ filter" or edited (#617). A row also shows
  // whenever its filter is set, so a saved or AI-set filter appears without being added.
  const [keptRows, setKeptRows] = useState<ReadonlySet<BuiltinFilter>>(() => new Set());
  // The row just added from "+ filter", whose input or comparison takes focus as it appears.
  const [focusRow, setFocusRow] = useState<BuiltinFilter | null>(null);
  useEffect(() => { if (pop !== 'filter') setFocusRow(null); }, [pop]);
  const keepRow = (row: BuiltinFilter) => setKeptRows((cur) => (cur.has(row) ? cur : new Set(cur).add(row)));

  const layoutRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(layoutRef, pop === 'layout', close);
  useDismissOnOutside(resultsRef, pop === 'results', close);
  useDismissOnOutside(sortRef, pop === 'sort', close);
  useDismissOnOutside(filterRef, pop === 'filter', close);
  useDismissOnOutside(moreRef, pop === 'more', close);

  const vm = query?.vm;
  const filterCount = vm ? activeFilterCount(vm) : 0;
  const linkFragment = vm?.fragments.find((f) => f.key === 'link_counts');
  // A link_counts filter the rows can't show (a rel_type, two comparisons on one count) stays a
  // caller chip in their place, and the link rows aren't offered until it is removed.
  const builtinOffered = (row: BuiltinFilter) => row === 'title' || !linkFragment;
  const builtinSet = (row: BuiltinFilter) =>
    !!vm && (row === 'title' ? vm.strip.title_contains !== '' : !!vm.strip.link_counts?.[row]);
  const shownRows = new Set(BUILTIN_FILTERS.filter((r) => builtinOffered(r) && (keptRows.has(r) || builtinSet(r))));
  const addRow = (row: BuiltinFilter) => { keepRow(row); setFocusRow(row); };
  const removeRow = (row: BuiltinFilter) => {
    setKeptRows((cur) => { const next = new Set(cur); next.delete(row); return next; });
    if (!vm || !builtinSet(row)) return;
    vm.setStrip(row === 'title'
      ? { ...vm.strip, title_contains: '' }
      : { ...vm.strip, link_counts: withLinkCountRule(vm.strip.link_counts, row, undefined) });
  };
  const resultsText = `${shown}${total > shown ? ` of ${total}` : ''} ${shown === 1 && total <= 1 ? 'result' : 'results'}`;
  const resultsShort = `${shown}${total > shown ? `/${total}` : ''}`;
  const hasProperties = !!(vm && query?.schema);
  const newText = newLabel ?? 'New';
  const tableSort = query?.tableSort;
  // A table's Sort button names the sort in effect; other kinds keep the plain "Sort" label.
  const sortText = tableSort ? tableSortLabel(tableSort.sort) : 'Sort';

  const level = useToolbarFit(
    toolbarRef,
    [kind, resultsText, loading, filterCount, searchOpen, !!vm, hasProperties, !!onNew, newText, !!actions, sortText].join('|'),
  );
  const overflowed: { key: Pop | 'new'; icon: IconName; label: string; badge?: number }[] = [];
  if (level >= 3) overflowed.push({ key: 'results', icon: 'b-refresh', label: resultsText });
  if (level >= 2) {
    if (vm) {
      overflowed.push({ key: 'sort', icon: 'b-sort', label: 'Sort' });
      overflowed.push({ key: 'filter', icon: 'b-filter', label: 'Filter', badge: filterCount });
    }
    if (hasProperties) overflowed.push({ key: 'properties', icon: 'b-properties', label: 'Properties' });
    if (onNew) overflowed.push({ key: 'new', icon: 'b-plus', label: newText });
  }
  const showMore = overflowed.length > 0;
  // The ⋯ menu unmounts when the toolbar widens back out; don't leave it "open" for next time.
  useEffect(() => { if (!showMore && pop === 'more') setPop(null); }, [showMore, pop]);
  const pickOverflowed = (key: Pop | 'new') => {
    if (key === 'new') { close(); onNew?.(); } else setPop(key);
  };

  const levelClass = `${level >= 1 ? ' is-compact' : ''}${level >= 2 ? ' is-overflow' : ''}${level >= 3 ? ' is-tight' : ''}`;

  return (
    <div className={`viz-toolbar${levelClass}`} role="toolbar" aria-label="View options" ref={toolbarRef}>
      <div className="viz-tb-wrap" ref={layoutRef}>
        <button
          type="button"
          className={`viz-tb-btn viz-tb-layout${pop === 'layout' ? ' on' : ''}`}
          aria-label={`Layout: ${KIND_LABEL[kind]}`}
          aria-haspopup="menu"
          aria-expanded={pop === 'layout'}
          onClick={() => toggle('layout')}
        >
          <Icon name={KIND_TOOLBAR_ICON[kind]} />
          <span className="viz-tb-label">{KIND_LABEL[kind]}</span>
          <Icon name="b-chevron-down" className="viz-tb-caret" />
        </button>
        {pop === 'layout' && (
          <div className="viz-pop viz-pop-left viz-layout-menu" role="menu" aria-label="Layout">
            <div className="viz-pop-title">Layout</div>
            {VIZ_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={kind === k}
                className={`viz-mi${kind === k ? ' on' : ''}`}
                // Every kind has settings below the kinds on an editable view: the menu stays open.
                onClick={() => { onKind(k); if (!query) close(); }}
              >
                <Icon name={KIND_TOOLBAR_ICON[k]} />
                <span className="viz-mi-label">{KIND_LABEL[k]}</span>
                {kind === k && <Icon name="b-check" className="viz-mi-check" />}
              </button>
            ))}
            {query?.grouping && (
              <>
                <div className="viz-pop-sep" />
                <div className="viz-pop-section">
                  <GroupByPanel
                    spec={query.spec}
                    onSpecChange={query.onSpecChange}
                    field={query.grouping.field}
                    options={query.grouping.options}
                    allowNone={query.grouping.allowNone}
                  />
                </div>
              </>
            )}
            {kind === 'table' && query && (
              <>
                <div className="viz-pop-sep" />
                <div className="viz-pop-section"><VizSettingsPanel spec={query.spec} onSpecChange={query.onSpecChange} /></div>
              </>
            )}
            {kind === 'calendar' && query?.calendar && (
              <>
                <div className="viz-pop-sep" />
                <div className="viz-pop-section">
                  <CalendarFieldsPanel spec={query.spec} onSpecChange={query.onSpecChange} dateField={query.calendar.dateField} options={query.calendar.options} />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="viz-tb-wrap viz-tb-results-wrap" ref={resultsRef}>
        <button
          type="button"
          className={`viz-tb-btn viz-tb-results${pop === 'results' ? ' on' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={pop === 'results'}
          title="Live results · refreshes every 30s"
          onClick={() => toggle('results')}
        >
          {loading && <span className="viz-spin" aria-hidden="true" />}
          <span className="viz-tb-label">{resultsText}</span>
          <span className="viz-tb-results-short" aria-hidden="true">{resultsShort}</span>
        </button>
        {pop === 'results' && (
          <div className="viz-pop viz-pop-left viz-results-menu" role="dialog" aria-label="Results">
            {vm && (
              <label className="viz-pop-row">
                <span className="viz-pop-label">Limit results</span>
                <input
                  aria-label="limit"
                  type="number"
                  min={1}
                  max={200}
                  value={vm.strip.limit}
                  onChange={(e) => vm.setStrip({ ...vm.strip, limit: parseInt(e.target.value, 10) || 50 })}
                />
              </label>
            )}
            <button type="button" className="viz-mi" onClick={() => { onRefresh(); close(); }}>
              <Icon name="b-refresh" />
              <span className="viz-mi-label">Refresh now</span>
            </button>
            <div className="viz-pop-note">Live vault results · refreshes every 30s</div>
          </div>
        )}
      </div>

      <div className="viz-tb-spacer" />

      {vm && query && (
        <>
          <div className="viz-tb-wrap viz-tb-overflowable" ref={sortRef}>
            <button
              type="button"
              className={`viz-tb-btn${pop === 'sort' ? ' on' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={pop === 'sort'}
              aria-label={tableSort ? `Sort: ${sortText}` : undefined}
              title={tableSort ? `Sort: ${sortText}` : 'Sort'}
              onClick={() => toggle('sort')}
            >
              <Icon name="b-sort" />
              <span className="viz-tb-label">{sortText}</span>
            </button>
            {pop === 'sort' && (
              <div className="viz-pop viz-pop-right viz-sort-menu" role="dialog" aria-label="Sort">
                <div className="viz-pop-title">Sort by</div>
                {tableSort?.sort?.client && (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked
                    className="viz-mi on"
                    title="Reverse the order"
                    onClick={() => { tableSort.onColumn(tableSort.sort!.key); close(); }}
                  >
                    <span className="viz-mi-label">{sortText}</span>
                    <Icon name="b-check" className="viz-mi-check" />
                  </button>
                )}
                {SORT_OPTIONS.map((o) => {
                  // A table's column sort replaces the server order, so no server option is checked
                  // under one. Tables match exactly; other kinds keep the first-option fallback.
                  const on = tableSort
                    ? !tableSort.sort?.client && vm.strip.sort_by === o.sort_by && vm.strip.sort_order === o.sort_order
                    : sortOptionKey(vm.strip.sort_by, vm.strip.sort_order) === o.key;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      className={`viz-mi${on ? ' on' : ''}`}
                      onClick={() => { vm.setSort(o.sort_by, o.sort_order); close(); }}
                    >
                      <span className="viz-mi-label">{o.label}</span>
                      {on && <Icon name="b-check" className="viz-mi-check" />}
                    </button>
                  );
                })}
                {tableSort && (
                  <div className="viz-pop-note">
                    {tableSort.sort === null
                      ? 'A search ranks results by relevance. The order picked here applies once the search is cleared.'
                      : 'Or click a column header to sort by that column.'}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="viz-tb-wrap viz-tb-overflowable" ref={filterRef}>
            <button
              type="button"
              className={`viz-tb-btn${pop === 'filter' ? ' on' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={pop === 'filter'}
              title="Filter"
              onClick={() => toggle('filter')}
            >
              <Icon name="b-filter" />
              <span className="viz-tb-label">Filter</span>
              {filterCount > 0 && <span className="viz-tb-badge" aria-label={`${filterCount} active`}>{filterCount}</span>}
            </button>
            {pop === 'filter' && (
              <div className="viz-pop viz-pop-right viz-filter-pop" role="dialog" aria-label="Filters">
                <div className="viz-pop-title">All the following are true</div>
                <div className="viz-filter-row">
                  <span className="viz-filter-prop">type</span>
                  <span className="viz-filter-op">is</span>
                  <TypeLockChip
                    lockedType={vm.lockedType}
                    availableTypes={query.availableTypes}
                    counts={query.typeCounts}
                    // Bypasses vm.dispatch on purpose: writing the new spec re-inits useVizQuery from
                    // spec.query (clearing chips/strip for the new type) — the desired type-switch reset.
                    onPick={(t) => query.onSpecChange(specForTypeChange(query.spec, t))}
                    onUnlock={() => vm.setTypeLock(null)}
                  />
                </div>
                {shownRows.has('title') && (
                  <div className="viz-filter-row">
                    <span className="viz-filter-prop">title</span>
                    <span className="viz-filter-op">contains</span>
                    <input
                      aria-label="title-contains"
                      type="text"
                      placeholder="any text…"
                      autoFocus={focusRow === 'title'}
                      value={vm.strip.title_contains}
                      onChange={(e) => { keepRow('title'); vm.setStrip({ ...vm.strip, title_contains: e.target.value }); }}
                    />
                    <RemoveRowButton label="title contains" onClick={() => removeRow('title')} />
                  </div>
                )}
                {linkFragment ? (
                  <div className="viz-filter-row">
                    <span className="viz-filter-prop">links</span>
                    <span className="fchip fchip-caller" title={summarizeFragment(linkFragment).tooltip}>
                      <span className="flabel">{summarizeFragment(linkFragment).label}</span>
                      <button
                        type="button"
                        className="x"
                        aria-label={`remove filter ${summarizeFragment(linkFragment).label}`}
                        onClick={() => vm.removeFragment(linkFragment.id)}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ) : LINK_COUNT_KINDS.filter((kind) => shownRows.has(kind)).map((kind) => (
                  <LinkCountFilterRow
                    key={kind}
                    kind={kind}
                    rule={vm.strip.link_counts?.[kind]}
                    autoFocus={focusRow === kind}
                    onChange={(rule) => {
                      keepRow(kind);
                      vm.setStrip({ ...vm.strip, link_counts: withLinkCountRule(vm.strip.link_counts, kind, rule) });
                    }}
                    onRemove={() => removeRow(kind)}
                  />
                ))}
                {/* Also on a view with no type, where "+ filter" offers only the four built-in filters. */}
                <FieldChips
                  schema={query.schema}
                  chips={vm.chips}
                  addableFields={query.addableSchemaFields}
                  fragments={vm.fragments.filter((f) => f.key !== 'link_counts')}
                  onAddChip={vm.addChip}
                  onSetChip={vm.setChip}
                  onRemoveChip={vm.removeChip}
                  onRemoveFragment={vm.removeFragment}
                  extraAddOptions={BUILTIN_FILTERS.filter((r) => builtinOffered(r) && !shownRows.has(r)).map((r) => ({
                    key: r,
                    label: BUILTIN_MENU_LABEL[r],
                    hint: r === 'title' ? undefined : LINK_COUNT_HINT[r],
                  }))}
                  onAddExtra={(key) => { if (isBuiltinFilter(key)) addRow(key); }}
                />
              </div>
            )}
          </div>

          {query.schema && (
            <ColumnPicker
              schema={query.schema}
              displayFields={query.spec.display_fields}
              onChange={(next) => query.onSpecChange(vizWithDisplayFields(query.spec, next))}
              open={pop === 'properties'}
              onOpenChange={(o) => setPop((cur) => (o ? 'properties' : cur === 'properties' ? null : cur))}
            />
          )}

          {searchOpen ? (
            <span className="viz-tb-search">
              <Icon name="b-search" />
              <input
                aria-label="hybrid-search"
                type="text"
                placeholder="Search…"
                autoFocus={!vm.strip.query}
                value={vm.strip.query}
                onChange={(e) => vm.setStrip({ ...vm.strip, query: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { vm.setStrip({ ...vm.strip, query: '' }); setSearchOpen(false); }
                }}
              />
              <button
                type="button"
                className="viz-tb-icon"
                aria-label="Clear search"
                onClick={() => { vm.setStrip({ ...vm.strip, query: '' }); setSearchOpen(false); }}
              >
                <Icon name="b-x" />
              </button>
            </span>
          ) : (
            <button type="button" className="viz-tb-btn viz-tb-icon" aria-label="Search" onClick={() => setSearchOpen(true)}>
              <Icon name="b-search" />
            </button>
          )}
        </>
      )}

      {actions}

      {onNew && (
        <button type="button" className="viz-tb-btn viz-tb-new" title={newText} onClick={onNew}>
          <Icon name="b-plus" />
          <span className="viz-tb-label">{newText}</span>
        </button>
      )}

      {showMore && (
        <div className="viz-tb-wrap viz-tb-more" ref={moreRef}>
          <button
            type="button"
            className={`viz-tb-btn viz-tb-icon${pop === 'more' ? ' on' : ''}`}
            aria-label="More view options"
            title="More view options"
            aria-haspopup="menu"
            aria-expanded={pop === 'more'}
            onClick={() => toggle('more')}
          >
            <Icon name="b-more" />
          </button>
          {pop === 'more' && (
            <div className="viz-pop viz-pop-right viz-more-menu" role="menu" aria-label="More view options">
              {overflowed.map((o) => (
                <button key={o.key} type="button" role="menuitem" className="viz-mi" onClick={() => pickOverflowed(o.key)}>
                  <Icon name={o.icon} />
                  <span className="viz-mi-label">{o.label}</span>
                  {!!o.badge && <span className="viz-tb-badge" aria-label={`${o.badge} active`}>{o.badge}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
