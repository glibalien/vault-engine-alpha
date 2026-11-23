import type { ContextProvider, ContextProviderInput, ContextSection } from './types.js';
import { parseEnvelope } from '../tools.js';

const MEMORIES_CHAR_CAP = 6000; // ~1.5k tokens
const HEADER = '### Memories';

/** §5 read union (decision 14): exactly these sources are injected.
 *  Write-side silos stay — this list never widens implicitly.
 *  'owner' added for the durable-memory markdown projection (Task 5):
 *  owner-authored memories from Settings/Memories.md join chat consumption
 *  explicitly, alongside chat and curator memories. 'claude' added by the
 *  owner's decision on #352 (2026-11-09): what claude.ai saves with
 *  create-memory never reached chat before. The Engine returns memories with
 *  get-node / project-evidence reads from the same list (#560): keep
 *  READER_MEMORY_SOURCES in packages/engine/src/memories/bearing.ts equal to it. */
const INJECTED_SOURCES = ['chat', 'curator', 'owner', 'claude'] as const;

/** The open note's project memories (#352): memories drawn from notes filed under
 *  the same project, from every source. */
const PROJECT_LIMIT = 30;
/** The memories about the open note (#554): those naming it as a subject, a person or a
 *  company, from every source and any note or chat. */
const SUBJECT_LIMIT = 30;

interface Memory {
  id: number;
  content: string;
  category: string | null;
  scope: 'vault' | 'node';
  node_id: string | null;
  created_at: string;
  /** When it became true: a note memory's note day (#706). The recency order's key; an Engine
   *  from before returns rows with it set to `created_at`, or not at all. */
  valid_at?: string | null;
}

function formatLine(m: Memory): string {
  const cat = m.category ? `[${m.category}] ` : '';
  return `- ${cat}${m.content}`;
}

/** The open note's sets: memories about it (#554) and its project's (#352). */
interface OpenNoteSets {
  subject: ReadonlySet<number>;
  project: ReadonlySet<number>;
}

/** Tier 0 = durable steering the model must always see first (§5 decision 13): preferences,
 *  corrections and rules on what to say (#626); tier 1 = memories about the open note, a person
 *  or a company (#554); tier 2 = the open note's project memories (#352); tier 3 = everything
 *  else. */
function tierOf(m: Memory, sets: OpenNoteSets): number {
  if (m.category === 'preference' || m.category === 'correction' || m.category === 'rule') return 0;
  if (sets.subject.has(m.id)) return 1;
  return sets.project.has(m.id) ? 2 : 3;
}

/** Priority order: preference/correction/rule first, then the memories about the open note,
 *  then its project's, then everything else; recency within each tier (valid_at, else
 *  created_at; ISO strings compare lexically); id as deterministic tie-break. */
function byTierThenRecency(sets: OpenNoteSets) {
  return (a: Memory, b: Memory): number => compareTiered(a, b, sets);
}

function compareTiered(a: Memory, b: Memory, sets: OpenNoteSets): number {
  const t = tierOf(a, sets) - tierOf(b, sets);
  if (t !== 0) return t;
  // Recency is when each became true (#706), as the Engine lists them: a fact from an old note
  // read today is not new.
  const aWhen = a.valid_at ?? a.created_at;
  const bWhen = b.valid_at ?? b.created_at;
  if (aWhen !== bWhen) return aWhen < bWhen ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return b.id - a.id;
}

/** One source+scope fetch; a failed envelope contributes nothing (a memories
 *  outage must never take down context assembly). */
async function fetchMemories(
  call: ContextProviderInput['call'],
  args: Record<string, unknown>,
): Promise<Memory[]> {
  const env = parseEnvelope(await call('list-memories', args)) as {
    ok?: boolean;
    data?: { memories?: Memory[] };
  };
  return env.ok && env.data ? (env.data.memories ?? []) : [];
}

function render(lines: string[], hidden: number): string {
  const header = hidden > 0 ? `${HEADER} (+${hidden} older not shown)` : HEADER;
  return `${header}\n${lines.join('\n')}`;
}

/** Fetches the §5 union (vault-scoped always; node-scoped, the memories about the open note and
 *  its project's when a docId is present), tiers preference/correction/rule first, then those
 *  about the note, then the project's, and self-caps at
 *  MEMORIES_CHAR_CAP on entry boundaries — dropped entries are counted in the
 *  header, never cut mid-line. assembleContext applies no overall cap. */
export const memoriesProvider: ContextProvider = {
  key: 'memories',
  async build({ call, manifest, estimateTokens }): Promise<ContextSection | null> {
    const all: Memory[] = [];
    for (const source of INJECTED_SOURCES) {
      all.push(...(await fetchMemories(call, { source, scope: 'vault', limit: 50 })));
    }
    const subject = new Set<number>();
    const project = new Set<number>();
    if (manifest.docId) {
      for (const source of INJECTED_SOURCES) {
        all.push(...(await fetchMemories(call, { source, scope: 'node', node_id: manifest.docId, limit: 20 })));
      }
      for (const m of await fetchMemories(call, { subject_of: manifest.docId, limit: SUBJECT_LIMIT })) {
        subject.add(m.id);
        all.push(m);
      }
      for (const m of await fetchMemories(call, { project_of: manifest.docId, limit: PROJECT_LIMIT })) {
        project.add(m.id);
        all.push(m);
      }
    }
    if (!all.length) return null;

    // A memory can arrive from two fetches; keep it once.
    const unique = [...new Map(all.map((m) => [m.id, m])).values()];
    unique.sort(byTierThenRecency({ subject, project }));
    const lines = unique.map(formatLine);

    let text = render(lines, 0);
    if (text.length > MEMORIES_CHAR_CAP) {
      // Entry-boundary truncation: entries are priority-ordered, so keep the
      // longest prefix that fits (greedy — never skip ahead to a smaller,
      // lower-priority entry) and count the dropped tail in the header.
      let fitted: string | null = null;
      for (let keep = lines.length - 1; keep >= 1; keep--) {
        const candidate = render(lines.slice(0, keep), lines.length - keep);
        if (candidate.length <= MEMORIES_CHAR_CAP) {
          fitted = candidate;
          break;
        }
      }
      // Degenerate input: the single top-priority entry alone exceeds the cap
      // (contents may be 10k, the cap is 6k). Boundary truncation is impossible
      // here — hard-slice that one entry rather than inject nothing (only path
      // that may cut mid-line; unreachable for normal stock).
      text = fitted ?? `${render(lines.slice(0, 1), lines.length - 1).slice(0, MEMORIES_CHAR_CAP)}\n…`;
    }

    return { label: 'memories', text, tokens: estimateTokens(text) };
  },
};
