import { describe, expect, it } from 'vitest';
import { gatherHomeReads } from '../src/curate.js';
import type { Config } from '../src/config.js';
import type { Engine } from '../src/engine.js';
import type { EvidenceMeeting, ProjectEvidence } from '../src/types.js';

function ev(over: Partial<ProjectEvidence> = {}): ProjectEvidence {
  return {
    project: { id: 'p1', title: 'Demo', file_path: 'Projects/Demo.md', status: 'in-progress' },
    tasks: { open: [], overdue: [], blocked: [], upcoming: [], backlog: [], done_recent: [] },
    notes: [],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    meetings: { recent: [], upcoming: [] },
    contacts: { people: [], companies: [] },
    existing_wiki: { home_id: null, subpages: [] },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    evidence_hash: 'h',
    generated_at: '2026-06-06T00:00:00Z',
    ...over,
  };
}

const config = (over: Partial<Config> = {}): Config =>
  ({
    meetingReads: 10, noteReads: 6, bodyCharCap: null,
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
    ...over,
  } as Config);

const meeting = (id: string): EvidenceMeeting => ({ id, title: id, date: null, file_mtime: null, attendees: [] });

function stubEngine(opts: { fail?: Set<string> } = {}) {
  const reads: string[] = [];
  const engine = {
    getNode: async (id: string) => {
      reads.push(id);
      if (opts.fail?.has(id)) throw new Error('unreadable');
      return { id, title: `T:${id}`, types: id.startsWith('m') ? ['meeting'] : ['note'], fields: {}, body: `body-${id}` };
    },
  };
  return { engine: engine as unknown as Engine, reads };
}

