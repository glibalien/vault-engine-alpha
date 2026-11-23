import { localDate } from './date-line.js';
import type { Engine } from './engine.js';
import type { Memory } from './types.js';

/**
 * Which durable memories a wiki build sees (#297). Before, every build got the same newest 50
 * vault memories, so a project's own facts rarely reached it and unrelated, private facts
 * reached every wiki. Now a build gets the owner's standing memories plus the memories about
 * its subject: scoped to its root or home, drawn from its evidence notes, naming it, or drawn
 * from the related notes it also shows.
 * A project build takes its evidence memories most specific first (#551). A summary note filed
 * under a dozen projects lends its memories to every one of them, and newest first let those fill
 * the limit ahead of memories from the project's own meetings.
 * A memory change never triggers a rebuild; the next build simply sees it.
 * Rules on what may be said (category `rule`, #626) come first among the subject's memories, and
 * the build's notes are asked for theirs on their own, so newer memories can't push a rule out
 * before the planner marks it as a page's rule (#474 idea 4).
 */

/** The category of a memory that is a rule on what may or may not be said, shared or claimed. */
export const RULE_CATEGORY = 'rule';

/** The owner's own memories are standing instructions: all of them, newest first, up to this. */
export const OWNER_MEMORY_LIMIT = 50;
/** Memories about the wiki's subject, most direct first. */
export const SUBJECT_MEMORY_LIMIT = 40;
/** A name matching more memories than this does not single out the subject (an employer, a
 *  common word), so it selects nothing. Memories drawn from the subject's notes still count. */
export const NAME_MATCH_CEILING = 25;
/** A longer memory is cut to this many characters and marked. The owner's own memories are never
 *  cut: like corrections, an oversized one fails the build's capture rather than losing text. */
export const MEMORY_CHAR_CAP = 1_000;

const NODE_MEMORY_LIMIT = 20;
/** The Engine's limit on evidence_node_ids in one list-memories call. */
const EVIDENCE_ID_LIMIT = 200;
/** At most this many notes' subject sets are read for one build: one list-memories call each. */
export const SUBJECT_NOTE_LIMIT = 12;

export interface WikiMemorySubject {
  /** The project or topic node. */
  readonly rootId: string | null;
  readonly homeId: string | null;
  /** The project node, for a project wiki. Its evidence memories are then taken from the
   *  project's memory set, most specific first, before the rest of the evidence memories. */
  readonly projectId?: string | null;
  /** What the subject is called: its title, aliases, companies. Searched for after the subject
   *  sets, as a fallback for memories that name it but have no subjects (#719, owner's choice). */
  readonly names: readonly string[];
  /** Notes whose subject sets (list-memories subject_of) are about the subject itself, read
   *  before the evidence memories: a project's own note (#719). */
  readonly subjectNoteIds?: readonly string[];
  /** Notes around the subject whose subject sets are read after the evidence memories: a
   *  project's companies and the people on its note (owner: the people field, not attendees). */
  readonly relatedSubjectIds?: readonly string[];
  /** The notes the build reads as evidence; memories drawn from them are about the subject. */
  readonly evidenceNodeIds: readonly string[];
  /** Related notes the build also shows (semantic gap-fill leads): their memories rank last. */
  readonly relatedNodeIds?: readonly string[];
}

export interface WikiMemories {
  /** The owner's memories first, then the subject's. */
  readonly memories: readonly Memory[];
  /** Matching memories the limits left out (an upper bound when the queries overlap). */
  readonly omitted: number;
  /** Names that matched too many memories to select by. */
  readonly commonNames: readonly string[];
}

/** An FTS5 phrase query for a name, or null when it has nothing to match. */
export function ftsPhrase(name: string): string | null {
  const text = name.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(text) ? `"${text}"` : null;
}

type MemoryLister = Pick<Engine, 'listMemoriesWithTotal'>;
type Listed = { memories: Memory[]; total: number | null };

const NONE: Listed = { memories: [], total: 0 };

function leftOut(listed: Listed): number {
  return listed.total === null ? 0 : Math.max(0, listed.total - listed.memories.length);
}

