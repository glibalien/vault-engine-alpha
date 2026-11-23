import { entityKinds } from '@vault/settings-registry';
import { PAST_FACT_REASONS, isPastFact, pastFactEnd, pastFactStart } from './past.js';
import type { CoreDeps } from '../core.js';
import { vaultOf } from '../config.js';
import { localDate } from '../date-line.js';
import { wikiRootFor } from '../db/wiki-roots.js';
import { EngineError } from '../engine.js';
import { fieldValue, truncate } from '../evidence.js';
import { ownerName } from '../memory-extract.js';
import { EvidenceCollector } from '../provenance-evidence.js';
import { completeHomeEvidenceObservations } from '../provenance-evidence-read.js';
import { renderPageRules } from '../page-rules.js';
import { MEMORY_CHAR_CAP, OWNER_MEMORY_LIMIT, RULE_CATEGORY, memoryDay, memoryRole, withSourceLabels } from '../wiki-memories.js';
import type { DossierKind } from '../prompts/dossier.js';
import type { EngineNode, EvidenceMeeting, ExistingWiki, Memory, ProjectEvidence } from '../types.js';

/**
 * What a dossier reads (#554): the person's or company's own note, the memories about it
 * (`list-memories subject_of`), and what `project-evidence` gives for any note: the meetings and
 * notes that link to it, its tasks and the people and companies around it. Every memory and note
 * line is recorded with its observation, so the page's capture lists its inputs.
 */

export const DOSSIER_LIMITS = {
  /** Memories about the subject, by category first, then the newest of the rest. */
  rules: 20,
  preferences: 20,
  newest: 60,
  /** The owner's own standing memories, as every wiki build reads them. */
  owner: OWNER_MEMORY_LIMIT,
  notes: 30,
  upcomingMeetings: 8,
  tasksPerBucket: 12,
  people: 25,
  /** The subject's own note body, in characters. */
  bodyChars: 12_000,
  /** The newest meetings and notes that link to the subject read in full (#720; owner, 2026-11-21). */
  readBodies: 8,
  /** Each of those bodies, in characters. */
  readBodyChars: 4_000,
  /** Past facts about the subject, newest first, for History (#717; owner, 2026-11-21: "10 newest"). */
  past: 10,
} as const;

export type DossierErrorCode = 'NOT_FOUND' | 'AMBIGUOUS_TITLE' | 'INVALID_PARAMS' | 'WIKI_PAGE' | 'PROJECT_NOTE'
  | 'NOT_AN_ENTITY' | 'VAULT_OWNER' | 'HAS_WIKI' | 'UPGRADE_REQUIRED' | 'CAPTURE_UNAVAILABLE' | 'CAPTURE_REFUSED'
  | 'MODEL_UNAVAILABLE' | 'EVIDENCE_TOO_LARGE' | 'DAILY_BUDGET' | 'MODEL_OUTPUT_INVALID' | 'NOTHING_CITED' | 'NOT_A_DOSSIER' | 'IN_PROGRESS';

/** A refusal or failure the tool reports as it is: the message is for the caller. */
export class DossierError extends Error {
  override readonly name = 'DossierError';
  constructor(readonly code: DossierErrorCode, message: string) { super(message); }
}

export interface DossierTarget { readonly node_id?: string | undefined; readonly title?: string | undefined }

export interface DossierSubject {
  readonly id: string;
  readonly title: string;
  readonly kind: DossierKind;
  readonly types: readonly string[];
  readonly node: EngineNode;
}

/** A note the model can cite, by its short ref ("n3"). */
export interface DossierRef {
  readonly ref: string;
  readonly id: string;
  readonly title: string;
  /** A meeting's day; null for anything else. */
  readonly date: string | null;
  readonly what: 'subject' | 'meeting' | 'note' | 'task';
  /** Text shown in full (the subject's own note, a body read in full): a day the model gives must
   *  be in the entry the line came from, or in the title. With none, only the title can hold it. */
  readonly text?: string;
}

export interface DossierMemories {
  /** The owner's standing memories that are not about the subject. */
  readonly owner: readonly Memory[];
  /** Rules about the subject: listed on the page by code. */
  readonly rules: readonly Memory[];
  /** The other memories about the subject, newest first. */
  readonly facts: readonly Memory[];
  /** Memories about the subject that a newer one contradicted (#717), newest first: History only,
   *  each with its end day in `invalid_at`. */
  readonly past: readonly Memory[];
  /** What replaced each past fact, by the past fact's id: the model judges change from correction by it. */
  readonly replacedBy: ReadonlyMap<number, Memory>;
  /** Live memories about the subject in all; null when the Engine gave no total. */
  readonly total: number | null;
  /** Memories about the subject the limits left out. */
  readonly omitted: number;
}

