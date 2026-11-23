import type {
  ProvenanceInputMetadata,
  ProvenanceSourceKey,
} from '@vault/query-core';

/**
 * Reader-facing shaping of a generation's recorded inputs. Engine records one
 * input per *use* of a source (a note can be read, listed on the timeline and
 * ranked as active in the same build), keyed by opaque IDs and curator-internal
 * selection names. This module folds those into one row per source, says how
 * each was used in plain words, and groups rows the way a reader thinks about
 * them. Pure — no I/O — so the inspector's wording is unit-testable.
 */
type Input = ProvenanceInputMetadata;

export type SourceUse =
  | 'read'
  | 'lead'
  | 'own_text'
  | 'timeline'
  | 'active'
  | 'task'
  | 'project'
  | 'recent'
  | 'closed'
  | 'risk'
  | 'page_list'
  | 'note_list'
  | 'memory'
  | 'correction'
  /** A dossier's own subject note, read (#554). */
  | 'subject_note'
  /** A meeting or note a dossier read in full (#720). */
  | 'full'
  | 'meeting_list'
  /** A note listed by title among those linking to a dossier's subject. */
  | 'linked_notes'
  | 'people'
  /** A memory a dossier was given as a rule on what may be said (#721). */
  | 'rule'
  /** A memory a newer one contradicted, given to a dossier as a past fact (#717). */
  | 'past'
  | 'other';

export const sourceUseLabels: Record<SourceUse, string> = {
  read: 'read',
  lead: 'related note, read',
  own_text: 'previous text',
  timeline: 'timeline',
  active: 'most active',
  task: 'task list',
  project: 'project details',
  recent: 'recently changed',
  closed: 'recently closed',
  risk: 'risk signal',
  page_list: 'page list',
  note_list: 'note list',
  memory: 'memory',
  correction: 'your correction',
  subject_note: 'the note itself',
  full: 'read in full',
  meeting_list: 'meeting list',
  linked_notes: 'note list',
  people: 'people and companies',
  rule: 'rule on what to say',
  past: 'past fact',
  other: 'other',
};

/** Where an excerpt of a listed source came from, for the "what it saw" caption. */
export const sourceUseOrigins: Partial<Record<SourceUse, string>> = {
  timeline: 'the timeline of dated tasks and meetings',
  active: 'the ranking of the most active notes',
  task: 'the task list',
  project: 'the project details',
  recent: 'the list of recently changed notes',
  closed: 'the list of recently closed items',
  risk: 'the list of risk signals',
  page_list: 'the list of pages in this wiki',
  note_list: 'the list of project notes',
  meeting_list: 'the list of meetings that link to it',
  linked_notes: 'the list of notes that link to it',
  people: 'the list of people and companies',
};

const READ_USES = new Set<SourceUse>(['read', 'lead', 'own_text', 'subject_note', 'full']);
/** A use whose recorded text is what Curator read of the source, not a line in a list. */
export const readsSource = (use: SourceUse): boolean => READ_USES.has(use);
/** Which of a source's inputs best shows what Curator read of it: a read over a listing, and the note's
 *  text over a heading that only names it (a dossier's subject line, #554). */
function readRank(input: Input): number {
  if (!READ_USES.has(sourceUse(input.selection))) return 0;
  return (input.selection ?? '').replace(/:v\d+$/, '') === 'dossier-subject' ? 1 : 2;
}

export function sourceUse(selection: string | null): SourceUse {
  const base = (selection ?? '').replace(/^opaque-/, '').replace(/:v\d+$/, '');
  if (base.startsWith('requested-tasks:')) return 'task';
  switch (base) {
    case 'formatted-node-body-prefix':
      return 'read';
    case 'gap-fill-candidate':
    case 'requested-related':
      return 'lead';
    case 'wiki-narrative-context':
      return 'own_text';
    case 'timeline-projection':
      return 'timeline';
    case 'salience-projection':
      return 'active';
    case 'task-fields':
      return 'task';
    case 'project-fields':
    case 'requested-project':
      return 'project';
    case 'changed-projection':
      return 'recent';
    case 'closed-projection':
      return 'closed';
    case 'risk-projection':
      return 'risk';
    case 'subpage-title-context':
      return 'page_list';
    case 'requested-note':
      return 'note_list';
    case 'memory':
      return 'memory';
    case 'correction':
      return 'correction';
    // A dossier's evidence (#554), by the selections the Curator records for it.
    case 'dossier-subject':
    case 'dossier-subject-note':
      return 'subject_note';
    case 'dossier-body':
      return 'full';
    case 'dossier-meeting':
      return 'meeting_list';
    case 'dossier-note-title':
      return 'linked_notes';
    case 'dossier-task':
      return 'task';
    case 'dossier-people':
      return 'people';
    case 'dossier-memory':
      return 'memory';
    case 'dossier-rule':
      return 'rule';
    case 'dossier-past-memory':
      return 'past';
    default:
      return 'other';
  }
}