describe('gatherHomeReads', () => {
  it('reads context, then meetings, then fresh notes, in order', async () => {
    const evidence = ev({
      existing_wiki: { home_id: 'home1', subpages: [] },
      meetings: { recent: [meeting('m1'), meeting('m2')], upcoming: [] },
      notes: [{ id: 'n1', title: 'N1' }, { id: 'n2', title: 'N2' }],
    });
    const { engine, reads } = stubEngine();
    const out = await gatherHomeReads(engine, evidence, config());
    expect(reads).toEqual(['p1', 'home1', 'm1', 'm2', 'n1', 'n2']);
    expect(out.map((n) => n.id)).toEqual(['p1', 'home1', 'm1', 'm2', 'n1', 'n2']);
    expect(out.find((n) => n.id === 'm1')!.reason).toMatch(/meeting/i);
  });

  it('dedups a node present in both meetings and notes (read once)', async () => {
    const evidence = ev({
      meetings: { recent: [meeting('m1')], upcoming: [] },
      notes: [{ id: 'm1', title: 'M1 also a note' }, { id: 'n1', title: 'N1' }],
    });
    const { engine, reads } = stubEngine();
    const out = await gatherHomeReads(engine, evidence, config());
    expect(reads).toEqual(['p1', 'm1', 'n1']);
    expect(out.filter((n) => n.id === 'm1')).toHaveLength(1);
  });

  it('respects meetingReads and noteReads caps', async () => {
    const evidence = ev({
      meetings: { recent: [meeting('m1'), meeting('m2'), meeting('m3')], upcoming: [] },
      notes: [{ id: 'n1', title: 'N1' }, { id: 'n2', title: 'N2' }, { id: 'n3', title: 'N3' }],
    });
    const { engine, reads } = stubEngine();
    await gatherHomeReads(engine, evidence, config({ meetingReads: 2, noteReads: 1 }));
    expect(reads).toEqual(['p1', 'm1', 'm2', 'n1']);
  });

  it('reads newest first, a broad summary last when a specific note covers its week, and says how specific each is (#474)', async () => {
    const day = (n: number) => Date.UTC(2026, 10, n);
    const evidence = ev({
      meetings: { recent: [{ ...meeting('m1'), project_count: 9 }, meeting('m2')], upcoming: [] },
      // Newest first, as the Engine lists them.
      notes: [
        { id: 'n-summary', title: 'Weekly summary', project_count: 7, file_mtime: day(14) },
        { id: 'n-pair', title: 'Alpha and Beta sync', project_count: 2, file_mtime: day(12) },
        { id: 'n-alpha', title: 'Alpha pricing', project_count: 1, file_mtime: day(10) },
        { id: 'n-older', title: 'Alpha kickoff', project_count: 1, file_mtime: day(1) },
      ],
    });
    const { engine, reads } = stubEngine();
    const out = await gatherHomeReads(engine, evidence, config());
    // Meetings keep their newest-first order whatever their counts; the summary's week is covered.
    expect(reads).toEqual(['p1', 'm1', 'm2', 'n-pair', 'n-alpha', 'n-older', 'n-summary']);
    const reason = (id: string) => out.find(n => n.id === id)?.reason;
    expect(reason('m1')).toBe('Recent project meeting (summary + action items).');
    expect(reason('n-alpha')).toBe('Associated note, filed under 1 project.');
    expect(reason('n-pair')).toBe('Associated note, filed under 2 projects.');
    expect(reason('n-summary')).toMatch(/^Associated note, filed under 7 projects: a broad summary; prefer a project-specific note/);

    const capped = stubEngine();
    await gatherHomeReads(capped.engine, evidence, config({ noteReads: 2 }));
    expect(capped.reads).toEqual(['p1', 'm1', 'm2', 'n-pair', 'n-alpha']);
  });

  it('keeps a broad summary in its place when no specific note covers its week (#474)', async () => {
    const day = (n: number) => Date.UTC(2026, 10, n);
    const evidence = ev({
      notes: [
        { id: 'n-summary', title: 'Weekly summary', project_count: 7, file_mtime: day(28) },
        { id: 'n-old-summary', title: 'Older summary', project_count: 5, file_mtime: day(12) },
        { id: 'n-alpha', title: 'Alpha pricing', project_count: 1, file_mtime: day(10) },
        { id: 'n-older', title: 'Alpha kickoff', project_count: 1, file_mtime: day(1) },
      ],
    });
    const { engine, reads } = stubEngine();
    await gatherHomeReads(engine, evidence, config({ noteReads: 2 }));
    // The newest summary is the only word on its week, so it is read; the older one is covered.
    expect(reads).toEqual(['p1', 'n-summary', 'n-alpha']);
  });

  it('keeps newest first and the old reason for notes without a count (an older Engine)', async () => {
    const evidence = ev({
      notes: [{ id: 'n1', title: 'N1' }, { id: 'n2', title: 'N2', project_count: 1 }, { id: 'n3', title: 'N3' }],
    });
    const { engine, reads } = stubEngine();
    const out = await gatherHomeReads(engine, evidence, config());
    expect(reads).toEqual(['p1', 'n1', 'n2', 'n3']);
    expect(out.find(n => n.id === 'n1')?.reason).toBe('Recent associated note.');
  });

  it('skips an unreadable node without failing the gather', async () => {
    const evidence = ev({
      meetings: { recent: [meeting('m1')], upcoming: [] },
      notes: [{ id: 'n1', title: 'N1' }],
    });
    const { engine } = stubEngine({ fail: new Set(['m1']) });
    const out = await gatherHomeReads(engine, evidence, config());
    expect(out.map((n) => n.id)).toEqual(['p1', 'n1']);
  });

  it('reads only the project root when buckets are empty and there is no wiki home', async () => {
    const { engine, reads } = stubEngine();
    await gatherHomeReads(engine, ev(), config());
    expect(reads).toEqual(['p1']);
  });

  it('labels the prior wiki read as context-only, not authoritative', async () => {
    const { engine } = stubEngine();
    const reads = await gatherHomeReads(engine, ev({ existing_wiki: { home_id: 'home1', subpages: [] } }), config());
    const home = reads.find(r => r.id === 'home1');
    expect(home?.reason).toMatch(/CONTEXT ONLY|not authoritative/i);
  });

  it('uses the catalog home projection without a separate field read', async () => {
    const reads: string[] = [];
    const readNodeFields = async (): Promise<Record<string, unknown>> => {
      throw new TypeError('field reads are not part of home evidence gathering');
    };
    const engine = {
      getNode: async (id: string) => {
        reads.push(id);
        return { id, title: id, types: ['wiki'], fields: {}, body: '' };
      },
      readNodeFields,
    } as unknown as Engine;

    await gatherHomeReads(engine, ev({ existing_wiki: { home_id: 'catalog-home', subpages: [] } }), config());

    expect(reads).toEqual(['p1', 'catalog-home']);
  });
});
