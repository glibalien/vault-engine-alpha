import type { Schema } from '@vault/query-core';

/**
 * The names in Engine's vault map (`Settings/Vault.md`) that views read: the task kind, its status
 * field and values, and the date and priority fields. It is the subset of `VaultSettings`
 * (@vault/settings-registry) the views need, so a host passes `vaultSettingsFrom(...)` as is.
 *
 * A kind or field that is null is none: what depends on it is off (no query, no write). A host
 * that passes no vocabulary gets today's names (DEFAULT_VIEW_VOCABULARY).
 */
export interface ViewVocabulary {
  taskType: string | null;
  taskStatusField: string | null;
  taskActiveStatuses: readonly string[];
  taskDoneStatuses: readonly string[];
  taskBlockedStatuses: readonly string[];
  taskBacklogStatuses: readonly string[];
  taskIgnoredStatuses: readonly string[];
  /** The value ticking a task writes to its status field. */
  taskTickStatus: string;
  /** The value unticking a task writes to its status field. */
  taskUntickStatus: string;
  projectActiveStatuses: readonly string[];
  projectDoneStatuses: readonly string[];
  projectBlockedStatuses: readonly string[];
  projectBacklogStatuses: readonly string[];
  projectIgnoredStatuses: readonly string[];
  dueField: string | null;
  dateField: string | null;
  scheduledField: string | null;
  priorityField: string | null;
}

/** The vault map's defaults: the names the views used before the map existed. */
export const DEFAULT_VIEW_VOCABULARY: ViewVocabulary = {
  taskType: 'task',
  taskStatusField: 'status',
  taskActiveStatuses: ['open', 'in-progress'],
  taskDoneStatuses: ['done'],
  taskBlockedStatuses: ['blocked'],
  taskBacklogStatuses: ['backlog'],
  taskIgnoredStatuses: ['dropped'],
  taskTickStatus: 'done',
  taskUntickStatus: 'open',
  projectActiveStatuses: ['open', 'in-progress'],
  projectDoneStatuses: ['done'],
  projectBlockedStatuses: ['blocked'],
  projectBacklogStatuses: ['backlog'],
  projectIgnoredStatuses: ['dropped'],
  dueField: 'due',
  dateField: 'date',
  scheduledField: 'scheduled',
  priorityField: 'priority',
};

/** The named fields, in order, without the ones that are none. */
export function namedFields(...names: Array<string | null>): string[] {
  return names.filter((n): n is string => n !== null);
}

/**
 * Whether the List view's checkbox can work, so it is shown (#488). A click must write a value the
 * row then shows the right way, and that Engine takes:
 * - the vault has a task status field;
 * - the tick value is one of the done statuses (a ticked row shows ticked);
 * - the untick value is usable: not empty and not one of the done statuses (an unticked row shows
 *   unticked). It need not be in the active list: an untick value outside it still unticks;
 * - when the view knows the field is an enum (`enumValues`, from the type's schema), Engine takes
 *   both values: each matches an enum value the way Engine matches them, trimmed and ignoring case.
 * Done-ness is the same exact test the row uses to show a task as done.
 */
export function taskCheckboxOn(v: ViewVocabulary, enumValues?: readonly string[]): boolean {
  if (v.taskStatusField === null) return false;
  const tick = v.taskTickStatus;
  const untick = v.taskUntickStatus;
  if (!v.taskDoneStatuses.includes(tick)) return false;
  if (untick.trim() === '' || v.taskDoneStatuses.includes(untick)) return false;
  if (enumValues === undefined) return true;
  const takes = (value: string) => enumValues.some((e) => e.toLowerCase() === value.trim().toLowerCase());
  return takes(tick) && takes(untick);
}

/** The values `field` takes when `schema` has it as an enum with known values; otherwise undefined. */
export function enumValuesOf(schema: Pick<Schema, 'fields'> | null | undefined, field: string | null): string[] | undefined {
  const f = field === null ? undefined : schema?.fields.find((s) => s.name === field);
  return f?.type === 'enum' && Array.isArray(f.enum_values) ? f.enum_values : undefined;
}

/**
 * The field a view groups and ticks by when its spec names none: the task status field. Null when
 * the vault has none; then a kanban without `group_by` shows one column and the list no checkbox.
 */
export function viewStatusField(spec: { group_by?: string }, v: ViewVocabulary): string | null {
  return spec.group_by ?? v.taskStatusField;
}

/** Field names a calendar tries, in order, when its spec names no date field. */
export function calendarDateFields(v: ViewVocabulary): string[] {
  return namedFields(v.dueField, v.dateField, v.scheduledField);
}
