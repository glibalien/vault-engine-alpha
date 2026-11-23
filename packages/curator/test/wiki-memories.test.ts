import { describe, expect, it, vi } from 'vitest';
import { ftsPhrase, memoryDay, NAME_MATCH_CEILING, SUBJECT_MEMORY_LIMIT, SUBJECT_NOTE_LIMIT, selectWikiMemories } from '../src/wiki-memories.js';
import type { Memory } from '../src/types.js';

const mem = (id: number, over: Partial<Memory> = {}): Memory => ({
  id, source: 'curator', scope: 'vault', node_id: null, content: `memory ${id}`, category: 'fact',
  created_at: '2026-10-01', updated_at: '2026-10-01', ...over,
});

type Filters = Record<string, unknown>;

/** An Engine answering list-memories by which filter the selector used. */
function engine(answer: (filters: Filters) => { memories: Memory[]; total: number | null }) {
  const calls: Filters[] = [];
  return { calls, listMemoriesWithTotal: vi.fn(async (filters: Filters) => { calls.push(filters); return answer(filters); }) };
}

describe('ftsPhrase', () => {
  it('quotes a name as one phrase and drops what cannot match', () => {
    expect(ftsPhrase('Acme Corp')).toBe('"Acme Corp"');
    expect(ftsPhrase('  "Quoted"  name ')).toBe('"Quoted name"');
    expect(ftsPhrase('—')).toBeNull();
    expect(ftsPhrase('')).toBeNull();
  });
});