/** Plain names for inputs that are not traceable to one note or memory. */
export function internalInputLabel(selection: string | null): string {
  const base = (selection ?? '').replace(/:v\d+$/, '');
  if (base.startsWith('opaque-')) {
    const origin = sourceUseOrigins[sourceUse(base.slice('opaque-'.length))];
    return origin ? `Heading and layout of ${origin}` : 'Untraceable block of evidence';
  }
  if (base.startsWith('requested-tasks:')) return 'Task counts';
  switch (base) {
    case 'system':
      return 'Curator instructions';
    case 'schema':
      return 'Required page format';
    case 'page_index':
      return 'Index of pages in this wiki';
    case 'aggregate-signals':
      return 'Overdue, blocked and activity counts';
    case 'requested-instruction':
      return 'The page request and its brief';
    case 'dossier-owner':
      return 'Your name, as the vault’s owner';
    case 'dossier-people-projection':
      return 'People and companies around the subject';
    case 'dossier-unlinked-people':
      return 'People named in its notes who have no note';
    default:
      return 'Other curator input';
  }
}

export type SourceStatus =
  | 'unchanged'
  | 'changed'
  | 'missing'
  | 'unknown'
  | 'self';

export const sourceStatusLabels: Record<Exclude<SourceStatus, 'unchanged'>, string> = {
  changed: 'changed since',
  missing: 'deleted since',
  unknown: "can't check",
  self: 'rewritten in this build',
};

const statusRank: Record<SourceStatus, number> = {
  unchanged: 0,
  self: 1,
  unknown: 2,
  changed: 3,
  missing: 4,
};

export function inputStatus(input: Input): SourceStatus {
  switch (input.comparison) {
    case 'unchanged':
      return 'unchanged';
    case 'changed':
      return 'changed';
    case 'missing':
      return 'missing';
    case 'expected_self_transition':
      return 'self';
    default:
      return 'unknown';
  }
}

export type SourceRow = {
  key: string;
  kind: 'note' | 'memory' | 'correction' | 'other';
  title: string | null;
  path: string | null;
  source: ProvenanceSourceKey | null;
  uses: SourceUse[];
  inputs: Input[];
  /** The input whose retained text best shows what the curator saw. */
  primary: Input;
  status: SourceStatus;
  truncated: boolean;
  /** Owner-authored (a memory or correction you gave), not curator-derived. */
  fromOwner: boolean;
  isTarget: boolean;
};

export type SourceGroups = {
  read: SourceRow[];
  mentioned: SourceRow[];
  memories: SourceRow[];
  /** Memories a dossier was given as past facts (#717): no longer true, for its History. */
  past: SourceRow[];
  corrections: SourceRow[];
  pages: SourceRow[];
  internal: Input[];
};

export const sourceKey = (source: ProvenanceSourceKey) =>
  `${source.kind}:${source.namespace}:${source.native_id}`;

const byTitle = (a: SourceRow, b: SourceRow) =>
  (a.title ?? a.key).localeCompare(b.title ?? b.key, undefined, {
    numeric: true,
    sensitivity: 'base',
  });

type Position = { field: string; start: number };

/** Where a row's earliest input begins in the request, or null when none has a position. */
function rowPosition(row: SourceRow): Position | null {
  let first: Position | null = null;
  for (const input of row.inputs) {
    const at = input.position;
    if (!at) continue;
    if (!first || at.field < first.field || (at.field === first.field && at.start < first.start)) first = at;
  }
  return first;
}

/**
 * Memories in the order the build gave them (#551): by where each begins in the request. Rows
 * with no position (purged, or recorded by an older Engine) follow, newest first.
 */
const memoryOrder = (a: SourceRow, b: SourceRow) => {
  const pa = rowPosition(a);
  const pb = rowPosition(b);
  if (pa && pb) {
    if (pa.field !== pb.field) return pa.field < pb.field ? -1 : 1;
    if (pa.start !== pb.start) return pa.start - pb.start;
  } else if (pa || pb) return pa ? -1 : 1;
  return Number(b.source?.native_id ?? 0) - Number(a.source?.native_id ?? 0);
};

/** True when every row has a position, so the list is in the order the curator saw it. */
export function inBuildOrder(rows: readonly SourceRow[]): boolean {
  return rows.every((row) => rowPosition(row) !== null);
}