export interface DossierEvidence {
  readonly subject: DossierSubject;
  readonly evidence: ProjectEvidence & { readonly existing_wiki: ExistingWiki };
  readonly memories: DossierMemories;
  /** Every memory the build shows, by id: what a line may cite. */
  readonly memoryById: ReadonlyMap<number, Memory>;
  readonly refs: ReadonlyMap<string, DossierRef>;
  /** Note titles by id, for the source link of a memory's line. */
  readonly sourceTitles: ReadonlyMap<string, string>;
  /** The newest past meeting they attended (a company: someone from it): the page's "Last contact". */
  readonly lastContact: { readonly title: string; readonly date: string } | null;
  /** With no last contact found and more linked meetings than were read: how many were read. */
  readonly contactSearched: number | null;
  readonly counts: { readonly notes: number; readonly meetings: number; readonly tasks: number; readonly people: number; readonly companies: number;
    /** Meetings and notes read in full. */
    readonly bodies: number };
  readonly text: string;
  readonly collector: EvidenceCollector;
}

function sameName(a: string, b: string): boolean {
  return a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase();
}

/**
 * The note a dossier is for, or a refusal. Projects have project wikis, wiki pages are output, and
 * only the vault map's entity kinds (`entityTypes`, else the person, company and project kinds)
 * are subjects of memories. The vault owner is never a subject, so has no dossier.
 */
export async function resolveDossierSubject(deps: Pick<CoreDeps, 'engine' | 'config'>, target: DossierTarget): Promise<DossierSubject> {
  const given = [target.node_id, target.title].filter(value => value !== undefined && value.trim() !== '');
  if (given.length !== 1) throw new DossierError('INVALID_PARAMS', 'Give the note as node_id or as title: one of the two.');
  let id = target.node_id?.trim();
  if (id === undefined) {
    const title = target.title!.trim();
    const found = await deps.engine.findNodesByExactTitle(title, 2);
    if (found.length === 0) throw new DossierError('NOT_FOUND', `No note is titled "${title}".`);
    if (found.length > 1) throw new DossierError('AMBIGUOUS_TITLE', `More than one note is titled "${title}"; give its node_id.`);
    id = found[0]!.id;
  }
  let node: EngineNode;
  try {
    node = await deps.engine.getNode(id, { includeProvenance: true, includeEmbeds: false });
  } catch (error) {
    if (error instanceof EngineError && error.code === 'NOT_FOUND') throw new DossierError('NOT_FOUND', `No note has the id ${id}.`);
    throw error;
  }
  const vault = vaultOf(deps.config);
  const types = node.types ?? [];
  const title = node.title ?? id;
  if (vault.wikiType !== null && types.includes(vault.wikiType)) {
    throw new DossierError('WIKI_PAGE', `"${title}" is a wiki page. A dossier is built for a person's or a company's own note.`);
  }
  if (vault.projectType !== null && types.includes(vault.projectType)) {
    throw new DossierError('PROJECT_NOTE', `"${title}" is a project. A project's dossier is its project wiki: create it with create-project-wiki, rebuild it with curate-project-wiki.`);
  }
  const kinds = entityKinds(vault).filter(kind => kind !== vault.projectType);
  if (!types.some(type => kinds.includes(type))) {
    throw new DossierError('NOT_AN_ENTITY', `"${title}" is not a person or a company: dossiers are for notes of the kinds ${kinds.length > 0 ? kinds.join(', ') : '(none set)'} `
      + `(the vault map's entityTypes, else its person and company kinds), and this note is ${types.length > 0 ? types.join(', ') : 'untyped'}.`);
  }
  // ownerNote is a title, maybe written as a path or a link; compare its file name.
  const owner = ownerName(vault.ownerNote)?.replace(/^.*\//, '').replace(/\.md$/i, '') ?? null;
  if (owner !== null && sameName(owner, title)) {
    throw new DossierError('VAULT_OWNER', `"${title}" is the vault owner's note. The owner is never the subject of memories, so there is no dossier to build.`);
  }
  const kind: DossierKind = vault.personType !== null && types.includes(vault.personType) ? 'person' : 'company';
  return { id: node.id, title, kind, types, node };
}

/** The meetings, notes and tasks a dossier shows, in the order it shows them. */
function shown(evidence: ProjectEvidence, subjectId: string) {
  const recent = evidence.meetings?.recent ?? [];
  const upcoming = (evidence.meetings?.upcoming ?? []).slice(0, DOSSIER_LIMITS.upcomingMeetings);
  const meetingIds = new Set([...recent, ...upcoming].map(meeting => meeting.id));
  const taskIds = new Set<string>();
  const tasks: Array<{ bucket: string; task: ProjectEvidence['tasks'][string][number] }> = [];
  for (const [bucket] of TASK_BUCKETS) {
    for (const task of (evidence.tasks?.[bucket] ?? []).slice(0, DOSSIER_LIMITS.tasksPerBucket)) {
      if (taskIds.has(task.id) || task.id === subjectId) continue;
      taskIds.add(task.id);
      tasks.push({ bucket, task });
    }
  }
  const allNotes = (evidence.notes ?? []).filter(note => note.id !== subjectId && !meetingIds.has(note.id) && !taskIds.has(note.id));
  const notes = allNotes.slice(0, DOSSIER_LIMITS.notes);
  const people = (evidence.contacts?.people ?? []).filter(person => person.id !== subjectId).slice(0, DOSSIER_LIMITS.people);
  const companies = (evidence.contacts?.companies ?? []).filter(company => company.id !== subjectId).slice(0, DOSSIER_LIMITS.people);
  return { recent, upcoming, tasks, notes, notesLeftOut: allNotes.length - notes.length, people, companies };
}

const TASK_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['overdue', 'overdue'], ['blocked', 'blocked'], ['open', 'open'],
  ['upcoming', 'upcoming'], ['backlog', 'backlog'], ['done_recent', 'done recently'],
];