export async function selectWikiMemories(
  engine: MemoryLister, subject: WikiMemorySubject, opts: { includeProvenance: boolean },
): Promise<WikiMemories> {
  const list = (filters: Parameters<MemoryLister['listMemoriesWithTotal']>[0]) =>
    engine.listMemoriesWithTotal({ ...(opts.includeProvenance ? { includeProvenance: true } : {}), ...filters });
  const phrases = [...new Map(subject.names.flatMap(name => {
    const phrase = ftsPhrase(name);
    return phrase === null ? [] : [[phrase.toLowerCase(), { name: name.trim(), phrase }] as const];
  })).values()];
  const evidenceIds = [...new Set(subject.evidenceNodeIds)].slice(0, EVIDENCE_ID_LIMIT);
  const relatedIds = [...new Set(subject.relatedNodeIds ?? [])].filter(id => !evidenceIds.includes(id)).slice(0, EVIDENCE_ID_LIMIT);
  // The memories about the subject, by their subjects (#719): they find a memory that never names
  // it in full, and a common name no longer drops it. Bounded in calls, most direct first.
  const subjectIds = [...new Set(subject.subjectNoteIds ?? [])];
  const aroundIds = [...new Set(subject.relatedSubjectIds ?? [])].filter(id => !subjectIds.includes(id));
  const bySubject = [...subjectIds, ...aroundIds].slice(0, SUBJECT_NOTE_LIMIT);
  const [about, around] = [bySubject.filter(id => subjectIds.includes(id)), bySubject.filter(id => !subjectIds.includes(id))];
  // One awaited batch, so a failed read rejects it at once (Codex, #727: two batches left one
  // unhandled, which ends the process).
  const [owner, root, home, rules, specific, evidence, related, ...rest] = await Promise.all([
    list({ source: 'owner', scope: 'vault', limit: OWNER_MEMORY_LIMIT }),
    subject.rootId ? list({ scope: 'node', node_id: subject.rootId, limit: NODE_MEMORY_LIMIT }) : NONE,
    subject.homeId && subject.homeId !== subject.rootId
      ? list({ scope: 'node', node_id: subject.homeId, limit: NODE_MEMORY_LIMIT }) : NONE,
    evidenceIds.length > 0
      ? list({ scope: 'vault', evidence_node_ids: evidenceIds, category: RULE_CATEGORY, limit: SUBJECT_MEMORY_LIMIT }) : NONE,
    // The evidence memories from notes filed under the project, most specific first (#551). The
    // plain evidence query below still adds the rest (a contact's note, say) after them.
    subject.projectId && evidenceIds.length > 0
      ? list({ scope: 'vault', evidence_node_ids: evidenceIds, project_of: subject.projectId, limit: SUBJECT_MEMORY_LIMIT }) : NONE,
    evidenceIds.length > 0 ? list({ scope: 'vault', evidence_node_ids: evidenceIds, limit: SUBJECT_MEMORY_LIMIT }) : NONE,
    relatedIds.length > 0 ? list({ scope: 'vault', evidence_node_ids: relatedIds, limit: SUBJECT_MEMORY_LIMIT }) : NONE,
    ...phrases.map(({ phrase }) => list({ scope: 'vault', query: phrase, limit: SUBJECT_MEMORY_LIMIT })),
    ...bySubject.map(id => list({ subject_of: id, limit: SUBJECT_MEMORY_LIMIT })),
  ]);
  const named = rest.slice(0, phrases.length);
  const sets = rest.slice(phrases.length);
  const aboutSets = sets.slice(0, about.length);
  const aroundSets = sets.slice(about.length, about.length + around.length);
  const commonNames: string[] = [];
  const naming: Listed[] = [];
  named.forEach((listed, index) => {
    if ((listed.total ?? listed.memories.length) > NAME_MATCH_CEILING) commonNames.push(phrases[index]!.name);
    else naming.push(listed);
  });

  const seen = new Set(owner.memories.map(m => m.id));
  const subjectMemories: Memory[] = [];
  const take = (memory: Memory): void => {
    if (seen.has(memory.id)) return;
    seen.add(memory.id);
    subjectMemories.push(memory);
  };
  const listings = [root, home, specific, ...aboutSets, evidence, ...aroundSets, ...naming];
  // The rules first, from every listing but the related notes': those are leads, not the subject.
  for (const listed of [root, home, rules, specific, ...aboutSets, evidence, ...aroundSets, ...naming]) {
    for (const memory of listed.memories) if (memory.category === RULE_CATEGORY) take(memory);
  }
  for (const listed of [...listings, related]) for (const memory of listed.memories) take(memory);
  const kept = subjectMemories.slice(0, SUBJECT_MEMORY_LIMIT);
  const omitted = leftOut(owner) + (subjectMemories.length - kept.length)
    + [...listings, rules, related].reduce((sum, listed) => sum + leftOut(listed), 0);
  return { memories: [...owner.memories, ...kept], omitted, commonNames };
}

export interface RenderedMemoryLine {
  /** Index into the rendered lines. */
  readonly lineIndex: number;
  readonly memory: Memory;
  readonly truncated: boolean;
  /** Bytes of the line before truncation. */
  readonly originalBytes: number;
}

function memoryLine(memory: Memory, content: string): string {
  return `- ${memory.category ? `[${memory.category}] ` : ''}${memory.source_label ? `${memory.source_label}: ` : ''}${content}`;
}

/**
 * Where each of a wiki build's memories came from and when it became true (#474 idea 4):
 * "2026-11-03, from "Kickoff call"", "from a chat", "from a wiki build". A note's title is known
 * when the build's evidence names it; otherwise it is "from a note".
 */
