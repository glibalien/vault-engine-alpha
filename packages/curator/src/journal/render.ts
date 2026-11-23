import type { JournalEventRow, JournalFunction } from '../db/journal.js';
import type { TopicRefreshAdmissionWarning, TopicRefreshTrigger } from '../topic-refresh-admission.js';

const FN_LABELS: Record<JournalFunction, string> = {
  'wiki-curation': 'Wiki curation',
  'topic-curation': 'Topic wikis',
  'requested-page': 'Requested pages',
  'field-guess-sweep': 'Field guessing',
  'wiki-field': 'Wiki field on project notes',
  'entity-dossier': 'Dossiers',
  'org-sweep': 'Org sweep',
  'link-sweep': 'Link sweep',
  'memory-sweep': 'Memory sweep',
  'conversation-sweep': 'Conversation sweep',
  'conversation-capture': 'Conversation capture',
  'memory-note-refresh': 'Memory note',
  reconcile: 'Reconcile',
  'staleness-nudge': 'Staleness nudge',
  'spine-migration': 'Spine migration',
  unknown: 'Other',
};

/** Wall-clock parts in the curator's configured zone — the journal is a
 *  human-facing diary, not a DB column. en-CA yields ISO-style YYYY-MM-DD. */
export function formatStamp(now: Date, tz: string): { date: string; time: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  // Intl emits '24' for midnight under some ICU versions; normalize to '00'.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date, time: `${hour}:${get('minute')}`, month: date.slice(0, 7) };
}

export function journalNoteTitle(month: string): string {
  return `Curator Journal — ${month}`;
}

/** True for a monthly journal note's title, the inverse of journalNoteTitle. The one title check
 *  every path uses as a backstop to the marker (#600). */
export function isJournalNoteTitle(title: string | null | undefined): boolean {
  return title !== null && title !== undefined && /^Curator Journal — \d{4}-(?:0[1-9]|1[0-2])$/.test(title);
}

/** The frontmatter that marks a journal note as the suite's own (#600). The memory note carries the
 *  same field (`memories`), so every path that skips it skips the journal: the Engine's semantic
 *  index, project evidence and field-guess candidates, and the Curator's own reads. */
export const SUITE_NOTE_FIELD = 'vault_engine_projection';
export const JOURNAL_MARKER = { [SUITE_NOTE_FIELD]: 'journal' } as const;

interface ParsedSummary { line: string; stats: Record<string, unknown> }

function parseSummary(detail: string): ParsedSummary {
  try {
    const p = JSON.parse(detail) as ParsedSummary;
    if (typeof p.line === 'string') {
      const stats = p.stats !== null && typeof p.stats === 'object' && !Array.isArray(p.stats)
        ? p.stats
        : {};
      return { line: p.line, stats };
    }
  } catch { /* fall through */ }
  return { line: detail, stats: {} };
}

/**
 * The deterministic core of an entry: events grouped by function in
 * first-appearance order, each group's summary lines first, then its action
 * lines, all as bullets under a bold group label.
 */
export function renderBody(events: JournalEventRow[]): { body: string; actionLines: string[]; anyErrors: boolean } {
  const groups = new Map<JournalFunction, { summaries: string[]; actions: string[] }>();
  let anyErrors = false;
  const actionLines: string[] = [];
  for (const e of events) {
    let g = groups.get(e.function);
    if (!g) { g = { summaries: [], actions: [] }; groups.set(e.function, g); }
    if (e.kind === 'summary') {
      const { line, stats } = parseSummary(e.detail);
      g.summaries.push(e.function === 'topic-curation' ? topicRefreshSummaryLine(line, stats) : line);
      if (typeof stats['errors'] === 'number' && stats['errors'] > 0) anyErrors = true;
    } else {
      g.actions.push(e.detail);
      actionLines.push(e.detail);
    }
  }
  const blocks: string[] = [];
  for (const [fn, g] of groups) {
    blocks.push(`**${FN_LABELS[fn]}**`);
    for (const s of g.summaries) blocks.push(`- ${s}`);
    for (const a of g.actions) blocks.push(`- ${a}`);
  }
  return { body: blocks.join('\n'), actionLines, anyErrors };
}

function topicRefreshSummaryLine(line: string, stats: Record<string, unknown>): string {
  const trigger = closedTrigger(stats['refresh_trigger']);
  const rawWarnings = Array.isArray(stats['refresh_warnings']) ? stats['refresh_warnings'] : [];
  const warnings = rawWarnings
    .map(closedWarning)
    .filter((warning): warning is TopicRefreshAdmissionWarning => warning !== null)
    .slice(0, 8);
  if (trigger === null && warnings.length === 0) return line;
  return `${line}${trigger === null ? '' : `; refresh trigger: ${trigger}`}${warnings.length === 0 ? '' : `; refresh warnings: ${warnings.join(', ')}`}`;
}

function closedTrigger(value: unknown): TopicRefreshTrigger | null {
  switch (value) {
    case 'manual_request': case 'manual_force': case 'cadence_due':
    case 'baseline_retry': case 'vault_source_changed': case 'web_material_change': case 'not_due':
      return value;
    default: return null;
  }
}

function closedWarning(value: unknown): TopicRefreshAdmissionWarning | null {
  switch (value) {
    case 'source_baseline_not_ready': case 'source_read_unavailable':
    case 'web_baseline_not_ready': case 'web_probe_unavailable':
    case 'web_probe_overflow': case 'assessment_cap_exhausted':
    case 'assessment_failed': case 'refresh_state_persist_failed':
      return value;
    default: return null;
  }
}

/** The no-LLM lede: used for small clean entries and as the fallback whenever
 *  the lede model call fails. */
export function deterministicLede(actionLines: string[], anyErrors: boolean): string {
  if (actionLines.length === 0) {
    return anyErrors
      ? 'Ran into trouble this run — details below.'
      : 'A quiet run — checks came back with nothing needing changes.';
  }
  const summary = `Quick update: ${actionLines.join('; ')}.`;
  return anyErrors ? `${summary} Some steps hit errors — details below.` : summary;
}

export function renderEntry(label: string, stamp: { date: string; time: string }, lede: string, body: string): string {
  return `## ${stamp.date} ${stamp.time} — ${label}\n\n${lede}${body ? `\n\n${body}` : ''}`;
}
