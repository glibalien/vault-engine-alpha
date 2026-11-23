// -- types & specs --
export type { PreviewRef } from './preview-ref.js';
export type { ColumnWidths, ColumnSort, ServerSortKey, TableSort, VizKind, VizQuery, VizSpec, VizRow, SortOption } from './viz-spec.js';
export { VIZ_KINDS, isVizSpec, parseVizFence, serializeVizFence, rowsFromCallResult, CALENDAR_DATE_FALLBACKS, defaultDisplayFields, deriveVizTitle, specForTypeChange, vizQueryArgs, SORT_OPTIONS, sortOptionKey, tableSortOf, nextTableSort, tableSortLabel, withoutColumnSort, sectionField, groupByOptions, groupsByDay, foldedGroups, specWithGroupBy, specWithFoldToggled } from './viz-spec.js';
export type { SortState, RowGroup, StatusScale } from './viz-state.js';
export { STATUS_ORDER, DEFAULT_STATUS_SCALE, statusScaleFor, MISSING_BUCKET, statusColorVar, isStatus, fieldText, sortRows, filterRows, groupRows } from './viz-state.js';
export type { ViewVocabulary } from './view-vocabulary.js';
export { DEFAULT_VIEW_VOCABULARY, namedFields, viewStatusField, calendarDateFields, taskCheckboxOn, enumValuesOf } from './view-vocabulary.js';
export type { DayCell, CalendarItem, WeekBar } from './calendar-grid.js';
export { monthMatrix, resolveDateField, parseDayKey, calendarItems, calendarFieldOptions, calendarZone, layoutWeek } from './calendar-grid.js';
export {
  parseBoardCardSpec,
  type BoardCardSpec, type NodeCardSpec, type StatsCardSpec, type SpendCardSpec, type SpendRange,
} from './board-card-spec.js';

// -- refs --
export type { SchemaFieldLike } from './viz-refs.js';
export { referenceFieldNames } from './viz-refs.js';

// -- query --
export { vizOwnedState, vizWithQuery, vizWithDisplayFields } from './viz-query.js';
export type { VizQueryState, VizQueryAction } from './use-viz-query.js';
export { initVizQueryState, reduceVizQuery, composeFromState } from './use-viz-query.js';

// -- context --
export { VizClientProvider, useVizCall, useVizClient, useVizVocabulary, useVizTimeZone, useStatusScale } from './viz-client-context.js';

// -- hooks --
export type { VizBulkAPI, BulkReducerState, BulkAction, LinkPlan, VizBulkPlan } from './use-viz-bulk.js';
export { reduceBulk, parseDryDecision, parseCommitOutcome, useVizBulk, isLinkPlan, linkEdit } from './use-viz-bulk.js';
export type { VizCellEditOverlay, VizCellEditAPI, ReferenceMemberChange } from './use-viz-cell-edit.js';
export { applyCommit, applyMemberCommit, applyTitleCommit, applyStale, useVizCellEdit } from './use-viz-cell-edit.js';
export type { VizDraftAPI, DraftReducerState, DraftAction } from './use-viz-draft.js';
export { reduceDraft, parseCreateDecision, useVizDraft } from './use-viz-draft.js';
export { DRAFT_ROW_ID, draftRowFor, useDraftEditAdapter } from './use-draft-edit-adapter.js';
export type { VizExpandAPI, ExpandReducerState, ExpandAction } from './use-viz-expand.js';
export { nodeRowToVizRow, childDisplayFields, childRefFields, reduceExpand, useVizExpand } from './use-viz-expand.js';
export type { StatusMutateAPI } from './use-viz-status-mutate.js';
export { useVizStatusMutate } from './use-viz-status-mutate.js';
export { useVizData } from './use-viz-data.js';
export { useVizRefFields } from './use-viz-refs.js';
export { useVizSchema, useVizSchemas, useVizTypes, _resetCachesForTest } from './use-viz-schema.js';
export { useRefSuggest } from './use-ref-suggest.js';
export type { RefSuggestResult } from './use-ref-suggest.js';
export { useDismissOnOutside } from './use-dismiss-on-outside.js';

