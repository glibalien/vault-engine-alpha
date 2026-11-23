import type { MemoryService } from './service.js';
import { toMemory } from './service.js';
import type { Memory, MemoryRow } from './types.js';

/**
 * Sources whose memories about a node, or drawn from it, come with a read of it (#560): the four
 * the Obsidian chat puts in front of its model (`INJECTED_SOURCES` in
 * `packages/chat-core/src/context/memories-provider.ts`). Keep the two lists the same. A project's
 * memories come from every source, as in the chat (#352).
 */
export const READER_MEMORY_SOURCES: readonly string[] = ['chat', 'curator', 'owner', 'claude'];

/** The chat's fetch limits: 20 node memories for each of its four sources, 30 about the node
 *  (its subject set, #554), and 30 of the project's. */
const NODE_LIMIT = 80;
const SUBJECT_LIMIT = 30;
const PROJECT_LIMIT = 30;
/**
 * Rows each fetch reads, to tell whether a limit left a memory out (#560). Past its limit a fetch
 * may hold only memories the others brought, and the others bring at most their own limits, so
 * one more than all the limits together always shows a memory left out when there is one.
 */
const SPARE_LIMIT = NODE_LIMIT + SUBJECT_LIMIT + PROJECT_LIMIT + 1;

/** Characters of memory content returned, the chat's cap (about 1,500 tokens). */
export const BEARING_CHAR_CAP = 6000;

/** A memory as a read returns it: what it says, and enough about its source to open that first. */
export interface BearingMemory {
  id: number;
  content: string;
  category: string | null;
  source: string;
  created_at: string;
  /** When it became true: its source note's day for a note memory (#706). The order's key. */
  valid_at: string | null;
  evidence_kind: string;
  evidence_node_id: string | null;
  evidence_ref: string | null;
  /** `node`: scoped to the node read, or drawn from it. `subject`: naming it as a subject, from any note or
   *  chat (#554). `project`: from the memory set of a project it is filed under. */
  via: 'node' | 'subject' | 'project';
}

export interface BearingMemories {
  memories: BearingMemory[];
  /** `considered`: the memories fetched before the cap. `truncated`: some memories that bear on the node were
   *  left out, by the character cap or because the node or its project has more than the fetch limits. */
  memory_stats: { returned: number; considered: number; truncated: boolean };
}

/** Preference, correction and rule (#626) first, as the chat shows them; then the node's own; then
 *  those about it (#554); then its project's. */
function tierOf(memory: BearingMemory): number {
  if (memory.category === 'preference' || memory.category === 'correction' || memory.category === 'rule') return 0;
  return memory.via === 'node' ? 1 : memory.via === 'subject' ? 2 : 3;
}

function compare(a: BearingMemory, b: BearingMemory): number {
  const tier = tierOf(a) - tierOf(b);
  if (tier !== 0) return tier;
  // Newest first by when each became true (#706), as list-memories orders them.
  const aWhen = a.valid_at ?? a.created_at;
  const bWhen = b.valid_at ?? b.created_at;
  if (aWhen !== bWhen) return aWhen < bWhen ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return b.id - a.id;
}

function bearing(memory: Memory, via: BearingMemory['via']): BearingMemory {
  return {
    id: memory.id,
    content: memory.content,
    category: memory.category,
    source: memory.source,
    created_at: memory.created_at,
    valid_at: memory.valid_at,
    evidence_kind: memory.evidence_kind,
    evidence_node_id: memory.evidence_node_id,
    evidence_ref: memory.evidence_ref,
    via,
  };
}

/**
 * The live memories that bear on a node (#560), for `get-node` and `project-evidence` with
 * `include_memories`: memories scoped to it or drawn from it, from the chat's sources; the memories
 * that name it as a subject, from any source (`list-memories subject_of`, #554: a person's or a
 * company's memories from meetings and chats); and the memory set of each project it is filed under
 * (`list-memories project_of`). Ordered as the chat orders them: preference, correction and rule
 * first, then the node's own, then those about it, then its project's,
 * newest first within each by when each became true (#706). Cut on whole memories at `BEARING_CHAR_CAP` characters of content;
 * the first is always returned whole.
 */
export function memoriesBearingOn(service: MemoryService, nodeId: string): BearingMemories {
  const marks = READER_MEMORY_SOURCES.map(() => '?').join(', ');
  const own = service.database.prepare(
    `SELECT * FROM memories
     WHERE expired_at IS NULL AND source IN (${marks})
       AND ((scope = 'node' AND node_id = ?) OR evidence_node_id = ?)
     ORDER BY COALESCE(valid_at, created_at) DESC, created_at DESC, id DESC
     LIMIT ?`,
  ).all(...READER_MEMORY_SOURCES, nodeId, nodeId, SPARE_LIMIT) as MemoryRow[];
  const subject = service.list({ subject_of: nodeId, limit: SPARE_LIMIT, offset: 0 });
  if (!subject.ok) throw new Error(subject.error.message);
  const project = service.list({ project_of: nodeId, limit: SPARE_LIMIT, offset: 0 });
  if (!project.ok) throw new Error(project.error.message);

  // A memory can be in several sets (drawn from a person's note and about them, say); it counts
  // once, in the first: the node's own, then about it, then its project's.
  const found = new Map<number, BearingMemory>();
  for (const row of own.slice(0, NODE_LIMIT)) found.set(row.id, bearing(toMemory(row), 'node'));
  for (const memory of subject.data.memories.slice(0, SUBJECT_LIMIT)) {
    if (!found.has(memory.id)) found.set(memory.id, bearing(memory, 'subject'));
  }
  for (const memory of project.data.memories.slice(0, PROJECT_LIMIT)) {
    if (!found.has(memory.id)) found.set(memory.id, bearing(memory, 'project'));
  }
  const ordered = [...found.values()].sort(compare);
  // Past any limit, a memory no other fetch brought is one left out. A memory drawn from the node
  // is in several sets, so the project's 31st may be the node's own and leave nothing out.
  const leftOut = [
    ...own.slice(NODE_LIMIT), ...subject.data.memories.slice(SUBJECT_LIMIT), ...project.data.memories.slice(PROJECT_LIMIT),
  ].some(m => !found.has(m.id));

  const memories: BearingMemory[] = [];
  let chars = 0;
  for (const memory of ordered) {
    chars += memory.content.length;
    if (memories.length > 0 && chars > BEARING_CHAR_CAP) break;
    memories.push(memory);
  }
  return {
    memories,
    memory_stats: {
      returned: memories.length,
      considered: ordered.length,
      truncated: memories.length < ordered.length || leftOut,
    },
  };
}