describe('selectWikiMemories (#297)', () => {
  const subject = { rootId: 'root', homeId: 'home', names: ['Acme Opportunity', 'Acme', 'Employer'], evidenceNodeIds: ['n1', 'n2', 'n1'] };

  it("selects the owner's memories, then the subject's: scoped to it, drawn from its notes, or naming it", async () => {
    const e = engine(f => {
      if (f.source === 'owner') return { memories: [mem(1, { source: 'owner' })], total: 1 };
      if (f.node_id === 'root') return { memories: [mem(2, { scope: 'node', node_id: 'root', source: 'chat' })], total: 1 };
      if (f.node_id === 'home') return { memories: [mem(3, { scope: 'node', node_id: 'home' })], total: 1 };
      if (f.evidence_node_ids) return { memories: [mem(4), mem(5)], total: 2 };
      if (f.query === '"Acme"') return { memories: [mem(5), mem(6, { source: 'chat' })], total: 2 };
      if (f.query === '"Employer"') return { memories: [mem(7)], total: NAME_MATCH_CEILING + 1 };
      return { memories: [], total: 0 };
    });
    const out = await selectWikiMemories(e, subject, { includeProvenance: true });
    expect(out.memories.map(m => m.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.commonNames).toEqual(['Employer']);
    expect(out.omitted).toBe(0);
    expect(e.calls).toContainEqual(expect.objectContaining({ scope: 'vault', evidence_node_ids: ['n1', 'n2'], includeProvenance: true }));
    expect(e.calls.filter(f => f.query).map(f => [f.query, f.scope])).toEqual([
      ['"Acme Opportunity"', 'vault'], ['"Acme"', 'vault'], ['"Employer"', 'vault'],
    ]);
    // No newest-N listing of every vault memory any more.
    expect(e.calls.some(f => f.source === 'curator' && f.scope === 'vault' && !f.query && !f.evidence_node_ids)).toBe(false);
  });

  it('keeps the most direct memories when the subject has more than the limit, and counts the rest', async () => {
    const many = Array.from({ length: 30 }, (_, i) => mem(100 + i));
    const e = engine(f => {
      if (f.source === 'owner') return { memories: [], total: 0 };
      if (f.node_id === 'root') return { memories: [mem(1, { scope: 'node' })], total: 1 };
      if (f.category === 'rule') return { memories: [], total: 0 };
      if (f.evidence_node_ids) return { memories: many, total: 45 };
      if (f.query === '"Acme"') return { memories: Array.from({ length: 20 }, (_, i) => mem(200 + i)), total: 20 };
      return { memories: [], total: 0 };
    });
    const out = await selectWikiMemories(e, subject, { includeProvenance: false });
    expect(out.memories).toHaveLength(SUBJECT_MEMORY_LIMIT);
    expect(out.memories[0]!.id).toBe(1);
    expect(out.omitted).toBe((1 + 30 + 20 - SUBJECT_MEMORY_LIMIT) + (45 - 30));
    expect(e.calls.every(f => !('includeProvenance' in f))).toBe(true);
  });

  it("ranks memories from the build's related notes after its direct, evidence and name matches", async () => {
    const e = engine(f => {
      if (f.source === 'owner') return { memories: [], total: 0 };
      const ids = f.evidence_node_ids as string[] | undefined;
      if (ids?.includes('gap')) return { memories: [mem(9)], total: 1 };
      if (ids) return { memories: [mem(4)], total: 1 };
      if (f.query === '"Acme"') return { memories: [mem(6)], total: 1 };
      return { memories: [], total: 0 };
    });
    const out = await selectWikiMemories(e, { ...subject, relatedNodeIds: ['gap', 'n1'] }, { includeProvenance: false });
    expect(out.memories.map(m => m.id)).toEqual([4, 6, 9]);
    expect(e.calls).toContainEqual(expect.objectContaining({ evidence_node_ids: ['gap'] })); // n1 is already evidence
  });

  it("puts the rules on what to say first, asking the build's notes for theirs on their own (#626)", async () => {
    const many = Array.from({ length: SUBJECT_MEMORY_LIMIT }, (_, i) => mem(100 + i));
    const oldRule = mem(7, { category: 'rule', content: 'Never call it NCL' });
    const namedRule = mem(8, { category: 'rule', content: 'No launch date for Acme' });
    const relatedRule = mem(9, { category: 'rule' });
    const e = engine(f => {
      if (f.source === 'owner') return { memories: [], total: 0 };
      const ids = f.evidence_node_ids as string[] | undefined;
      if (ids?.includes('gap')) return { memories: [relatedRule], total: 1 };
      // Newer memories fill the evidence listing; the rule is past its limit there.
      if (f.category === 'rule') return { memories: [oldRule], total: 1 };
      if (ids) return { memories: many, total: SUBJECT_MEMORY_LIMIT + 1 };
      if (f.query === '"Acme"') return { memories: [mem(6), namedRule], total: 2 };
      return { memories: [], total: 0 };
    });
    const out = await selectWikiMemories(e, { ...subject, relatedNodeIds: ['gap'] }, { includeProvenance: false });
    expect(out.memories).toHaveLength(SUBJECT_MEMORY_LIMIT);
    // A rule from a related note is a lead, not the subject's: it keeps its place, last.
    expect(out.memories.slice(0, 3).map(m => m.id)).toEqual([7, 8, 100]);
    expect(out.memories.map(m => m.id)).not.toContain(9);
    expect(e.calls).toContainEqual(expect.objectContaining({ scope: 'vault', evidence_node_ids: ['n1', 'n2'], category: 'rule' }));
  });

  it('makes no node, evidence or name query it has nothing for', async () => {
    const e = engine(() => ({ memories: [], total: 0 }));
    await selectWikiMemories(e, { rootId: null, homeId: null, projectId: 'root', names: ['  '], evidenceNodeIds: [] }, { includeProvenance: false });
    expect(e.calls).toEqual([{ source: 'owner', scope: 'vault', limit: 50 }]);
  });
});

describe('selectWikiMemories: a project takes its evidence memories most specific first (#551)', () => {
  const subject = { rootId: 'root', homeId: 'home', projectId: 'root', names: [], evidenceNodeIds: ['own', 'summary', 'contact'] };

  it("puts memories from the project's own notes ahead of newer ones from summary notes", async () => {
    // The Engine's project set: the project's own meeting (older), then a summary note's memory.
    const own = Array.from({ length: 3 }, (_, i) => mem(10 + i));
    const summary = Array.from({ length: SUBJECT_MEMORY_LIMIT }, (_, i) => mem(100 + i));
    const e = engine(f => {
      if (f.source === 'owner') return { memories: [], total: 0 };
      if (f.project_of === 'root') return { memories: [...own, ...summary].slice(0, SUBJECT_MEMORY_LIMIT), total: own.length + summary.length };
      // Newest first: the summary note's memories fill the limit; one comes from a contact's note.
      if (f.evidence_node_ids) return { memories: [mem(500), ...summary].slice(0, SUBJECT_MEMORY_LIMIT), total: 1 + summary.length + own.length };
      return { memories: [], total: 0 };
    });
    const out = await selectWikiMemories(e, subject, { includeProvenance: true });
    expect(out.memories.slice(0, 3).map(m => m.id)).toEqual([10, 11, 12]);
    expect(out.memories).toHaveLength(SUBJECT_MEMORY_LIMIT);
    expect(out.omitted).toBeGreaterThan(0);
    expect(e.calls).toContainEqual({ includeProvenance: true, scope: 'vault', evidence_node_ids: ['own', 'summary', 'contact'],
      project_of: 'root', limit: SUBJECT_MEMORY_LIMIT });
  });

  it('adds the evidence memories outside the project set after it', async () => {
    const e = engine(f => {
      if (f.source === 'owner') return { memories: [], total: 0 };
      if (f.project_of === 'root') return { memories: [mem(10), mem(100)], total: 2 };
      if (f.evidence_node_ids) return { memories: [mem(500), mem(100), mem(10)], total: 3 };
      return { memories: [], total: 0 };
    });
    const out = await selectWikiMemories(e, subject, { includeProvenance: false });
    expect(out.memories.map(m => m.id)).toEqual([10, 100, 500]);
    expect(out.omitted).toBe(0);
  });

  it('keeps node-scoped memories first and never asks for a project set without a project', async () => {
    const e = engine(f => {
      if (f.node_id === 'root') return { memories: [mem(1, { scope: 'node', node_id: 'root' })], total: 1 };
      if (f.project_of === 'root') return { memories: [mem(10)], total: 1 };
      return { memories: [], total: 0 };
    });
    expect((await selectWikiMemories(e, subject, { includeProvenance: false })).memories.map(m => m.id)).toEqual([1, 10]);

    const topic = engine(() => ({ memories: [], total: 0 }));
    await selectWikiMemories(topic, { ...subject, projectId: undefined }, { includeProvenance: false });
    expect(topic.calls.some(f => 'project_of' in f)).toBe(false);
  });
});

describe('memoryDay', () => {
  it('reads midnight UTC as a day with no time, in any zone (#706)', () => {
    const newYork = memoryDay('America/New_York');
    expect(newYork('2026-11-18T00:00:00.000Z')).toBe('2026-11-18');
    expect(newYork('2026-11-01T00:00:00Z')).toBe('2026-11-01');
    expect(memoryDay('Asia/Tokyo')('2026-11-18T00:00:00.000Z')).toBe('2026-11-18');
  });

  it('reads any other time in the Curator zone', () => {
    expect(memoryDay('America/New_York')('2026-11-18T02:00:00.000Z')).toBe('2026-11-17');
    expect(memoryDay('Asia/Tokyo')('2026-11-18T20:00:00.000Z')).toBe('2026-11-19');
  });
});

describe('selectWikiMemories reads memories by subject (#719)', () => {
  const subject = {
    rootId: 'proj', homeId: null, projectId: 'proj', names: ['Acme Opportunity', 'Acme'], evidenceNodeIds: ['n1'],
    subjectNoteIds: ['proj'], relatedSubjectIds: ['acme', 'dana', 'proj'],
  };
  const answers = (f: Filters) => {
    if (f.source === 'owner') return { memories: [], total: 0 };
    if (f.subject_of === 'proj') return { memories: [mem(10, { content: 'the pilot moved to May' }), mem(11, { category: 'rule' })], total: 2 };
    if (f.subject_of === 'acme') return { memories: [mem(20)], total: 1 };
    if (f.subject_of === 'dana') return { memories: [mem(30), mem(4)], total: 2 };
    if (f.evidence_node_ids && f.project_of) return { memories: [mem(3)], total: 1 };
    if (f.evidence_node_ids && f.category !== 'rule') return { memories: [mem(4)], total: 1 };
    if (f.query === '"Acme"') return { memories: [mem(50)], total: 1 };
    return { memories: [], total: 0 };
  };

  it('reads the project\'s own set before its evidence, its companies and people after, and the name search last', async () => {
    const e = engine(answers);
    const out = await selectWikiMemories(e, subject, { includeProvenance: false });
    // A rule first; then the project's specific evidence, its own set, the evidence, its companies and people, the names.
    expect(out.memories.map(m => m.id)).toEqual([11, 3, 10, 4, 20, 30, 50]);
    expect(e.calls.filter(f => f.subject_of).map(f => [f.subject_of, f.limit])).toEqual([
      ['proj', SUBJECT_MEMORY_LIMIT], ['acme', SUBJECT_MEMORY_LIMIT], ['dana', SUBJECT_MEMORY_LIMIT],
    ]);
  });

  it('bounds the subject reads, most direct first', async () => {
    const e = engine(() => ({ memories: [], total: 0 }));
    const many = Array.from({ length: 30 }, (_, i) => `p${i}`);
    await selectWikiMemories(e, { ...subject, relatedSubjectIds: many }, { includeProvenance: false });
    const read = e.calls.filter(f => f.subject_of).map(f => f.subject_of);
    expect(read).toHaveLength(SUBJECT_NOTE_LIMIT);
    expect(read[0]).toBe('proj');
  });

  it('still finds a memory only the name search reaches, under its ceiling', async () => {
    const e = engine(f => (f.query === '"Acme Opportunity"' ? { memories: [mem(60)], total: 1 }
      : f.query === '"Acme"' ? { memories: [mem(61)], total: NAME_MATCH_CEILING + 1 } : { memories: [], total: 0 }));
    const out = await selectWikiMemories(e, subject, { includeProvenance: false });
    expect(out.memories.map(m => m.id)).toEqual([60]);
    expect(out.commonNames).toEqual(['Acme']);
  });
});

describe('a failed subject read (Codex, #727)', () => {
  it('rejects the selection, with no read left unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const engine = { listMemoriesWithTotal: async (filters: { subject_of?: string; source?: string }) => {
        if (filters.subject_of) throw new Error('subject read failed');
        await new Promise(resolve => setTimeout(resolve, 20));
        return { memories: [], total: 0 };
      } };
      await expect(selectWikiMemories(engine as never, { names: ['Northwind'], rootId: null, homeId: null, evidenceNodeIds: ['n1'], subjectNoteIds: ['proj'] },
        { includeProvenance: false })).rejects.toThrow('subject read failed');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('a project\'s notes around it, for its subject reads (#719)', () => {
  it('takes its companies, then the people on its own note, and not the people only met in its meetings', async () => {
    const { projectSubjectIds } = await import('../src/home-evidence.js');
    const evidence = { contacts: {
      companies: [{ id: 'northwind', title: 'Northwind' }],
      people: [
        { id: 'dana', title: 'Dana Whitfield', companies: [], direct: true, meeting_count: 2 },
        { id: 'lee', title: 'Lee Okafor', companies: [], direct: false, meeting_count: 5 },
      ],
    } } as never;
    expect(projectSubjectIds(evidence)).toEqual(['northwind', 'dana']);
    expect(projectSubjectIds({} as never)).toEqual([]);
  });
});