/** A meeting's time is its day (else its file's); a note's is its file's. Milliseconds. */
function readTime(date: string | null | undefined, mtime: number | null | undefined): number {
  const ms = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(ms) ? ms : (mtime ?? 0);
}

/** The past meetings and the notes that link to the subject, newest first: the order a dossier
 *  reads bodies in (#720). Upcoming meetings have no record of what was said yet. */
export function bodyReadOrder(evidence: ProjectEvidence, subjectId: string): string[] {
  const s = shown(evidence, subjectId);
  return [...s.recent.map(m => ({ id: m.id, at: readTime(m.date, m.file_mtime) })),
    ...s.notes.map(n => ({ id: n.id, at: readTime(null, n.file_mtime) }))]
    .sort((a, b) => b.at - a.at).map(item => item.id);
}

/** Every node a dossier records an observation for. */
export function dossierNodeIds(evidence: ProjectEvidence, subjectId: string): string[] {
  const s = shown(evidence, subjectId);
  return [...new Set([subjectId, ...s.recent.map(m => m.id), ...s.upcoming.map(m => m.id), ...s.notes.map(n => n.id),
    ...s.tasks.map(t => t.task.id), ...s.people.map(p => p.id), ...s.companies.map(c => c.id)])];
}

function newestFirst(memories: readonly Memory[]): Memory[] {
  const time = (memory: Memory): number => {
    const ms = Date.parse(memory.valid_at ?? memory.created_at);
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...memories].sort((a, b) => time(b) - time(a) || b.id - a.id);
}

/** The memories about the subject (#554): its rules and preferences first, so newer memories can't
 *  push them out, then the newest of the rest; and the owner's standing memories, as builds read them. */