export function withSourceLabels(memories: readonly Memory[], titles: ReadonlyMap<string, string>, day: (iso: string) => string): Memory[] {
  return memories.map(memory => {
    if (memory.source === 'owner') return memory;
    const when = memory.valid_at ?? memory.created_at;
    const title = memory.evidence_node_id ? titles.get(memory.evidence_node_id) : undefined;
    const from = memory.evidence_kind === 'conversation' ? 'from a chat'
      : memory.evidence_kind === 'curation-run' ? 'from a wiki build'
        : title ? `from "${title.replace(/"/g, "'")}"` : memory.evidence_kind === 'note' ? 'from a note' : null;
    const label = [when ? day(when) : null, from].filter(Boolean).join(', ');
    return label ? { ...memory, source_label: label } : memory;
  });
}

/** The day an ISO time falls on in the Curator's zone, for a memory line's label. Midnight UTC is
 *  a day with no time (the Engine's date-only convention: a note memory's note day, #706, or a
 *  verdict's "as of November"), so it is that day in any zone, not the evening before in one west
 *  of UTC. */
export function memoryDay(timeZone: string | undefined): (iso: string) => string {
  return iso => {
    if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(iso)) return iso.slice(0, 10);
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? localDate(ms, timeZone) : iso.slice(0, 10);
  };
}

/** Two of a build's memories that disagree, where neither's note is later (#474 idea 4). */
export interface MemoryConflict { readonly a: Memory; readonly b: Memory }

/** Conflicts shown in one wiki prompt. */
export const CONFLICT_LIMIT = 10;

function conflictSide(memory: Memory): string {
  const text = memory.content.replace(/\s+/g, ' ').trim();
  return `"${text.length > MEMORY_CHAR_CAP ? `${text.slice(0, MEMORY_CHAR_CAP).trimEnd()}… (cut)` : text}"${memory.source_label ? ` (${memory.source_label})` : ''}`;
}

/**
 * The block of memories that disagree and that nothing has settled (#474 idea 4). The nightly
 * reconciler keeps both of a contradictory pair when neither's note is later, so it can't tell
 * which is right; until now a wiki saw both as plain facts.
 */
export function renderConflicts(conflicts: readonly MemoryConflict[]): string[] {
  if (conflicts.length === 0) return [];
  return ['## UNSETTLED CONFLICTS (memories that disagree, where neither source is later; treat each as an open question, and state neither side as settled)',
    ...conflicts.map(conflict => `- ${conflictSide(conflict.a)} vs ${conflictSide(conflict.b)}`)];
}

/** The build's memory pairs the reconciler kept both of, both members live in this build. */
export function memoryConflicts(memories: readonly Memory[], read: ((memoryIds: readonly number[]) => ReadonlyArray<readonly [number, number]>) | undefined): MemoryConflict[] {
  if (!read) return [];
  const byId = new Map(memories.filter(memory => memory.source !== 'owner').map(memory => [memory.id, memory]));
  return read([...byId.keys()]).flatMap(([a, b]) => {
    const first = byId.get(a);
    const second = byId.get(b);
    return first && second ? [{ a: first, b: second }] : [];
  }).slice(0, CONFLICT_LIMIT);
}

function newestFirst(memories: readonly Memory[]): Memory[] {
  const time = (memory: Memory): number => {
    const ms = Date.parse(memory.valid_at ?? memory.created_at);
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...memories].sort((a, b) => time(b) - time(a));
}

/**
 * The memory blocks of a wiki prompt (#299): the owner's memories under their own heading, the
 * rest as facts about the subject. Ids are not shown; no output field acts on them. A project
 * build's memories carry their day and source and come newest first (#474 idea 4).
 */
export function renderWikiMemories(memories: readonly Memory[], subject: 'project' | 'topic'): {
  lines: string[]; entries: RenderedMemoryLine[];
} {
  const lines: string[] = [];
  const entries: RenderedMemoryLine[] = [];
  const block = (heading: string, group: readonly Memory[]): void => {
    if (group.length === 0) return;
    lines.push(heading);
    for (const memory of group) {
      const truncated = memory.source !== 'owner' && memory.content.length > MEMORY_CHAR_CAP;
      const content = truncated ? `${memory.content.slice(0, MEMORY_CHAR_CAP).trimEnd()}… (cut)` : memory.content;
      entries.push({ lineIndex: lines.length, memory, truncated,
        originalBytes: Buffer.byteLength(memoryLine(memory, memory.content)) });
      lines.push(memoryLine(memory, content));
    }
    lines.push('');
  };
  block('## OWNER MEMORIES (the owner\'s own standing notes: follow them)', memories.filter(m => m.source === 'owner'));
  const others = memories.filter(m => m.source !== 'owner');
  const labelled = others.some(m => m.source_label !== undefined);
  block(labelled
    ? `## MEMORIES (durable facts about this ${subject} from earlier notes, conversations and wiki builds; newest first, each with the day it became true and where it came from)`
    : `## MEMORIES (durable facts about this ${subject} from earlier notes, conversations and wiki builds)`,
  labelled ? newestFirst(others) : others);
  return { lines, entries };
}

/** Provenance role of a memory: the owner's are corrections; the rest is generated context. */
export function memoryRole(memory: Memory): 'human_correction' | 'generated_context' {
  return memory.source === 'owner' ? 'human_correction' : 'generated_context';
}