// -- cell editors --
export type { CellEditorProps, ReferenceListCellEditorProps } from './cell-editors/index.js';
export { TextCellEditor, EnumCellEditor, DateCellEditor, BoolCellEditor, ReferenceCellEditor, ReferenceListCellEditor, cellEditorFor } from './cell-editors/index.js';

// -- components --
export type { IconName } from './icon.js';
export { Icon } from './icon.js';
export type { PromotePillProps, CellErrorMsgProps, StaleReloadBarProps } from './CellConfirm.js';
export { PromotePill, CellErrorMsg, StaleReloadBar } from './CellConfirm.js';
export type { BulkBarProps } from './BulkBar.js';
export { BulkBar } from './BulkBar.js';
export { ColumnPicker } from './ColumnPicker.js';
export type { FieldChipsProps, FilterAddOption } from './FieldChips.js';
export { FieldChips } from './FieldChips.js';
export { FilterStrip, stripField } from './FilterStrip.js';
export type { ReferenceAutocompleteProps, PickResult } from './ReferenceAutocomplete.js';
export { ReferenceAutocomplete } from './ReferenceAutocomplete.js';
export { RefValue } from './RefValue.js';
export { TypeLockChip } from './TypeLockChip.js';
export { VizSettings, VizSettingsPanel } from './VizSettings.js';
export { VizToolbar, KIND_LABEL, KIND_TOOLBAR_ICON, activeFilterCount } from './VizToolbar.js';
export type { VizToolbarQuery } from './VizToolbar.js';
export { StatusPill, VizTable } from './VizTable.js';
export { VizKanban } from './VizKanban.js';
export { VizTaskList } from './VizTaskList.js';
export { VizCalendar } from './VizCalendar.js';
export { VizCardView, VizCard } from './VizCard.js';
export type { VizPresentation } from './VizCard.js';
export { StatsCard, WATCHER_STALE_MS } from './StatsCard.js';
export { NodeCard, BODY_SNIPPET_LINES } from './NodeCard.js';
export { SpendCard, loadSpendView, resolveSpendRange, offsetSegments, startOfDayInZone, type SpendView } from './SpendCard.js';
export { readCardEnvelope, type CardEnvelope } from './card-envelope.js';
export { ProvenanceInspector, type ProvenanceInspectorProps } from './ProvenanceInspector.js';
export { PagesBuiltFrom, type PagesBuiltFromProps } from './PagesBuiltFrom.js';
export type { ImpactCandidate } from './use-source-impact-review.js';
export type { InspectorTarget } from './provenance-inspector.js';
export { HomeRefresh } from './HomeRefresh.js';
export { WikiRebuild } from './WikiRebuild.js';
export { WikiSection, useWikiStatus, wikiState, type WikiSectionProps, type WikiLive } from './WikiSection.js';
export type { PageWiki, WikiHomeStatus, PageDossier, DossierKind, NoteKind, DossierRebuild } from './use-provenance-inspector.js';
export { DossierSection, useDossierStatus, useDossierNews, dossierState, dossierPageTitle, DOSSIER_POLL_MS, type DossierSectionProps, type DossierLive, type DossierNews, type DossierChanges } from './DossierSection.js';
export type { WikiRebuildProps } from './use-wiki-rebuild.js';
export { WikiCreate } from './WikiCreate.js';
export type { WikiCreateProps } from './use-wiki-create.js';
export { TopicWikiCreate } from './TopicWikiCreate.js';
export type { TopicWikiCreateProps } from './use-topic-wiki-create.js';
export { DossierBuild } from './DossierBuild.js';
export type { DossierBuildProps } from './use-dossier-build.js';
export type { HomeRefreshProps, HomeRefreshResume } from './use-home-refresh.js';