export async function readDossierMemories(engine: Pick<CoreDeps['engine'], 'listMemoriesWithTotal'>, subjectId: string): Promise<DossierMemories> {
  const list = (filters: Parameters<CoreDeps['engine']['listMemoriesWithTotal']>[0]) =>
    engine.listMemoriesWithTotal({ includeProvenance: true, ...filters });
  const [owner, rules, preferences, newest, past] = await Promise.all([
    list({ source: 'owner', scope: 'vault', limit: DOSSIER_LIMITS.owner }),
    list({ subject_of: subjectId, category: RULE_CATEGORY, limit: DOSSIER_LIMITS.rules }),
    list({ subject_of: subjectId, category: 'preference', limit: DOSSIER_LIMITS.preferences }),
    list({ subject_of: subjectId, limit: DOSSIER_LIMITS.newest }),
    list({ subject_of: subjectId, expire_reasons: PAST_FACT_REASONS, limit: DOSSIER_LIMITS.past }),
  ]);
  const about = new Map<number, Memory>();
  for (const memory of [...rules.memories, ...preferences.memories, ...newest.memories]) if (!about.has(memory.id)) about.set(memory.id, memory);
  const all = [...about.values()];
  const total = newest.total;
  // Kept only as the Engine marks them (an Engine without the filter ignores it and lists live
  // memories), each with the memory that replaced it: the page model writes one only when that
  // memory says the fact changed, not that it was wrong (#717; owner, 2026-11-21, after dates
  // proved unable to tell the two apart). One whose replacement can't be read is left out.
  const candidates = past.memories.filter(memory => isPastFact(memory) && !about.has(memory.id) && memory.superseded_by);
  const asked = [...new Set(candidates.map(memory => memory.superseded_by!))];
  let replacements = new Map<number, Memory>();
  if (asked.length > 0) {
    try {
      replacements = new Map((await list({ ids: asked, include_superseded: true, limit: asked.length })).memories.map(memory => [memory.id, memory]));
    } catch (error) {
      console.warn(`[curator] dossier: replacing memories unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const replacedBy = new Map<number, Memory>();
  const shownPast: Memory[] = [];
  for (const memory of candidates) {
    const replacement = replacements.get(memory.superseded_by!);
    if (!replacement) continue;
    replacedBy.set(memory.id, replacement);
    // The day it ended goes with it, for the page.
    shownPast.push({ ...memory, invalid_at: pastFactEnd(memory, replacement) });
  }
  return {
    owner: owner.memories.filter(memory => !about.has(memory.id)),
    rules: newestFirst(all.filter(memory => memory.category === RULE_CATEGORY)),
    facts: newestFirst(all.filter(memory => memory.category !== RULE_CATEGORY)),
    past: newestFirst(shownPast),
    replacedBy,
    total,
    omitted: total === null ? 0 : Math.max(0, total - all.length),
  };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** "the 60 newest of 1,214 memories", or "12 memories" when nothing was left out. */
export function memoryCountPhrase(memories: Pick<DossierMemories, 'rules' | 'facts' | 'total' | 'omitted'>): string {
  const shownCount = memories.rules.length + memories.facts.length;
  if (memories.omitted === 0 || memories.total === null) return plural(shownCount, 'memory', 'memories');
  return `${shownCount.toLocaleString('en-US')} of ${plural(memories.total, 'memory', 'memories')} (the ${DOSSIER_LIMITS.newest} newest, with the rules and preferences)`;
}

/** What a build read, for the page's header and Log: "3 memories, 4 notes and 1 meeting". */
export function sourcesPhrase(memories: Pick<DossierMemories, 'rules' | 'facts' | 'total' | 'omitted'> & { readonly past?: readonly Memory[] },
  counts: { readonly notes: number; readonly meetings: number }): string {
  const past = memories.past?.length ?? 0;
  const parts = [memoryCountPhrase(memories), ...(past > 0 ? [plural(past, 'past fact')] : []), ...(counts.notes > 0 ? [plural(counts.notes, 'note')] : []),
    ...(counts.meetings > 0 ? [plural(counts.meetings, 'meeting')] : [])];
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

function memoryLine(memory: Memory, content: string): string {
  return `- [m${memory.id}] ${memory.category ? `[${memory.category}] ` : ''}${memory.source_label ? `${memory.source_label}: ` : ''}${content}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The dossier's evidence text, every line recorded with what it was read from. Pure: the caller
 * reads; this formats. Memory and note lines carry the refs the model cites ("[m812]", "[n3]").
 */
export function renderDossierEvidence(input: {
  readonly subject: DossierSubject;
  readonly evidence: ProjectEvidence;
  readonly memories: DossierMemories;
  readonly owner: string | null;
  readonly sourceTitles: ReadonlyMap<string, string>;
  /** The meeting limit the evidence was read with (`Config.meetingReads`). */
  readonly meetingReads: number;
  readonly timeZone?: string;
  /** Meetings and notes read in full, newest first (`readDossierBodies`); null for one that could not be read. */
  readonly bodies?: ReadonlyMap<string, EngineNode | null>;
}): { text: string; collector: EvidenceCollector; refs: Map<string, DossierRef>; memories: DossierMemories;
  counts: DossierEvidence['counts'] } {
  const { subject, evidence } = input;
  const observations = evidence.provenance_observations?.nodes ?? {};
  const collector = new EvidenceCollector(observations, [], {
    evidence_hash: evidence.evidence_hash, evaluated_at: evidence.generated_at,
    query: { project: subject.id, meeting_recent_limit: Math.min(input.meetingReads, 100),
      meeting_upcoming_limit: DOSSIER_LIMITS.upcomingMeetings, contact_limit: 25, since: null },
  });
  const s = shown(evidence, subject.id);
  const refs = new Map<string, DossierRef>();
  const refOf = new Map<string, string>();
  const addRef = (id: string, title: string, what: DossierRef['what'], date: string | null = null): string => {
    const ref = `n${refs.size + 1}`;
    refs.set(ref, { ref, id, title, date, what });
    if (!refOf.has(id)) refOf.set(id, ref);
    return ref;
  };
  const day = memoryDay(input.timeZone);
  const label = (memories: readonly Memory[]): Memory[] => withSourceLabels(memories, input.sourceTitles, day);
  const memories: DossierMemories = { ...input.memories, owner: label(input.memories.owner),
    rules: label(input.memories.rules), facts: label(input.memories.facts), past: label(input.memories.past ?? []), replacedBy: input.memories.replacedBy ?? new Map() };
  const name = subject.title;
  const lines: string[] = [];

  lines.push(`# Dossier subject: ${name} (${subject.kind})`);
  collector.record(lines, 0, observations[subject.id] ?? subject.node.provenance_observation ?? null, 'engine_projection', 'dossier-subject:v1');
  if (input.owner) {
    const at = lines.length;
    lines.push(`VAULT OWNER (never the subject; call them "you"): ${input.owner}`);
    collector.record(lines, at, null, 'generated_context', 'dossier-owner:v1');
  }
  lines.push('');

  // The subject's own note, in full up to a cap.
  const selfRef = addRef(subject.id, name, 'subject');
  const noteStart = lines.length;
  lines.push(`## ${name.toUpperCase()}'S OWN NOTE [${selfRef}]`);
  lines.push(`kinds: ${subject.types.join(', ') || '(none)'}`);
  const fields = Object.entries(subject.node.fields ?? {}).map(([key, value]) => `${key}=${JSON.stringify(fieldValue(value))}`);
  if (fields.length > 0) lines.push(`fields: ${fields.slice(0, 20).join('; ')}`);
  if (fields.length > 20) collector.omissions.push({ code: 'node_field_count_cap', source: subject.node.provenance_observation?.source ?? null });
  const rawBody = (subject.node.body ?? '').trim();
  const body = rawBody ? truncate(rawBody, DOSSIER_LIMITS.bodyChars) : '(empty body)';
  lines.push('', body, '');
  const bodyTruncated = rawBody.length > DOSSIER_LIMITS.bodyChars;
  collector.record(lines, noteStart, subject.node.provenance_observation, 'source_material', 'dossier-subject-note:v1', bodyTruncated,
    bodyTruncated ? Buffer.byteLength(lines.slice(noteStart).join('\n')) - Buffer.byteLength(body) + Buffer.byteLength(rawBody) : null);
  // A day the model gives for a line citing this note is kept only when the note as shown holds it.
  refs.set(selfRef, { ...refs.get(selfRef)!, text: lines.slice(noteStart).join('\n') });

  const memoryBlock = (heading: string, group: readonly Memory[]): void => {
    if (group.length === 0) return;
    lines.push(heading);
    for (const memory of group) {
      const cut = memory.source !== 'owner' && memory.content.length > MEMORY_CHAR_CAP;
      const content = oneLine(cut ? `${memory.content.slice(0, MEMORY_CHAR_CAP).trimEnd()}… (cut)` : memory.content);
      const at = lines.length;
      lines.push(memoryLine(memory, content));
      collector.record(lines, at, memory.provenance_observation, memoryRole(memory), 'dossier-memory:v1', cut,
        cut ? Buffer.byteLength(memoryLine(memory, memory.content)) : null);
    }
    lines.push('');
  };
  memoryBlock('## OWNER MEMORIES (your own standing notes: follow them; cite one only when it is about the subject)', memories.owner);
  if (memories.rules.length > 0) {
    // The same block a project page's writer sees, with each rule's ref for the record.
    const rulesBlock = renderPageRules(memories.rules);
    lines.push(rulesBlock[0]!);
    memories.rules.forEach((rule, index) => {
      const at = lines.length;
      lines.push(`- [m${rule.id}] ${rulesBlock[index + 1]!.slice(2)}`);
      collector.record(lines, at, rule.provenance_observation, memoryRole(rule), 'dossier-rule:v1');
    });
    lines.push('');
  }
  if (input.memories.omitted > 0) collector.omissions.push({ code: 'memory_limit', source: null });
  memoryBlock(`## MEMORIES ABOUT ${name.toUpperCase()} (live facts, newest first, each with the day it became true and where it came from; ${memoryCountPhrase(memories)})`,
    memories.facts);
  const shownPast = memories.past.filter(memory => input.memories.replacedBy?.has(memory.id));
  if (shownPast.length > 0) {
    // Past facts (#717): memories a newer one contradicted, each over the memory that replaced it,
    // so the model can tell a change (History) from a correction (never true: left out).
    lines.push(`## PAST FACTS ABOUT ${name.toUpperCase()} (each was contradicted by the newer memory under it: write it in History only when that one says the fact changed, never when it says this one was wrong; newest first, with the days it was true where known)`);
    const capped = (memory: Memory): { content: string; cut: boolean } => {
      const cut = memory.content.length > MEMORY_CHAR_CAP;
      return { content: oneLine(cut ? `${memory.content.slice(0, MEMORY_CHAR_CAP).trimEnd()}… (cut)` : memory.content), cut };
    };
    for (const memory of shownPast) {
      const replacement = label([input.memories.replacedBy!.get(memory.id)!])[0]!;
      const start = pastFactStart(memory);
      const end = pastFactEnd(memory);
      // The day it was recorded is no day it became true: then only its end is said.
      const shownLabel = start ? memory : { ...memory, ...(memory.source_label ? { source_label: memory.source_label.replace(/^\d{4}-\d{2}-\d{2}(, )?/, '') } : {}) };
      const days = start && end ? ` (true from ${day(start)} until ${day(end)})` : end ? ` (until ${day(end)})` : '';
      const own = capped(memory);
      let at = lines.length;
      lines.push(`${memoryLine(shownLabel, own.content)}${days}`);
      collector.record(lines, at, memory.provenance_observation, memoryRole(memory), 'dossier-past-memory:v1', own.cut,
        own.cut ? Buffer.byteLength(`${memoryLine(shownLabel, memory.content)}${days}`) : null);
      const next = capped(replacement);
      at = lines.length;
      lines.push(`  replaced by ${memoryLine(replacement, next.content).slice(2)}`);
      collector.record(lines, at, replacement.provenance_observation, memoryRole(replacement), 'dossier-past-replacement:v1', next.cut,
        next.cut ? Buffer.byteLength(`  replaced by ${memoryLine(replacement, replacement.content).slice(2)}`) : null);
    }
    lines.push('');
  }

  const meetingLine = (meeting: EvidenceMeeting, upcoming: boolean, ref: string): string => {
    const attendees = meeting.attendees.filter(person => !sameName(person, name));
    return `- [${ref}] ${upcoming ? 'upcoming ' : ''}${meeting.date ?? '(no date)'} · ${meeting.title}${attendees.length > 0 ? ` · with ${attendees.join(', ')}` : ''}`;
  };
  if (s.recent.length > 0 || s.upcoming.length > 0) {
    lines.push(`## MEETINGS THAT LINK TO ${name.toUpperCase()} (newest first; upcoming ones marked)`);
    for (const [meeting, upcoming] of [...s.upcoming.map(m => [m, true] as const), ...s.recent.map(m => [m, false] as const)]) {
      const ref = addRef(meeting.id, meeting.title, 'meeting', meeting.date?.slice(0, 10) ?? null);
      const at = lines.length;
      lines.push(meetingLine(meeting, upcoming, ref));
      collector.catalog(lines, at, [meeting.id], 'engine_projection', 'dossier-meeting:v1');
    }
    lines.push('');
  }
  if (s.notes.length > 0) {
    lines.push(`## NOTES THAT LINK TO ${name.toUpperCase()} (newest first; titles here, the newest also in full below)`);
    for (const note of s.notes) {
      const ref = addRef(note.id, note.title, 'note');
      const at = lines.length;
      lines.push(`- [${ref}] ${note.title}`);
      collector.catalog(lines, at, [note.id], 'engine_projection', 'dossier-note-title:v1');
    }
    if (s.notesLeftOut > 0) collector.omissions.push({ code: 'note_read_count_cap', source: null });
    lines.push('');
  }
  // The newest meetings and notes in full (#720): a fact said only in one reaches the page, cited to it.
  const bodies = [...(input.bodies ?? new Map<string, EngineNode | null>())];
  let readCount = 0;
  if (bodies.some(([id, node]) => node !== null && refOf.has(id))) {
    lines.push(`## WHAT THE NEWEST MEETINGS AND NOTES SAY (their text, newest first, each cut at ${DOSSIER_LIMITS.readBodyChars.toLocaleString('en-US')} characters; cite each by its ref)`, '');
  }
  for (const [id, node] of bodies) {
    const ref = refOf.get(id);
    if (node === null) {
      collector.omissions.push({ code: 'source_body_unavailable', source: observations[id]?.source ?? null });
      continue;
    }
    if (ref === undefined) continue;
    const shownRef = refs.get(ref)!;
    const start = lines.length;
    lines.push(`### [${ref}] ${shownRef.date ? `${shownRef.date} · ` : ''}${shownRef.title}`);
    const raw = (node.body ?? '').trim();
    const text = raw ? truncate(raw, DOSSIER_LIMITS.readBodyChars) : '(empty body)';
    lines.push(text, '');
    const cut = raw.length > DOSSIER_LIMITS.readBodyChars;
    collector.record(lines, start, node.provenance_observation ?? observations[id] ?? null, 'source_material', 'dossier-body:v1', cut,
      cut ? Buffer.byteLength(lines.slice(start).join('\n')) - Buffer.byteLength(text) + Buffer.byteLength(raw) : null);
    refs.set(ref, { ...shownRef, text: lines.slice(start).join('\n') });
    readCount += 1;
  }
  if (s.tasks.length > 0) {
    lines.push(`## TASKS THAT LINK TO ${name.toUpperCase()}`);
    for (const { bucket, task } of s.tasks) {
      const ref = addRef(task.id, task.title, 'task');
      const meta = [TASK_BUCKETS.find(([key]) => key === bucket)?.[1] ?? bucket, task.due ? `due ${task.due}` : null,
        task.status ? `status ${task.status}` : null].filter(Boolean).join('; ');
      const at = lines.length;
      lines.push(`- [${ref}] ${task.title} (${meta})`);
      collector.catalog(lines, at, [task.id], 'engine_projection', 'dossier-task:v1');
    }
    lines.push('');
  }
  // The owner attends most meetings; the owner line already names them.
  const people = s.people.filter(person => input.owner === null || !sameName(person.title, input.owner));
  if (people.length > 0 || s.companies.length > 0) {
    const start = lines.length;
    lines.push(`## PEOPLE AND COMPANIES CONNECTED TO ${name.toUpperCase()} (each has a note under this exact title; link them by it. In brackets: their company, "on ${name}'s note" when the note names them, and the meetings shared with ${name})`);
    for (const person of people) {
      const parts = [person.companies.join(', '), person.direct ? `on ${name}'s note` : null,
        person.meeting_count > 0 ? plural(person.meeting_count, 'meeting') : null].filter(part => part !== null && part !== '');
      lines.push(`- ${person.title}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`);
    }
    for (const company of s.companies) lines.push(`- ${company.title} (company)`);
    collector.catalog(lines, start, [...people.map(p => p.id), ...s.companies.map(c => c.id)], 'engine_projection', 'dossier-people:v1');
    collector.record(lines, start, null, 'engine_projection', 'dossier-people-projection:v1');
    lines.push('');
  }
  const unlinked = (evidence.contacts?.unlinked ?? []).filter(person => !sameName(person.name, name)).slice(0, DOSSIER_LIMITS.people);
  if (unlinked.length > 0) {
    const start = lines.length;
    lines.push('## PEOPLE NAMED WITHOUT A NOTE (no note exists: write each name as plain text, never as a link)');
    for (const person of unlinked) {
      lines.push(`- ${person.name}${person.meeting_count > 0 ? ` (${plural(person.meeting_count, 'meeting')})` : ''}`);
    }
    collector.record(lines, start, null, 'engine_projection', 'dossier-unlinked-people:v1');
    lines.push('');
  }
  const text = lines.join('\n').trim();
  collector.finish(lines, text);
  return { text, collector, refs, memories,
    counts: { notes: s.notes.length, meetings: s.recent.length + s.upcoming.length, tasks: s.tasks.length,
      people: people.length, companies: s.companies.length, bodies: readCount } };
}

/** Note titles by id from the evidence, for the source links of memory lines. */
function evidenceTitles(subject: DossierSubject, evidence: ProjectEvidence): Map<string, string> {
  const titles = new Map<string, string>([[subject.id, subject.title]]);
  const add = (id: string | undefined, title: string | null | undefined): void => {
    if (id && title && !titles.has(id)) titles.set(id, title);
  };
  for (const meeting of [...(evidence.meetings?.recent ?? []), ...(evidence.meetings?.upcoming ?? [])]) add(meeting.id, meeting.title);
  for (const note of evidence.notes ?? []) add(note.id, note.title);
  for (const bucket of Object.values(evidence.tasks ?? {})) for (const task of bucket ?? []) add(task.id, task.title);
  for (const person of evidence.contacts?.people ?? []) add(person.id, person.title);
  for (const company of evidence.contacts?.companies ?? []) add(company.id, company.title);
  return titles;
}

/**
 * The page's "Last contact", computed, never written by the model: the newest past dated meeting
 * that a person attended, or, for a company, that someone the vault places at it attended (their
 * note's company field: `members`, read with `listPeopleAt`, plus the evidence's contacts). A
 * meeting that only links to the note is no contact: the first real build's company dry run
 * (2026-11-21) named a meeting with another firm that mentioned it.
 */
export function lastContactOf(evidence: ProjectEvidence, today: string,
  subject: Pick<DossierSubject, 'title' | 'kind'>, members: readonly string[] = []): { title: string; date: string } | null {
  const present = subject.kind === 'person' ? [subject.title]
    : [...members, ...(evidence.contacts?.people ?? []).filter(person => person.companies.some(company => sameName(company, subject.title)))
      .map(person => person.title)];
  const meeting = (evidence.meetings?.recent ?? []).find(m => m.date !== null && m.date.slice(0, 10) <= today
    && m.attendees.some(attendee => present.some(name => sameName(attendee, name))));
  return meeting ? { title: meeting.title, date: meeting.date!.slice(0, 10) } : null;
}

/** The most meetings `project-evidence` lists: "Last contact" reads this many when the page's own
 *  meetings (`meetingReads`) show none attended and may be cut off (Codex, #713). */
export const CONTACT_MEETING_READS = 100;

/**
 * "Last contact", looked for among the page's meetings first and, when they show none attended and
 * were cut off at their limit, among the Engine's newest 100 that link to the note. A meeting found
 * only by the second read is not among the capture's recorded inputs: the line is code's, like the
 * page's header. With still none and the 100 cut off too, `contactSearched` says how many were read.
 */
async function findLastContact(deps: Pick<CoreDeps, 'engine' | 'config'>, subject: DossierSubject, evidence: ProjectEvidence,
  today: string): Promise<{ lastContact: DossierEvidence['lastContact']; contactSearched: number | null }> {
  const members = await peopleAt(deps, subject);
  const recent = (read: ProjectEvidence): number => read.meetings?.recent?.length ?? 0;
  let read = evidence;
  let limit = Math.min(deps.config.meetingReads, CONTACT_MEETING_READS);
  let found = lastContactOf(evidence, today, subject, members);
  if (found === null && recent(evidence) >= limit && limit < CONTACT_MEETING_READS) {
    try {
      read = await deps.engine.projectEvidence(subject.id, CONTACT_MEETING_READS);
      limit = CONTACT_MEETING_READS;
      found = lastContactOf(read, today, subject, members);
    } catch (error) {
      console.warn(`[curator] dossier: more meetings for "${subject.title}" unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const searched = found === null && recent(read) > 0 && recent(read) >= limit ? recent(read) : null;
  return { lastContact: found, contactSearched: searched };
}

/** The people the vault places at a company, for "Last contact". Best effort: on a failed read the
 *  evidence's own (capped) contacts stand alone. */
async function peopleAt(deps: Pick<CoreDeps, 'engine' | 'config'>, subject: DossierSubject): Promise<string[]> {
  const vault = vaultOf(deps.config);
  if (subject.kind !== 'company' || vault.personType === null || vault.companyField === null) return [];
  try {
    return (await deps.engine.listPeopleAt(subject.id, { personType: vault.personType, companyField: vault.companyField })).titles;
  } catch (error) {
    console.warn(`[curator] dossier: people at "${subject.title}" unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * The bodies a dossier reads in full (#720): the first `readBodies` of `order` (newest first), each
 * with its provenance. A wiki page is passed over and the next taken: it is generated, not a source
 * (a dossier's own page links its root). A note that can't be read takes its place as null, so a
 * failing Engine costs at most `readBodies` reads; the page records it as an omission.
 */
export async function readDossierBodies(engine: Pick<CoreDeps['engine'], 'getNode'>, order: readonly string[],
  wikiType: string | null, limit: number = DOSSIER_LIMITS.readBodies): Promise<Map<string, EngineNode | null>> {
  const out = new Map<string, EngineNode | null>();
  let next = 0;
  while (next < order.length && out.size < limit) {
    const batch = order.slice(next, next + limit - out.size);
    next += batch.length;
    const read = await Promise.all(batch.map(id => engine.getNode(id, { includeProvenance: true, includeEmbeds: false }).catch((error: unknown) => {
      console.warn(`[curator] dossier: note ${id} unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    })));
    batch.forEach((id, index) => {
      const node = read[index] ?? null;
      if (node !== null && wikiType !== null && (node.types ?? []).includes(wikiType)) return;
      out.set(id, node);
    });
  }
  return out;
}

/** Reads everything a dossier is built from, with provenance. Free: no model call. */
export async function gatherDossierEvidence(deps: Pick<CoreDeps, 'engine' | 'config' | 'db'>, subject: DossierSubject,
  generatedAt: Date): Promise<DossierEvidence> {
  const { engine, config } = deps;
  const first = await engine.projectEvidence(subject.id, config.meetingReads, undefined, { includeProvenance: true });
  const evidence = await completeHomeEvidenceObservations(engine, first, subject.id, config.meetingReads, undefined,
    current => dossierNodeIds(current, subject.id));
  const wiki = evidence.existing_wiki;
  if (wiki.subpages.length > 0 || (deps.db && wikiRootFor(deps.db, subject.title, subject.id))) {
    throw new DossierError('HAS_WIKI', `"${subject.title}" already has a wiki of its own. A dossier is a page of its own and is not built over a wiki.`);
  }
  const memories = await readDossierMemories(engine, subject.id);
  const sourceTitles = evidenceTitles(subject, evidence);
  const unknown = [...new Set([...memories.facts, ...memories.rules, ...memories.past, ...memories.replacedBy.values()].flatMap(memory =>
    memory.evidence_node_id && !sourceTitles.has(memory.evidence_node_id) ? [memory.evidence_node_id] : []))];
  if (unknown.length > 0) {
    try {
      for (const note of await engine.listNotesById(unknown)) if (note.title) sourceTitles.set(note.id, note.title);
    } catch (error) {
      // Best effort: a memory whose note can't be named says "from a note".
      console.warn(`[curator] dossier: note titles unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const vault = vaultOf(config);
  const owner = ownerName(vault.ownerNote);
  // `dossierBodyReads` (default 8, #720): after the first builds with 8 failed on production, a setting.
  const bodies = await readDossierBodies(engine, bodyReadOrder(evidence, subject.id), vault.wikiType, config.dossierBodyReads ?? DOSSIER_LIMITS.readBodies);
  const rendered = renderDossierEvidence({ subject, evidence, memories, owner, sourceTitles, meetingReads: config.meetingReads,
    timeZone: config.curatorTz, bodies });
  const memoryById = new Map<number, Memory>();
  for (const memory of [...rendered.memories.owner, ...rendered.memories.rules, ...rendered.memories.facts, ...rendered.memories.past]) memoryById.set(memory.id, memory);
  // A live replacement can be cited too: it is what is true now.
  for (const memory of rendered.memories.replacedBy.values()) if (!memory.expired_at && !memoryById.has(memory.id)) memoryById.set(memory.id, memory);
  const contact = await findLastContact(deps, subject, evidence, localDate(generatedAt, config.curatorTz));
  return { subject, evidence, memories: rendered.memories, memoryById, refs: rendered.refs, sourceTitles,
    lastContact: contact.lastContact, contactSearched: contact.contactSearched,
    counts: rendered.counts, text: rendered.text, collector: rendered.collector };
}
