import type { EvidenceCollector } from './provenance-evidence.js';
import type { ProjectDigest, EngineNode, ProjectRef, ProjectEvidence, GapFillCandidate, Memory, EvidenceContact, UnlinkedContact } from './types.js';
import { partitionSubpages } from './spine.js';
import { pageNarrativeContext } from './page-markdown.js';
import { memoryRole, renderConflicts, renderWikiMemories, type MemoryConflict } from './wiki-memories.js';
import { vaultOf } from './config.js';
import { localDate } from './date-line.js';

export function truncate(text: string, cap: number | null): string {
  if (cap === null || text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
}

export const GAP_FILL_HEADING = 'RELATED (UNLINKED) CANDIDATES — low confidence';

/** A wiki body without its Log and live sections; the raw body when its markers need repair. */
function wikiNarrativeBody(body: string): string {
  try {
    return pageNarrativeContext(body);
  } catch {
    return body;
  }
}

function candidateBlock(candidates: GapFillCandidate[]): string[] {
  if (candidates.length === 0) return [];
  const lines = [
    '',
    `## ${GAP_FILL_HEADING}`,
    'These nodes are NOT linked to the project. They surfaced via semantic similarity',
    'and may be false positives. Promote one only with a clear, defensible connection.',
    '',
  ];
  for (const c of candidates) {
    const types = c.types.join(', ') || '(none)';
    const status = c.status ?? '(none)';
    const matched = c.match_sources && c.match_sources.length > 0 ? ` [matched: ${c.match_sources.join('+')}]` : '';
    lines.push(`- ${c.title} (types: ${types}; status: ${status})${matched}`);
    const body = c.body?.trim();
    if (body) lines.push(`  ${body.replace(/\n/g, '\n  ')}`);
  }
  return lines;
}

export function fieldValue(raw: unknown): unknown {
  // get-node returns fields as { value, type, source }; tolerate bare values too.
  if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

export function taskLines(label: string, tasks: Array<{ title: string; status: string | null; due: string | null }> | undefined, cap = 12): string[] {
  if (!tasks || tasks.length === 0) return [];
  const shown = tasks.slice(0, cap).map(t => {
    const meta = [t.due ? `due ${t.due}` : null, t.status].filter(Boolean).join(' · ');
    return `  - ${t.title}${meta ? ` (${meta})` : ''}`;
  });
  const more = tasks.length > cap ? [`  - …and ${tasks.length - cap} more`] : [];
  return [`${label} (${tasks.length}):`, ...shown, ...more];
}

const TASK_BUCKET_ORDER: Array<[string, string]> = [
  ['overdue', 'Overdue'], ['blocked', 'Blocked'], ['open', 'Open'],
  ['upcoming', 'Upcoming'], ['backlog', 'Backlog'], ['done_recent', 'Recently done'],
];

/** Render every non-empty task bucket in canonical priority order; the fallback
 *  line keeps "no tasks" explicit for the model rather than silently absent. */
function renderTaskBuckets(tasks: ProjectDigest['tasks'] | undefined): string[] {
  const lines: string[] = [];
  for (const [key, label] of TASK_BUCKET_ORDER) {
    const ls = taskLines(label, tasks?.[key]);
    if (ls.length > 0) lines.push(...ls);
  }
  return lines.length > 0 ? lines : ['(no associated tasks)'];
}

/**
 * Build the gap-fill retrieval query from a project's CURRENT concerns: its title,
 * the top 3 open-ish task titles (overdue → blocked → open priority), and the top 3
 * recent note titles. Biases semantic retrieval toward what the project is about now.
 */
export function gapFillQueryText(project: ProjectRef, evidence: ProjectEvidence): string {
  const taskTitles: string[] = [];
  for (const bucket of ['overdue', 'blocked', 'open'] as const) {
    for (const t of evidence.tasks?.[bucket] ?? []) {
      if (taskTitles.length >= 3) break;
      if (t.title) taskTitles.push(t.title);
    }
    if (taskTitles.length >= 3) break;
  }
  const noteTitles = (evidence.notes ?? []).slice(0, 3).map(n => n.title).filter(Boolean);
  return [project.title, ...taskTitles, ...noteTitles].join('\n');
}

/**
 * Every node id already represented in the structured evidence — used to dedup
 * gap-fill candidates so we never surface a node the project is already linked to.
 */
export function collectEvidenceIds(evidence: ProjectEvidence, project: ProjectRef): Set<string> {
  const ids = new Set<string>();
  if (project.id !== null) ids.add(project.id);
  ids.add(evidence.project.id);
  for (const bucket of Object.values(evidence.tasks ?? {})) {
    for (const t of bucket ?? []) ids.add(t.id);
  }
  for (const n of evidence.notes ?? []) ids.add(n.id);
  for (const p of evidence.contacts?.people ?? []) ids.add(p.id);
  for (const m of evidence.meetings?.recent ?? []) ids.add(m.id);
  for (const m of evidence.meetings?.upcoming ?? []) ids.add(m.id);
  for (const r of evidence.synthesis_hints?.suggested_reads ?? []) ids.add(r.id);
  if (evidence.existing_wiki?.home_id) ids.add(evidence.existing_wiki.home_id);
  for (const s of evidence.existing_wiki?.subpages ?? []) ids.add(s.id);
  return ids;
}

/** People and companies shown in one wiki prompt; a project rarely has more worth naming. */
const PEOPLE_LIMIT = 25;

/** What the people blocks read from a project's contacts. A project's evidence carries more. */
export type PeopleBlockContacts = {
  readonly people: ReadonlyArray<Pick<EvidenceContact, 'id' | 'title' | 'companies' | 'direct' | 'meeting_count'>>;
  readonly companies: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Absent on Engines before #474's people block. */
  readonly unlinked?: readonly UnlinkedContact[];
};

/**
 * Only what the people blocks show, for a requested page's durable request to save (#631): the
 * people, companies and people without a note they list, with the fields their lines read. The
 * blocks render it exactly as they render the full contacts.
 */
export function peopleBlockContacts(contacts: PeopleBlockContacts | undefined): PeopleBlockContacts | undefined {
  if (!contacts) return undefined;
  const count = (value: unknown): number => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0;
  return {
    people: (contacts.people ?? []).slice(0, PEOPLE_LIMIT).map(person => ({ id: person.id, title: person.title,
      companies: Array.isArray(person.companies) ? [...person.companies] : [], direct: person.direct === true,
      meeting_count: count(person.meeting_count) })),
    companies: (contacts.companies ?? []).slice(0, PEOPLE_LIMIT).map(company => ({ id: company.id, title: company.title })),
    ...(contacts.unlinked ? { unlinked: contacts.unlinked.slice(0, PEOPLE_LIMIT).map(person => ({ name: person.name,
      direct: person.direct === true, meeting_count: count(person.meeting_count) })) } : {}),
  };
}

/** How a person relates to the project: their company, whether the project lists them, the
 *  project meetings they attended. Empty when nothing is known. */
function involvement(parts: ReadonlyArray<string | null>): string {
  const known = parts.filter((part): part is string => part !== null && part !== '');
  return known.length > 0 ? ` (${known.join('; ')})` : '';
}

function meetings(count: number): string | null {
  return count > 0 ? `${count} project meeting${count === 1 ? '' : 's'}` : null;
}

/**
 * The project's people and companies, each of which has a note under that exact title (#474 idea 4).
 * Before, a writer saw people only inside note bodies and memories, so it linked people who have
 * no note and wrote "the vendor" for a company it could have named. Each person shows how they
 * relate to the project: their company, "project contact" when the project lists them, and the
 * project meetings they attended.
 */
export function renderPeople(contacts: PeopleBlockContacts | undefined): { lines: string[]; ids: string[] } {
  const people = (contacts?.people ?? []).slice(0, PEOPLE_LIMIT);
  const companies = (contacts?.companies ?? []).slice(0, PEOPLE_LIMIT);
  if (people.length === 0 && companies.length === 0) return { lines: [], ids: [] };
  return {
    lines: ['## PEOPLE AND COMPANIES ON THIS PROJECT (each has a note under this exact title; link them by it. In brackets: their company, "project contact" when the project lists them, and the project meetings they attended)',
      ...people.map(person => `- ${person.title}${involvement([person.companies.join(', '),
        person.direct ? 'project contact' : null, meetings(person.meeting_count)])}`),
      ...companies.map(company => `- ${company.title} (company)`)],
    ids: [...people.map(person => person.id), ...companies.map(company => company.id)],
  };
}

/**
 * People the project or its meetings name who have no note (#474 idea 4). A writer that links
 * them makes a link to nothing, so they are listed to be written as plain text.
 */
export function renderUnlinkedPeople(contacts: PeopleBlockContacts | undefined): string[] {
  const unlinked = (contacts?.unlinked ?? []).slice(0, PEOPLE_LIMIT);
  if (unlinked.length === 0) return [];
  return ['## PEOPLE NAMED WITHOUT A NOTE (the project or its meetings name them, but no note exists: write each name as plain text, never as a link)',
    ...unlinked.map(person => `- ${person.name}${involvement([person.direct ? 'project contact' : null, meetings(person.meeting_count)])}`)];
}

/** Both people blocks, as a page's evidence shows them (#474 idea 4). */
export function peopleBlocks(contacts: PeopleBlockContacts | undefined): string[] {
  const known = renderPeople(contacts).lines;
  const unlinked = renderUnlinkedPeople(contacts);
  return known.length > 0 && unlinked.length > 0 ? [...known, '', ...unlinked] : [...known, ...unlinked];
}

// buildEvidence accepts a plain digest or the richer evidence superset; the
// engine projection fields are optional so a bare ProjectDigest still type-checks.
type HomeEvidenceInput = ProjectDigest & Partial<Pick<ProjectEvidence, 'signals_detail' | 'changed_since_curation' | 'closed_since'>>;

/** "What changed since last curation" delta — raw material for a spotlight page. Each node's
 *  modified date is its day in `timeZone`, like the date line the model reads it against (#459). */
function changedBlock(changed: ProjectEvidence['changed_since_curation'], timeZone?: string): string[] {
  if (!changed || Object.keys(changed.buckets).length === 0) return [];
  const lines = [
    '## CHANGED SINCE LAST CURATION',
    `Nodes modified since the last curation (${changed.since}). Raw material for a "spotlight" page.`,
  ];
  for (const [type, nodes] of Object.entries(changed.buckets)) {
    lines.push(`${type} (${nodes.length}):`);
    for (const n of nodes.slice(0, 12)) lines.push(`  - ${n.title} (modified ${modifiedDay(n.modified, timeZone)})`);
  }
  lines.push('');
  return lines;
}

function modifiedDay(modified: string, timeZone: string | undefined): string {
  const ms = Date.parse(modified);
  return Number.isFinite(ms) ? localDate(ms, timeZone) : modified.slice(0, 10);
}

/** Tasks completed since the last curation — acknowledge resolution, do not surface as open. */
export function closedSinceBlock(closed: ProjectEvidence['closed_since']): string[] {
  if (!closed || closed.length === 0) return [];
  const lines = ['## CLOSED SINCE LAST CURATION', '_These are done now — acknowledge the resolution; do NOT surface them as open._'];
  for (const c of closed) {
    lines.push(`- ${c.title}${c.due ? ` (was due ${c.due})` : ''}`);
  }
  lines.push('');
  return lines;
}

/** Blocked + overdue tasks — ground a risk-register page in these. */
function riskBlock(detail: ProjectEvidence['signals_detail']): string[] {
  if (!detail || detail.risk_proxies.length === 0) return [];
  const lines = ['## RISK PROXIES', 'Blocked + overdue tasks — ground a "risk-register" page in these.'];
  for (const r of detail.risk_proxies.slice(0, 20)) {
    const meta = [r.bucket, r.due ? `due ${r.due}` : null, r.priority ? `priority ${r.priority}` : null]
      .filter(Boolean).join(' · ');
    lines.push(`  - ${r.title}${meta ? ` (${meta})` : ''}`);
  }
  lines.push('');
  return lines;
}

/** Due-dated tasks + dated meetings, chronological — ground a timeline page. */
function timelineBlock(detail: ProjectEvidence['signals_detail']): string[] {
  if (!detail || detail.timeline.length === 0) return [];
  const lines = ['## TIMELINE', 'Due-dated tasks + dated meetings, chronological — ground a "timeline" page in these.'];
  for (const t of detail.timeline.slice(0, 30)) lines.push(`  - ${t.date} — ${t.title} (${t.type})`);
  lines.push('');
  return lines;
}

/** Deterministic importance ranking — which threads earn their own page. */
function salienceBlock(hints: ProjectEvidence['synthesis_hints']): string[] {
  const salience = hints?.salience;
  if (!salience || salience.length === 0) return [];
  const lines = [
    '## SALIENCE',
    'Nodes ranked by recency × link-degree × urgency. Use to decide which threads earn their own page.',
  ];
  for (const s of salience.slice(0, 15)) lines.push(`  - ${s.title} (score ${s.score.toFixed(2)})`);
  lines.push('');
  return lines;
}

/** Source selection is shared with the formatter so metadata follows rendered caps. */
function homeProjections(digest: HomeEvidenceInput, timeZone?: string): Array<{ lines: string[]; ids: string[]; selection: string }> {
  return [
    { lines: changedBlock(digest.changed_since_curation, timeZone), ids: Object.values(digest.changed_since_curation?.buckets ?? {}).flatMap(nodes => nodes.slice(0, 12).map(node => node.id)), selection: 'changed-projection:v1' },
    { lines: closedSinceBlock(digest.closed_since), ids: (digest.closed_since ?? []).map(node => node.id), selection: 'closed-projection:v1' },
    { lines: riskBlock(digest.signals_detail), ids: (digest.signals_detail?.risk_proxies ?? []).slice(0, 20).map(node => node.id), selection: 'risk-projection:v1' },
    { lines: timelineBlock(digest.signals_detail), ids: (digest.signals_detail?.timeline ?? []).slice(0, 30).map(node => node.id), selection: 'timeline-projection:v1' },
    { lines: salienceBlock(digest.synthesis_hints), ids: ((digest as ProjectEvidence).synthesis_hints.salience ?? []).slice(0, 15).map(node => node.id), selection: 'salience-projection:v1' },
  ];
}

export function homeEvidenceNodeIds(digest: HomeEvidenceInput): string[] {
  const { spine, themed } = partitionSubpages(digest.project.title, digest.existing_wiki.subpages);
  return [...new Set([
    digest.project.id, ...spine.map(page => page.id), ...themed.map(page => page.id),
    ...TASK_BUCKET_ORDER.flatMap(([key]) => (digest.tasks?.[key] ?? []).slice(0, 12).map(task => task.id)),
    ...homeProjections(digest).flatMap(projection => projection.ids),
    // The people block attributes each contact, so their observations are read too (#474 idea 4).
    ...renderPeople((digest as Partial<ProjectEvidence>).contacts).ids,
  ])];
}

/**
 * Compact a project's deterministic digest plus the bodies of its highest-signal
 * nodes into a single bounded evidence block for the synthesis prompt. Pure —
 * no I/O — so it is unit-tested.
 */
export function buildEvidence(
  project: ProjectRef,
  digest: HomeEvidenceInput,
  readNodes: Array<EngineNode & { reason?: string }>,
  bodyCharCap: number | null,
  candidates: GapFillCandidate[] = [],
  _pinnedTitles: ReadonlySet<string> = new Set(),
  corrections: readonly string[] = [],
  memories: readonly Memory[] = [],
  provenance?: EvidenceCollector,
  /** The vault map's wiki page kind: a read or candidate of it is generated context. Null = none. */
  wikiType: string | null = vaultOf({}).wikiType,
  /** The zone the printed dates are in (`Config.curatorTz`); the host's when absent (#459). */
  timeZone?: string,
  /** Memory pairs nothing has settled (#474 idea 4). */
  conflicts: readonly MemoryConflict[] = [],
): string {
  const isWikiKind = (types: readonly string[]): boolean => wikiType !== null && types.includes(wikiType);
  const lines: string[] = [];
  lines.push(`# Project: ${project.title}`);
  lines.push(`Status: ${project.status ?? '(none)'}`);
  lines.push(`Existing wiki: ${digest.existing_wiki.home_id ? 'yes — this is an update' : 'none — first build'}`);
  // Retired-spine pages (Task Board / Meetings / Contacts / Notes) are mid-migration — don't show them to
  // the model as if they were part of the current wiki.
  const { spine, themed } = partitionSubpages(project.title, digest.existing_wiki.subpages);
  const currentSubpages = [...spine, ...themed];
  if (currentSubpages.length > 0) {
    lines.push(`Existing sub-pages: ${currentSubpages.map(s => s.title).join(', ')}`);
  }
  lines.push('');
  provenance?.catalog(lines, 0, [digest.project.id], 'engine_projection', 'project-fields:v1');
  provenance?.catalog(lines, 0, currentSubpages.map(page => page.id), 'generated_context', 'subpage-title-context:v1');

  // Caller corrections — authoritative steering, rendered high so the model honors them.
  if (corrections.length > 0) {
    lines.push('## CALLER CORRECTIONS (authoritative steering from the owner — apply over your own inference)');
    for (const [index, note] of corrections.entries()) {
      const start = lines.length; lines.push(`- ${note}`);
      provenance?.record(lines, start, provenance.corrections[index]?.observation, 'human_correction', 'correction:v1');
    }
    lines.push('');
  }

  const memoryStart = lines.length;
  const renderedMemories = renderWikiMemories(memories, 'project');
  lines.push(...renderedMemories.lines);
  for (const entry of renderedMemories.entries) {
    const at = memoryStart + entry.lineIndex;
    provenance?.record(lines.slice(0, at + 1), at, entry.memory.provenance_observation, memoryRole(entry.memory),
      'memory:v2', entry.truncated, entry.truncated ? entry.originalBytes : null);
  }
  const conflictLines = renderConflicts(conflicts);
  if (conflictLines.length > 0) {
    const conflictStart = lines.length;
    lines.push(...conflictLines, '');
    provenance?.record(lines, conflictStart, null, 'generated_context', 'memory-conflicts:v1');
  }
  const people = renderPeople((digest as Partial<ProjectEvidence>).contacts);
  if (people.lines.length > 0) {
    const peopleStart = lines.length;
    lines.push(...people.lines, '');
    provenance?.catalog(lines, peopleStart, people.ids, 'engine_projection', 'people-projection:v1');
    provenance?.record(lines, peopleStart, null, 'engine_projection', 'opaque-people-projection:v1');
  }
  const unlinked = renderUnlinkedPeople((digest as Partial<ProjectEvidence>).contacts);
  if (unlinked.length > 0) {
    const unlinkedStart = lines.length;
    lines.push(...unlinked, '');
    provenance?.record(lines, unlinkedStart, null, 'engine_projection', 'unlinked-people-projection:v1');
  }
  const signalStart = lines.length;

  lines.push('## Signals');
  lines.push(`- overdue tasks: ${digest.signals.overdue_count}`);
  lines.push(`- blocked tasks: ${digest.signals.blocked_count}`);
  lines.push(`- churn (nodes touched in last ${digest.windows?.recent_days ?? 7}d): ${digest.signals.churn_rate}`);
  lines.push('');

  provenance?.record(lines, signalStart, null, 'engine_projection', 'aggregate-signals:v1');
  lines.push('## Tasks');
  const taskStart = lines.length;
  lines.push(...renderTaskBuckets(digest.tasks));
  let taskOffset = taskStart;
  for (const [key] of TASK_BUCKET_ORDER) {
    const tasks = digest.tasks?.[key] ?? [];
    if (tasks.length === 0) continue;
    if (tasks.length > 12) provenance?.omissions.push({ code: 'task_bucket_count_cap', source: null });
    for (const [index, task] of tasks.slice(0, 12).entries()) {
      provenance?.catalog(lines.slice(0, taskOffset + index + 2), taskOffset + index + 1, [task.id], 'engine_projection', 'task-fields:v1');
    }
    taskOffset += 1 + Math.min(tasks.length, 12) + (tasks.length > 12 ? 1 : 0);
  }
  lines.push('');

  // Grounded engine projections (present only on the new engine). These sit high
  // so the model anchors risk/timeline/spotlight archetypes + page selection in them.
  for (const projection of homeProjections(digest, timeZone)) {
    const start = lines.length; lines.push(...projection.lines);
    provenance?.catalog(lines, start, projection.ids, 'engine_projection', projection.selection);
    if (projection.lines.length > 0) provenance?.record(lines, start, null, 'engine_projection', 'opaque-' + projection.selection);
  }

  lines.push('## Evidence reads');
  if (readNodes.length === 0) {
    lines.push('(no high-signal nodes resolved)');
  } else {
    for (const node of readNodes) {
      const nodeStart = lines.length;
      lines.push(`### ${node.title}`);
      if (node.reason) lines.push(`_why surfaced: ${node.reason}_`);
      lines.push(`types: ${node.types.join(', ') || '(none)'}`);
      if (Object.keys(node.fields ?? {}).length > 12) provenance?.omissions.push({ code: 'node_field_count_cap', source: node.provenance_observation?.source ?? null });
      const fields = Object.entries(node.fields ?? {})
        .map(([k, v]) => `${k}=${JSON.stringify(fieldValue(v))}`)
        .slice(0, 12);
      if (fields.length > 0) lines.push(`fields: ${fields.join('; ')}`);
      const rawBody = (node.body ?? '').trim();
      const isWiki = node.id === digest.existing_wiki.home_id || isWikiKind(node.types);
      // A wiki's Log only grows and its live sections repeat the task buckets above.
      const body = isWiki ? wikiNarrativeBody(rawBody) : rawBody;
      lines.push('');
      lines.push(body ? truncate(body, bodyCharCap) : '(empty body)');
      lines.push('');
      const isTruncated = body !== rawBody || (bodyCharCap !== null && body.length > bodyCharCap);
      provenance?.record(lines, nodeStart, node.provenance_observation,
        isWiki ? 'generated_context' : 'source_material',
        body !== rawBody ? 'wiki-narrative-context:v1' : 'formatted-node-body-prefix:v1', isTruncated,
        Buffer.byteLength(lines.slice(nodeStart).join('\n')) - Buffer.byteLength(body ? truncate(body, bodyCharCap) : '(empty body)') + Buffer.byteLength(rawBody || '(empty body)'));
    }
  }

  const candidateStart = lines.length;
  lines.push(...candidateBlock(candidates));
  let candidateOffset = candidateStart + 5;
  for (const candidate of candidates) {
    const count = candidate.body?.trim() ? 2 : 1;
    provenance?.record(lines.slice(0, candidateOffset + count), candidateOffset, candidate.provenance_observation,
      isWikiKind(candidate.types) ? 'generated_context' : 'source_material', 'gap-fill-candidate:v1', candidate.provenance_truncated ?? false, candidate.provenance_original_bytes ?? null);
    candidateOffset += count;
  }
  const text = lines.join('\n').trim();
  provenance?.finish(lines, text);
  return text;
}

/**
 * Evidence block for fulfilling one caller-requested sub-page: project context,
 * the request itself, the task surface, recent note titles, then vault material
 * retrieved by semantic search on the request (title + brief), with bodies for
 * the top hits. Pure — unit-tested.
 */
export function requestedPageEvidenceNodeIds(evidence: ProjectEvidence): string[] {
  return [...new Set([evidence.project.id,
    // The people block attributes each contact, as a full build's does (#631).
    ...renderPeople(evidence.contacts).ids,
    ...TASK_BUCKET_ORDER.flatMap(([key]) => (evidence.tasks?.[key] ?? []).slice(0, 12).map(task => task.id)),
    ...evidence.notes.slice(0, 15).map(note => note.id),
  ])];
}

export function requestedPageEvidence(
  evidence: ProjectEvidence,
  pageTitle: string,
  brief: string | undefined,
  related: GapFillCandidate[],
  bodyCharCap: number | null,
  collector?: EvidenceCollector,
  memories: readonly Memory[] = [],
  memorySubject: 'project' | 'topic' = 'project',
  /** Memory pairs nothing has settled, as a full build shows them (#631). */
  conflicts: readonly MemoryConflict[] = [],
  /** The project's people, with and without notes, as a full build shows them (#631). */
  contacts?: PeopleBlockContacts,
): string {
  const lines: string[] = [];
  lines.push(`# Project: ${evidence.project.title}`);
  lines.push(`Status: ${evidence.project.status ?? '(none)'}`);
  collector?.record(lines, 0, collector.observations[evidence.project.id], 'engine_projection', 'requested-project:v1');
  lines.push('');
  const requestStart = lines.length;
  lines.push('## THE REQUEST');
  lines.push(`Page: ${pageTitle}`);
  if (brief) lines.push(`Brief: ${brief}`);
  collector?.record(lines, requestStart, null, 'generated_context', 'requested-instruction:v1');
  lines.push('');

  // The same memory blocks a full build shows (#313), each line attributed to its memory.
  const memoryStart = lines.length;
  const renderedMemories = renderWikiMemories(memories, memorySubject);
  lines.push(...renderedMemories.lines);
  for (const entry of renderedMemories.entries) {
    const at = memoryStart + entry.lineIndex;
    collector?.record(lines.slice(0, at + 1), at, entry.memory.provenance_observation, memoryRole(entry.memory),
      'memory:v2', entry.truncated, entry.truncated ? entry.originalBytes : null);
  }
  const conflictLines = renderConflicts(conflicts);
  if (conflictLines.length > 0) {
    const conflictStart = lines.length;
    lines.push(...conflictLines, '');
    collector?.record(lines, conflictStart, null, 'generated_context', 'memory-conflicts:v1');
  }
  // Recorded as a full build's home evidence records them.
  const people = renderPeople(contacts);
  if (people.lines.length > 0) {
    const peopleStart = lines.length;
    lines.push(...people.lines, '');
    collector?.catalog(lines, peopleStart, people.ids, 'engine_projection', 'people-projection:v1');
    collector?.record(lines, peopleStart, null, 'engine_projection', 'opaque-people-projection:v1');
  }
  const unlinked = renderUnlinkedPeople(contacts);
  if (unlinked.length > 0) {
    const unlinkedStart = lines.length;
    lines.push(...unlinked, '');
    collector?.record(lines, unlinkedStart, null, 'engine_projection', 'unlinked-people-projection:v1');
  }

  lines.push('## Tasks');
  for (const [key, label] of TASK_BUCKET_ORDER) {
    const tasks = evidence.tasks?.[key] ?? [];
    const rendered = taskLines(label, tasks);
    for (const [index, line] of rendered.entries()) {
      const start = lines.length;
      lines.push(line);
      const task = index > 0 && index <= 12 ? tasks[index - 1] : undefined;
      // Bucket counts and overflow rows describe the collection, not any one task.
      collector?.record(lines, start, task ? collector.observations[task.id] : null,
        'engine_projection', `requested-tasks:${key}:${task ? 'row' : 'aggregate'}:v2`);
    }
  }
  if (!Object.values(evidence.tasks ?? {}).some(bucket => bucket?.length)) lines.push('(no associated tasks)');
  lines.push('');

  if (evidence.notes.length > 0) {
    lines.push('## Notes (recent first)');
    for (const n of evidence.notes.slice(0, 15)) {
      const start = lines.length;
      lines.push(`- ${n.title}`);
      collector?.record(lines, start, collector.observations[n.id], 'engine_projection', 'requested-note:v1');
    }
    lines.push('');
  }

  lines.push('## RELATED MATERIAL (semantic search on the request)');
  if (related.length === 0) {
    lines.push('(nothing related found — evidence is thin; say so plainly on the page)');
  } else {
    for (const c of related) {
      const start = lines.length;
      lines.push(`### ${c.title}`);
      lines.push(`types: ${c.types.join(', ') || '(none)'}; status: ${c.status ?? '(none)'}`);
      const body = c.body?.trim();
      lines.push('');
      lines.push(body ? truncate(body, bodyCharCap) : '(body not read)');
      collector?.record(lines, start, c.provenance_observation, 'source_material', 'requested-related:v1', c.provenance_truncated ?? false);
      lines.push('');
    }
  }
  const text = lines.join('\n').trim();
  collector?.finish(lines, text);
  return text;
}