export function groupSources(
  inputs: readonly Input[],
  targetNodeId: string | null,
): SourceGroups {
  const rows = new Map<string, SourceRow>();
  const internal: Input[] = [];
  for (const input of inputs) {
    if (!input.source) {
      internal.push(input);
      continue;
    }
    const key = sourceKey(input.source);
    const use = sourceUse(input.selection);
    const existing = rows.get(key);
    if (existing) {
      existing.inputs.push(input);
      if (!existing.uses.includes(use)) existing.uses.push(use);
      existing.title ??= input.label;
      existing.path ??= input.path;
      if (statusRank[inputStatus(input)] > statusRank[existing.status])
        existing.status = inputStatus(input);
      if (readRank(input) > readRank(existing.primary))
        existing.primary = input;
      existing.truncated ||= !!input.truncated && READ_USES.has(use);
      existing.fromOwner ||= input.role === 'human_correction';
      continue;
    }
    const kind = input.source.kind;
    rows.set(key, {
      key,
      kind:
        kind === 'node'
          ? 'note'
          : kind === 'memory'
            ? 'memory'
            : kind === 'curator_correction'
              ? 'correction'
              : 'other',
      title: input.label,
      path: input.path,
      source: input.source,
      uses: [use],
      inputs: [input],
      primary: input,
      status: inputStatus(input),
      truncated: !!input.truncated && READ_USES.has(use),
      fromOwner: input.role === 'human_correction',
      isTarget: kind === 'node' && input.source.native_id === targetNodeId,
    });
  }
  const groups: SourceGroups = {
    read: [],
    mentioned: [],
    memories: [],
    past: [],
    corrections: [],
    pages: [],
    internal,
  };
  for (const row of rows.values()) {
    row.uses.sort((a, b) => Number(READ_USES.has(b)) - Number(READ_USES.has(a)));
    if (row.kind === 'memory') (row.uses.includes('past') ? groups.past : groups.memories).push(row);
    else if (row.kind === 'correction') groups.corrections.push(row);
    else if (row.kind === 'other') groups.mentioned.push(row);
    else if (row.isTarget || row.inputs.every((i) => i.role === 'generated_context'))
      groups.pages.push(row);
    else if (row.uses.some((use) => READ_USES.has(use))) groups.read.push(row);
    else groups.mentioned.push(row);
  }
  groups.read.sort(byTitle);
  groups.mentioned.sort(byTitle);
  groups.corrections.sort(byTitle);
  groups.pages.sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || byTitle(a, b));
  groups.memories.sort(memoryOrder);
  groups.past.sort(memoryOrder);
  return groups;
}

export type BuildDiff = {
  newKeys: Set<string>;
  addedNotes: { key: string; title: string }[];
  removedNotes: { key: string; title: string }[];
  addedMemories: number;
  removedMemories: number;
};

/** Which sources this build used that the build it replaced did not, and vice versa. */
export function diffBuilds(
  current: readonly Input[],
  previous: readonly Input[],
): BuildDiff {
  const index = (inputs: readonly Input[]) => {
    const map = new Map<string, { kind: string; title: string }>();
    for (const input of inputs) {
      if (!input.source) continue;
      const key = sourceKey(input.source);
      const known = map.get(key);
      if (!known || (!known.title && input.label))
        map.set(key, {
          kind: input.source.kind,
          title: input.label ?? input.path ?? known?.title ?? '',
        });
    }
    return map;
  };
  const now = index(current);
  const before = index(previous);
  const diff: BuildDiff = {
    newKeys: new Set(),
    addedNotes: [],
    removedNotes: [],
    addedMemories: 0,
    removedMemories: 0,
  };
  for (const [key, entry] of now) {
    if (before.has(key)) continue;
    diff.newKeys.add(key);
    if (entry.kind === 'memory') diff.addedMemories++;
    else if (entry.kind === 'node')
      diff.addedNotes.push({ key, title: entry.title || 'Untitled note' });
  }
  for (const [key, entry] of before) {
    if (now.has(key)) continue;
    if (entry.kind === 'memory') diff.removedMemories++;
    else if (entry.kind === 'node')
      diff.removedNotes.push({ key, title: entry.title || 'Untitled note' });
  }
  const alpha = (a: { title: string }, b: { title: string }) =>
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  diff.addedNotes.sort(alpha);
  diff.removedNotes.sort(alpha);
  return diff;
}

/** "today 5:26 AM", "yesterday 9:45 AM", "Oct 28, 5:37 AM", "Dec 3, 2025, 8:00 AM". */
export function friendlyTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'an unknown time';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const midnight = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day}, ${time}`;
}

/** A memory's evidence line, e.g. "- [fact] Something true. (id: 1086)". */
export function memoryText(raw: string): { kind: string | null; text: string } {
  // A dossier's memory lines lead with the ref its model cites, "- [m812] [preference] …" (#554).
  const line = raw.trim().replace(/^-\s*\[m\d+\]\s*/, '- ');
  const match = /^-\s*\[([^\]]+)\]\s*([\s\S]*?)\s*(?:\(id:\s*\d+\))?$/.exec(line);
  if (match) return { kind: match[1]!, text: match[2]! };
  return { kind: null, text: line.replace(/^-\s*/, '') };
}

/** Lines of a shared evidence block that mention this source's title. */
export function linesMentioning(text: string, title: string | null): string[] {
  if (!title) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(title))
    .map((line) => line.replace(/^-\s*/, ''));
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
