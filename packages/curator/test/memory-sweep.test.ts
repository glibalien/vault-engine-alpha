import { describe, expect, it, vi } from 'vitest';
import { ProviderSpendLimitError } from '../src/provider-limits.js';
import { EXTRACT_TOOL, EXTRACT_SYSTEM_PROMPT, parseExtractedFacts, parseUnsupportedIds, buildExtractionUser, noteDate, noteDateLine } from '../src/memory-sweep.js';
import type { Memory } from '../src/types.js';
import Database from 'better-sqlite3';
import { ENGINE_KEY_SPENT_STOP, runMemorySweep, SWEEP_EXTRACTION_CAP, type MemorySweepDeps } from '../src/memory-sweep.js';
import { runMigrations } from '../src/db/migrate.js';
import { upsertLedger, ledgerHash, lastSweepAt } from '../src/db/memory-sweep.js';
import { CurationQueue } from '../src/queue.js';
import { EngineError, type Engine } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';
import { renderCaptureBlock } from '../src/conversation-capture-markers.js';
import { CONVERSATION_EXTRACT_SYSTEM_PROMPT } from '../src/conversation-sweep.js';
import { ownerName } from '../src/memory-extract.js';

const known: Memory[] = [
  { id: 1, source: 'curator', scope: 'vault', node_id: null, content: 'Avery lives in Chicago', category: 'fact', created_at: 't', updated_at: 't' },
];

describe('parseExtractedFacts', () => {
  it('parses facts, defaults category, drops malformed, caps at noteCap', () => {
    const out = parseExtractedFacts({
      facts: [
        { content: '  Fact A  ' },
        { content: 'Fact B', category: 'preference' },
        { content: '' },            // dropped: empty
        { nope: true },             // dropped: malformed
        { content: 'Fact C' },
        { content: 'Fact D' },      // dropped: beyond cap 3
      ],
    }, 3);
    expect(out).toEqual([
      { content: 'Fact A', category: 'fact' },
      { content: 'Fact B', category: 'preference' },
      { content: 'Fact C', category: 'fact' },
    ]);
  });

  it('keeps a rule label, and the schema and prompt offer it (#626)', () => {
    expect(parseExtractedFacts({ facts: [{ content: 'Never call it NCL', category: 'rule' }] }, 3))
      .toEqual([{ content: 'Never call it NCL', category: 'rule' }]);
    const facts = EXTRACT_TOOL.schema.properties as Record<string, { items: { properties: { category: { enum: string[] } } } }>;
    expect(facts.facts!.items.properties.category.enum).toEqual(['fact', 'preference', 'rule', 'note']);
    expect(EXTRACT_SYSTEM_PROMPT).toContain('Give each one the category "rule".');
    expect(CONVERSATION_EXTRACT_SYSTEM_PROMPT).toContain('Give each one the category "rule".');
  });

  it('keeps each fact\'s subjects, trimmed, once each and at most 20, and asks for full names without the owner (#554)', () => {
    const out = parseExtractedFacts({ facts: [
      { content: 'Dana leads the pilot', subjects: [' Dana Okafor ', 'dana okafor', 'Northwind', '', 7] },
      { content: 'Avery likes tea', subjects: [] },
      { content: 'Many', subjects: Array.from({ length: 25 }, (_, i) => `N${i}`) },
    ] }, 3);
    expect(out[0]).toEqual({ content: 'Dana leads the pilot', category: 'fact', subjects: ['Dana Okafor', 'Northwind'] });
    expect(out[1]).toEqual({ content: 'Avery likes tea', category: 'fact' });
    expect(out[2]!.subjects).toHaveLength(20);
    const facts = EXTRACT_TOOL.schema.properties as Record<string, { items: { properties: Record<string, unknown> } }>;
    expect(facts.facts!.items.properties.subjects).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(EXTRACT_SYSTEM_PROMPT).toContain('by its full name as the note gives it');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('Never list the vault\'s owner');
    expect(CONVERSATION_EXTRACT_SYSTEM_PROMPT).toContain('Never list the user.');
  });

  it('names the vault owner at the top of the request, when the vault map has one (#554)', () => {
    const note = { title: 'Standup', file_path: 'Meetings/standup.md', body: 'Body' };
    expect(buildExtractionUser(note, [], 3, null, [], new Date(), undefined, 'Avery Stone')).toMatch(/^VAULT OWNER \(never a subject\): Avery Stone\nNOTE: Standup/);
    expect(buildExtractionUser(note, [], 3, null)).toMatch(/^NOTE: Standup/);
    expect(ownerName('[[Avery Stone|me]]')).toBe('Avery Stone');
    expect(ownerName('  ')).toBeNull();
    expect(ownerName(null)).toBeNull();
  });

  it('returns [] for non-object output or missing facts', () => {
    expect(parseExtractedFacts(null, 3)).toEqual([]);
    expect(parseExtractedFacts('x', 3)).toEqual([]);
    expect(parseExtractedFacts({}, 3)).toEqual([]);
  });
});

describe('buildExtractionUser', () => {
  const note = { title: 'Standup 2026-07-08', file_path: 'Meetings/standup.md', body: 'Body text here' };

  it('includes known block, title, path, cap, and body', () => {
    const user = buildExtractionUser(note, known, 3, null);
    expect(user).toContain('ALREADY KNOWN');
    expect(user).toContain('- Avery lives in Chicago');
    expect(user).toContain('NOTE: Standup 2026-07-08');
    expect(user).toContain('PATH: Meetings/standup.md');
    expect(user).toContain('at most 3 facts');
    expect(user).toContain('Body text here');
  });

  it('omits the known block when there are no known memories', () => {
    expect(buildExtractionUser(note, [], 3, null)).not.toContain('ALREADY KNOWN');
  });

  it('truncates the body at bodyCharCap', () => {
    const long = { ...note, body: 'x'.repeat(100) };
    const user = buildExtractionUser(long, [], 3, 10);
    expect(user).toContain('x'.repeat(10) + '\n…[truncated]');
    expect(user).not.toContain('x'.repeat(11));
  });

  it('renders the verify block with ids, before ALREADY KNOWN (spec: re-verify block construction)', () => {
    const prior = [{ id: 41, content: 'stale fact' }] as never;
    const out = buildExtractionUser({ title: 'A', file_path: 'A.md', body: 'body' }, known, 3, null, prior);
    expect(out).toContain('PREVIOUSLY EXTRACTED FROM THIS NOTE (verify)');
    expect(out).toContain('[id 41] stale fact');
    expect(out.indexOf('PREVIOUSLY EXTRACTED')).toBeLessThan(out.indexOf('ALREADY KNOWN'));
    // no prior → no block (pre-existing calls unaffected)
    expect(buildExtractionUser({ title: 'A', file_path: 'A.md', body: 'b' }, known, 3, null)).not.toContain('PREVIOUSLY EXTRACTED');
  });
});

describe('note dates (old notes describe the past)', () => {
  const now = new Date(2026, 10, 2); // 2026-11-02, local

  it('reads the date field, bare or as get-node returns it, and keeps only the day', () => {
    expect(noteDate({ date: '2020-10-30' }, 'Untitled', 'date')).toBe('2020-10-30');
    expect(noteDate({ date: { value: '2020-10-30', type: 'date', source: 'frontmatter' } }, 'Untitled', 'date')).toBe('2020-10-30');
    expect(noteDate({ date: '2020-10-30T09:15:00Z' }, 'Untitled', 'date')).toBe('2020-10-30');
  });

  it('falls back to the last real date in the title, never the file time', () => {
    expect(noteDate({}, 'Week in review 2020-10-24 to 2020-10-30', 'date')).toBe('2020-10-30');
    expect(noteDate({ date: 'someday' }, 'Standup 2019-03-04', 'date')).toBe('2019-03-04');
    expect(noteDate({ date: '2020-02-31' }, 'Plan 2020-13-01', 'date')).toBeNull(); // not real days
    expect(noteDate(undefined, 'Ideas', 'date')).toBeNull();
  });

  it('reads the vault map\'s date field; none reads only the title', () => {
    const fields = { date: '2020-10-30', written: { value: '2021-04-05' } };
    expect(noteDate(fields, 'Sync 2022-01-01', 'written')).toBe('2021-04-05');
    expect(noteDate(fields, 'Sync 2022-01-01', null)).toBe('2022-01-01');
    expect(noteDate(fields, 'Untitled', null)).toBeNull();
  });

  it('spells out the age of a note more than a year old', () => {
    expect(noteDateLine('2020-10-30', now)).toBe('NOTE DATE: 2020-10-30 (about 6 years before today)');
    expect(noteDateLine('2025-10-01', now)).toBe('NOTE DATE: 2025-10-01 (about 1 year before today)');
    expect(noteDateLine('2026-03-01', now)).toBe('NOTE DATE: 2026-03-01');
  });

  it('puts the date line in the user block only when the note has a date', () => {
    const note = { title: 'Weekly Summary', file_path: 'Notes/w.md', body: 'b' };
    expect(buildExtractionUser({ ...note, date: '2020-10-30' }, [], 3, null, [], now))
      .toContain('PATH: Notes/w.md\nNOTE DATE: 2020-10-30 (about 6 years before today)\nPER-NOTE CAP');
    expect(buildExtractionUser(note, [], 3, null, [], now)).not.toContain('NOTE DATE');
  });

  it('tells the model to date facts from old notes that may have changed', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('NOTE DATE');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('As of 2020');
  });
});

describe('parseUnsupportedIds', () => {
  it('keeps only integer candidate ids', () => {
    expect(parseUnsupportedIds({ unsupported_ids: [41, 999, 'x', 41.5] }, new Set([41, 42]))).toEqual([41]);
    expect(parseUnsupportedIds({}, new Set([41]))).toEqual([]);
    expect(parseUnsupportedIds(null, new Set())).toEqual([]);
  });
});

describe('EXTRACT_TOOL schema', () => {
  it('uses only the Fireworks-safe schema subset', () => {
    const json = JSON.stringify(EXTRACT_TOOL.schema);
    for (const banned of ['oneOf', 'pattern', 'minLength', 'maxItems', 'anyOf']) {
      expect(json).not.toContain(banned);
    }
    expect(EXTRACT_TOOL.name).toBe('extract_memories');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('durable');
  });
});

const USAGE = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };

interface FakeNote { id: string; title: string; file_path: string; body: string; hash: string; facts: string[]; mtime?: number; fields?: Record<string, unknown> }

function sweepConfig(over: Partial<Config> = {}): Config {
  return {
    model: 'test-model', bodyCharCap: null,
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
    memorySweepEnabled: true, memorySweepTypes: ['meeting'], memorySweepPaths: [],
    memorySweepCap: 10, memorySweepNoteCap: 3, memorySweepMaxTokens: 4000, memorySweepModel: null, memorySweepSince: null,
    reverifyEnabled: true, reconcileEnabled: true, reconcilePairCap: 10, reconcileModel: null,
    ...over,
  } as Config;
}

/** Fake engine + llm serving `notes`; captures create-memory writes. `calls` is a
 *  shared ordered log (`listMemories:<id>`, `expire:<id>:<reason>`, `create:<content>`)
 *  used to assert cross-call ordering (e.g. expire-before-persist). */
function fakes(
  notes: FakeNote[],
  opts: {
    truncated?: boolean;
    createError?: Error;
    priorFacts?: Record<string, Array<{ id: number; content: string }>>;
    expireError?: Error;
    priorFetchError?: Error;
    pendingMerge?: number | Error;
  } = {},
) {
  const writes: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const users: string[] = [];
  let llmCallCount = 0;
  const engine = {
    listChangedNodes: async () => ({
      nodes: notes.map(({ id, title, file_path, mtime }) => ({ id, title, file_path, ...(mtime !== undefined ? { file_mtime: mtime } : {}) })),
      truncated: opts.truncated ?? false,
    }),
    listMemoriesWithTotal: async () => ({ memories: [], total: 5 }),
    consolidationPendingTotal: async () => {
      if (opts.pendingMerge instanceof Error) throw opts.pendingMerge;
      return opts.pendingMerge ?? 0;
    },
    getNode: async (id: string) => {
      const n = notes.find(x => x.id === id);
      if (!n) throw new Error('missing');
      return { id: n.id, title: n.title, types: [], fields: n.fields ?? {}, body: n.body, metadata: { content_hash: n.hash } };
    },
    listMemories: async (f: { evidence_node_id?: string }) => {
      calls.push(`listMemories:${f.evidence_node_id}`);
      if (opts.priorFetchError) throw opts.priorFetchError;
      return (opts.priorFacts?.[f.evidence_node_id ?? ''] ?? []).map(p => ({
        id: p.id, content: p.content, source: 'curator', scope: 'vault', updated_at: 'T',
      }));
    },
    expireMemory: async (a: { id: number; reason: string }) => {
      calls.push(`expire:${a.id}:${a.reason}`);
      if (opts.expireError) throw opts.expireError;
    },
    createMemory: async (args: Record<string, unknown>) => {
      calls.push(`create:${args.content as string}`);
      if (opts.createError) throw opts.createError;
      writes.push(args);
      return { id: writes.length };
    },
  } as unknown as Engine;
  const llm: LlmClient & { unsupported?: number[] } = {
    unsupported: undefined,
    structuredCall: async (req) => {
      llmCallCount += 1;
      users.push(req.user);
      const n = notes.find(x => req.user.includes(`NOTE: ${x.title}`));
      return {
        output: {
          facts: (n?.facts ?? []).map(content => ({ content })),
          ...(llm.unsupported ? { unsupported_ids: llm.unsupported } : {}),
        },
        usage: USAGE,
      };
    },
  };
  return { engine, llm, writes, calls, users, llmCalls: () => llmCallCount };
}

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d);
  return d;
}

function deps(engine: Engine, llm: LlmClient, config: Config, d?: Database.Database): MemorySweepDeps {
  return { engine, llm, config, queue: new CurationQueue(), db: d };
}

describe('memory sweep merge backlog (#354)', () => {
  const note: FakeNote = { id: 'a', title: 'A', file_path: 'Meetings/A.md', body: 'body a', hash: 'ha', facts: ['Fact from A'] };
  const run = async (pendingMerge?: number | Error) => {
    const f = fakes([note], pendingMerge === undefined ? {} : { pendingMerge });
    const summary = vi.fn();
    const recorder = { setContext: () => {}, summary } as unknown as MemorySweepDeps['recorder'];
    const result = await runMemorySweep({ ...deps(f.engine, f.llm, sweepConfig(), db()), recorder }, { dryRun: false, trigger: 'scheduled' });
    return { result, line: summary.mock.calls[0]?.[1] as string, metadata: summary.mock.calls[0]?.[2] as Record<string, unknown> };
  };

  it('shows the memories still waiting for a replay in the summary and its metadata', async () => {
    const { result, line, metadata } = await run(12);
    expect(result.pendingMerge).toBe(12);
    expect(line).toContain('12 waiting for replay-memory-consolidation');
    expect(metadata['pendingMerge']).toBe(12);
  });

  it('adds nothing to the line when the backlog is empty', async () => {
    const { line, metadata } = await run(0);
    expect(line).not.toContain('replay-memory-consolidation');
    expect(metadata['pendingMerge']).toBe(0);
  });

  it('finishes the sweep when the count is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result, line, metadata } = await run(new Error('engine down'));
      expect(result).toMatchObject({ written: 1, pendingMerge: null });
      expect(line).not.toContain('replay-memory-consolidation');
      expect('pendingMerge' in metadata).toBe(false);
    } finally { warn.mockRestore(); }
  });
});

describe('runMemorySweep', () => {
  const noteA: FakeNote = { id: 'a', title: 'A', file_path: 'Meetings/A.md', body: 'body a', hash: 'ha', facts: ['Fact from A'] };
  const noteB: FakeNote = { id: 'b', title: 'B', file_path: 'Meetings/B.md', body: 'body b', hash: 'hb', facts: ['Fact from B'] };
  const noteEmpty: FakeNote = { id: 'e', title: 'E', file_path: 'Meetings/E.md', body: 'nothing', hash: 'he', facts: [] };

  it('stops after 3 identical provider rejections; the rest stay unledgered for the next run (#254)', async () => {
    const notes: FakeNote[] = [1, 2, 3, 4, 5, 6].map(i => ({ id: `n${i}`, title: `N${i}`, file_path: `Meetings/N${i}.md`, body: `body ${i}`, hash: `h${i}`, facts: [`Fact ${i}`] }));
    const f = fakes(notes);
    let calls = 0;
    f.llm.structuredCall = async () => {
      calls += 1;
      throw Object.assign(new Error('400 Provider returned error'), {
        status: 400, error: { message: 'Provider returned error', metadata: { provider_name: 'Upstream', raw: 'schema rejected' } },
      });
    };
    const d = db();
    const r = await runMemorySweep(deps(f.engine, f.llm, sweepConfig({ memorySweepModel: 'some/model' }), d), { dryRun: false, trigger: 'scheduled' });
    expect(calls).toBe(3);
    expect(r.errors).toBe(3);
    expect(r.deferred).toBe(3);
    expect(r.stopped).toContain('memory sweep stopped after 3 identical rejections from model some/model (HTTP 400 from Upstream: schema rejected)');
    for (const n of notes) expect(ledgerHash(d, n.id)).toBeUndefined();
    expect(lastSweepAt(d)).toBeNull(); // incomplete pass → watermark not advanced
  });

  it('stops at the first budget refusal and defers the rest without counting errors (#342)', async () => {
    const notes: FakeNote[] = [1, 2, 3, 4].map(i => ({ id: `n${i}`, title: `N${i}`, file_path: `Meetings/N${i}.md`, body: `body ${i}`, hash: `h${i}`, facts: [`Fact ${i}`] }));
    const f = fakes(notes);
    let calls = 0;
    const inner = f.llm.structuredCall.bind(f.llm);
    f.llm.structuredCall = async req => {
      calls += 1;
      if (calls === 2) throw new ProviderSpendLimitError('OpenRouter refused calls: key spend limit or credit reached; resets 2026-11-05T00:00:00.000Z', 'openrouter', '2026-11-05T00:00:00.000Z');
      return inner(req);
    };
    const d = db();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
      expect(calls).toBe(2);
      expect(r.errors).toBe(0);
      expect(r.deferred).toBe(3);
      expect(r.stopped).toBe('memory sweep stopped: OpenRouter refused calls: key spend limit or credit reached; '
        + 'resets 2026-11-05T00:00:00.000Z; the rest is retried next run');
      expect(ledgerHash(d, 'n1')).toBe('h1');
      for (const id of ['n2', 'n3', 'n4']) expect(ledgerHash(d, id)).toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  describe('when the Engine adds a memory without merging it (#346)', () => {
    const notes = (): FakeNote[] => [1, 2, 3, 4].map(i => ({ id: `n${i}`, title: `N${i}`, file_path: `Meetings/N${i}.md`, body: `body ${i}`, hash: `h${i}`, facts: [`Fact ${i}`] }));

    function failMergesFrom(f: ReturnType<typeof fakes>, call: number, warning: string): void {
      const create = f.engine.createMemory.bind(f.engine);
      let calls = 0;
      f.engine.createMemory = (async (args: Parameters<Engine['createMemory']>[0]) => {
        calls += 1;
        const out = await create(args);
        return calls >= call ? { ...out, consolidationFailure: warning } : out;
      }) as Engine['createMemory'];
    }

    it('stops at the first spent-key warning: the note is ledgered, the rest deferred, no provider text kept', async () => {
      const f = fakes(notes());
      failMergesFrom(f, 2, 'consolidation failed, so this memory was added without merging and queued for replay-memory-consolidation: 403 Key limit exceeded (daily limit). Manage it using <url> $1.00 of $1.00 used');
      const d = db();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const r = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
        expect(f.llmCalls()).toBe(2);
        expect(r).toMatchObject({ written: 2, unmerged: 1, deferred: 2, errors: 0, stopped: ENGINE_KEY_SPENT_STOP });
        expect(r.stopped).not.toContain('$1.00');
        expect(ledgerHash(d, 'n1')).toBe('h1');
        expect(ledgerHash(d, 'n2')).toBe('h2');
        for (const id of ['n3', 'n4']) expect(ledgerHash(d, id)).toBeUndefined();
      } finally { warn.mockRestore(); }
    });

    it('counts any other failure and keeps going', async () => {
      const f = fakes(notes());
      failMergesFrom(f, 1, 'consolidation failed, so this memory was added without merging and queued for replay-memory-consolidation: no JSON object in consolidation response');
      const d = db();
      const r = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
      expect(f.llmCalls()).toBe(4);
      expect(r).toMatchObject({ written: 4, unmerged: 4, deferred: 0, errors: 0 });
      expect(r.stopped).toBeUndefined();
      for (const n of notes()) expect(ledgerHash(d, n.id)).toBe(n.hash);
    });
  });

  it('is inert when disabled / no allowlist / no db — zero engine calls', async () => {
    const f = fakes([noteA]);
    const offConfig = sweepConfig({ memorySweepEnabled: false });
    expect((await runMemorySweep(deps(f.engine, f.llm, offConfig, db()), { dryRun: false, trigger: 'scheduled' })).ran).toBe(false);
    const noList = sweepConfig({ memorySweepTypes: [], memorySweepPaths: [] });
    expect((await runMemorySweep(deps(f.engine, f.llm, noList, db()), { dryRun: false, trigger: 'scheduled' })).ran).toBe(false);
    expect((await runMemorySweep(deps(f.engine, f.llm, sweepConfig()), { dryRun: false, trigger: 'scheduled' })).ran).toBe(false); // no db
    expect(f.llmCalls()).toBe(0);
  });

  it('extracts, persists vault-scoped with provenance, ledgers, advances watermark', async () => {
    const f = fakes([noteA, noteEmpty]);
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ ran: true, scanned: 2, written: 1, errors: 0, deferred: 0, liveMemoryTotal: 5 });
    expect(f.writes[0]).toMatchObject({
      scope: 'vault', source: 'curator', content: 'Fact from A',
      evidence: { kind: 'note', node_id: 'a', hash: 'ha' },
    });
    expect(f.writes[0]).not.toHaveProperty('metadata');
    expect(ledgerHash(d, 'a')).toBe('ha');
    expect(ledgerHash(d, 'e')).toBe('he'); // zero-fact notes are still processed + ledgered
    expect(lastSweepAt(d)).not.toBeNull();
  });

  it('leaves the curator journal notes out without an LLM call', async () => {
    const journal: FakeNote = {
      id: 'j', title: 'Curator Journal — 2026-10', file_path: 'Wikis/Curator Journal — 2026-10.md',
      body: 'nightly sweep log', hash: 'hj', facts: ['Fact from the journal'],
    };
    const spec: FakeNote = { ...noteB, id: 's', title: 'Curator Journal — Design Spec', file_path: 'Notes/Curator Journal — Design Spec.md' };
    const f = fakes([journal, spec]);
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ scanned: 1, written: 1, errors: 0, deferred: 0 });
    expect(f.llmCalls()).toBe(1);
    expect(f.users.some(user => user.includes('NOTE: Curator Journal — 2026-10'))).toBe(false);
    expect(ledgerHash(d, 'j')).toBeUndefined();
  });

  it("gives the model each note's date field, not its file time", async () => {
    const old: FakeNote = { ...noteA, title: 'Weekly Summary', fields: { date: { value: '2004-06-11' } }, mtime: Date.now() };
    const f = fakes([old, noteB]);
    await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), db()), { dryRun: false, trigger: 'scheduled' });
    expect(f.users.find(user => user.includes('NOTE: Weekly Summary'))).toMatch(/NOTE DATE: 2004-06-11 \(about \d+ years before today\)/);
    expect(f.users.find(user => user.includes('NOTE: B'))).not.toContain('NOTE DATE');
  });

  it('skips ledger-matched notes without an LLM call; re-extracts on hash change', async () => {
    const f = fakes([noteA]);
    const d = db();
    upsertLedger(d, 'a', 'ha', '2026-07-08T00:00:00.000Z');
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.skippedLedger).toBe(1);
    expect(f.llmCalls()).toBe(0);

    upsertLedger(d, 'a', 'stale-hash', '2026-07-08T00:00:00.000Z');
    const res2 = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res2.written).toBe(1);
    expect(ledgerHash(d, 'a')).toBe('ha');
  });

  it('run cap is note-granular: over-cap note and everything after it defer; watermark stays', async () => {
    const f = fakes([noteA, noteB]);
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig({ memorySweepCap: 1 }), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(1);          // note A fits (1 fact, cap 1)
    expect(res.deferred).toBe(1);         // note B deferred whole
    expect(f.llmCalls()).toBe(2);            // B was extracted (that's how we learned it overflows) but not persisted
    expect(ledgerHash(d, 'b')).toBeUndefined(); // deferred → unledgered → retried next run
    expect(lastSweepAt(d)).toBeNull();    // incomplete pass → watermark not advanced
  });

  it('re-verify: a run-cap-deferred note still expires its unsupported priors (expiry precedes the cap check)', async () => {
    // Mirrors the run-cap test above (cap 1, noteA fits + noteB overflows and defers),
    // plus a prior fact on noteB reported unsupported — deferral withholds noteB's
    // NEW facts, but its stale-prior expiry must still happen this run.
    const f = fakes([noteA, noteB], { priorFacts: { b: [{ id: 41, content: 'stale fact about B' }] } });
    f.llm.unsupported = [41];
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig({ memorySweepCap: 1 }), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(1);          // note A fits (1 fact, cap 1)
    expect(res.deferred).toBe(1);         // note B deferred whole
    expect(res.expired).toBe(1);          // B's stale prior still retires despite deferral
    expect(f.calls).toContain('expire:41:evidence-changed');
    expect(ledgerHash(d, 'b')).toBeUndefined(); // deferred → unledgered → retried next run
    expect(lastSweepAt(d)).toBeNull();    // incomplete pass → watermark not advanced
  });

  it('dry-run: previews only — no writes, no ledger, no watermark', async () => {
    const f = fakes([noteA]);
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: true, trigger: 'scheduled' });
    expect(res.previews).toBe(1);
    expect(f.writes).toHaveLength(0);
    expect(ledgerHash(d, 'a')).toBeUndefined();
    expect(lastSweepAt(d)).toBeNull();
  });

  it('a consolidation noop counts as already known, not written, and the note is ledgered (#298)', async () => {
    const f = fakes([noteA, noteB]);
    const create = f.engine.createMemory.bind(f.engine);
    f.engine.createMemory = (async (args: Parameters<Engine['createMemory']>[0]) => {
      const res = await create(args);
      return { ...res, operation: args.content === 'Fact from A' ? 'noop' : 'add' };
    }) as Engine['createMemory'];
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(1);
    expect(res.alreadyKnown).toBe(1);
    expect(res.errors).toBe(0);
    expect(ledgerHash(d, 'a')).toBe('ha');
    expect(f.writes.map(w => w.usage)).toEqual([
      { runRef: expect.any(String), sourceRef: 'memory-sweep' },
      { runRef: expect.any(String), sourceRef: 'memory-sweep' },
    ]);
  });

  it('DUPLICATE_MEMORY counts as duplicate and the note is still ledgered', async () => {
    const f = fakes([noteA], { createError: new EngineError('DUPLICATE_MEMORY', 'dup') });
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.duplicates).toBe(1);
    expect(res.errors).toBe(0);
    expect(ledgerHash(d, 'a')).toBe('ha');
  });

  it('a write error leaves the note unledgered and the watermark unadvanced', async () => {
    const f = fakes([noteA], { createError: new Error('boom') });
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBe(1);
    expect(ledgerHash(d, 'a')).toBeUndefined();
    expect(lastSweepAt(d)).toBeNull();
  });

  it('a missing content_hash skips the note WITHOUT pinning the watermark', async () => {
    // A node the indexer has no hash for can never be ledgered — treating it as an
    // error would pin the watermark and re-warn nightly until it ages out of the
    // lookback window. It is a warn-once skip, not a failure.
    const noHash: FakeNote = { id: 'n', title: 'N', file_path: 'Meetings/N.md', body: 'no hash', hash: '', facts: ['never extracted'] };
    const f = fakes([noHash, noteA]);
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBe(0);
    expect(res.skippedNoHash).toBe(1);
    expect(res.written).toBe(1);                 // noteA still processed
    expect(ledgerHash(d, 'n')).toBeUndefined();  // unledgerable without a hash
    expect(lastSweepAt(d)).not.toBeNull();       // clean pass → watermark advances
  });

  it('a truncated candidate scan blocks the watermark advance', async () => {
    const f = fakes([noteA], { truncated: true });
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(1);
    expect(lastSweepAt(d)).toBeNull();
  });

  /** `count` zero-fact notes, newest first, one minute apart. */
  function backlog(count: number): FakeNote[] {
    const newest = Date.parse('2026-10-27T00:00:00.000Z');
    return Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, title: `Note ${i}`, file_path: `Meetings/n${i}.md`, body: `body ${i}`, hash: `h${i}`, facts: [],
      mtime: newest - i * 60_000,
    }));
  }

  it('extracts at most SWEEP_EXTRACTION_CAP notes per run, newest first, and moves the watermark up to the oldest deferred one', async () => {
    const notes = backlog(SWEEP_EXTRACTION_CAP + 2);
    const f = fakes(notes);
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(f.llmCalls()).toBe(SWEEP_EXTRACTION_CAP);
    expect(res).toMatchObject({ scanned: SWEEP_EXTRACTION_CAP + 2, deferred: 2, errors: 0 });
    expect(ledgerHash(d, `n${SWEEP_EXTRACTION_CAP - 1}`)).toBe(`h${SWEEP_EXTRACTION_CAP - 1}`);
    expect(ledgerHash(d, `n${SWEEP_EXTRACTION_CAP}`)).toBeUndefined();
    expect(lastSweepAt(d)).toBe(new Date(notes.at(-1)!.mtime!).toISOString());
  });

  it('memorySweepExtractionCap replaces the default cap', async () => {
    const notes = backlog(SWEEP_EXTRACTION_CAP + 2);
    const f = fakes(notes);
    const d = db();
    const raised = await runMemorySweep(deps(f.engine, f.llm, sweepConfig({ memorySweepExtractionCap: SWEEP_EXTRACTION_CAP + 2 }), d), { dryRun: false, trigger: 'scheduled' });
    expect(raised).toMatchObject({ deferred: 0, errors: 0 });
    expect(f.llmCalls()).toBe(SWEEP_EXTRACTION_CAP + 2);

    const g = fakes(backlog(3));
    const lowered = await runMemorySweep(deps(g.engine, g.llm, sweepConfig({ memorySweepExtractionCap: 1 }), db()), { dryRun: false, trigger: 'scheduled' });
    expect(lowered).toMatchObject({ deferred: 2, errors: 0 });
    expect(g.llmCalls()).toBe(1);
  });

  it('the next run drains the deferred notes; ledgered notes neither use the cap nor count as deferred', async () => {
    const notes = backlog(SWEEP_EXTRACTION_CAP + 2);
    const f = fakes(notes);
    const d = db();
    await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ skippedLedger: SWEEP_EXTRACTION_CAP, deferred: 0, errors: 0 });
    expect(f.llmCalls()).toBe(SWEEP_EXTRACTION_CAP + 2);
    expect(Date.parse(lastSweepAt(d)!)).toBeGreaterThan(notes[0]!.mtime!); // complete pass → sweep start
  });

  it('an unprocessed note holds the watermark at its mtime while older notes are still processed', async () => {
    const newer: FakeNote = { ...noteEmpty, mtime: Date.parse('2026-10-20T00:00:00.000Z') };
    const failing: FakeNote = { ...noteA, mtime: Date.parse('2026-10-10T00:00:00.000Z') };
    const older: FakeNote = { ...noteB, facts: [], mtime: Date.parse('2026-10-01T00:00:00.000Z') };
    const f = fakes([newer, failing, older], { createError: new Error('boom') });
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBe(1);
    expect(ledgerHash(d, 'a')).toBeUndefined();
    expect(ledgerHash(d, 'b')).toBe('hb'); // an error no longer stops older notes from being processed
    expect(lastSweepAt(d)).toBe('2026-10-10T00:00:00.000Z');
  });

  it('after the fact cap halts extraction, a later ledgered note counts as unchanged, not deferred', async () => {
    const f = fakes([noteA, noteB, noteEmpty]);
    const d = db();
    upsertLedger(d, 'e', 'he', '2026-07-08T00:00:00.000Z');
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig({ memorySweepCap: 1 }), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ written: 1, deferred: 1, skippedLedger: 1 });
  });

  it('removes only verified capture blocks before memory extraction', async () => {
    const capture = renderCaptureBlock({
      captureId: 'cap-memory', conversationId: 'conversation-memory', transcriptHash: 'input-hash',
      conversationTitle: 'Memory conversation', capturedOn: '2026-08-25', title: 'Captured value',
      markdown: 'Generated assistant content must not become memory.', sourceUrls: [], includeHeading: true,
    });
    const note = {
      ...noteA,
      body: `Human fact: Avery prefers tea.\n\n${capture}\n\nHuman fact: Avery cycles weekly.`,
      facts: ['Fact from stripped evidence'],
    };
    const f = fakes([note]);
    await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), db()), { dryRun: false, trigger: 'scheduled' });
    expect(f.writes).toHaveLength(1);
    expect(f.llmCalls()).toBe(1);
    expect(f.users[0]).toContain('Human fact: Avery prefers tea.');
    expect(f.users[0]).toContain('Human fact: Avery cycles weekly.');
    expect(f.users[0]).not.toContain('Generated assistant content must not become memory.');
  });

  it('fails closed on malformed capture markers without calling the LLM or ledgers', async () => {
    const malformed = {
      ...noteA,
      body: 'Human fact\n<!-- ve:chat-curation:start id="broken" conversation="c" transcript-hash="h" -->\nGenerated content',
    };
    const f = fakes([malformed]);
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ skippedMalformedCaptureMarkers: 1, written: 0, errors: 0 });
    expect(f.llmCalls()).toBe(0);
    expect(ledgerHash(d, 'a')).toBeUndefined();
  });

  it('never rejects, even when the candidate query explodes', async () => {
    const engine = { listChangedNodes: async () => { throw new Error('engine down'); } } as unknown as Engine;
    const f = fakes([]);
    const res = await runMemorySweep(deps(engine, f.llm, sweepConfig(), db()), { dryRun: false, trigger: 'scheduled' });
    expect(res.ran).toBe(true);
    expect(res.errors).toBeGreaterThan(0);
  });

  it('re-verify: expires unsupported prior facts (evidence-changed) BEFORE persisting new ones', async () => {
    const f = fakes([noteA], { priorFacts: { a: [{ id: 41, content: 'stale fact' }, { id: 42, content: 'still-good fact' }] } });
    f.llm.unsupported = [41]; // harness knob: structuredCall returns { facts, unsupported_ids: [41] }
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), db()), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ written: 1, expired: 1, reverifiedNotes: 1, errors: 0 });
    const expireIdx = f.calls.indexOf('expire:41:evidence-changed');
    const createIdx = f.calls.findIndex(c => c.startsWith('create:'));
    expect(expireIdx).toBeGreaterThanOrEqual(0);
    expect(expireIdx).toBeLessThan(createIdx); // expire BEFORE persist
    expect(f.calls).not.toContain('expire:42:evidence-changed');
  });

  it('re-verify: ids outside the candidate list are discarded (validation posture)', async () => {
    const f = fakes([noteA], { priorFacts: { a: [{ id: 41, content: 'prior' }] } });
    f.llm.unsupported = [41, 999];
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), db()), { dryRun: false, trigger: 'scheduled' });
    expect(res.expired).toBe(1);
    expect(f.calls.filter(c => c.startsWith('expire:'))).toEqual(['expire:41:evidence-changed']);
  });

  it('re-verify: an expiry failure counts as an error and leaves the note unledgered', async () => {
    const f = fakes([noteA], { priorFacts: { a: [{ id: 41, content: 'prior' }] }, expireError: new Error('engine down') });
    f.llm.unsupported = [41];
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBeGreaterThan(0);
    expect(ledgerHash(d, 'a')).toBeUndefined(); // retries next run
  });

  it('re-verify: a prior-facts fetch failure fails the note BEFORE extraction (Decision 6)', async () => {
    const f = fakes([noteA], { priorFetchError: new Error('engine down') });
    const d = db();
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBeGreaterThan(0);
    expect(f.llmCalls()).toBe(0);                              // no extraction call for the note
    expect(f.calls.some(c => c.startsWith('create:'))).toBe(false); // and so no persist
    expect(ledgerHash(d, 'a')).toBeUndefined();                 // retries next run
  });

  it('re-verify: reverifyEnabled=false fetches no priors and expires nothing', async () => {
    const f = fakes([noteA], { priorFacts: { a: [{ id: 41, content: 'prior' }] } });
    await runMemorySweep(deps(f.engine, f.llm, sweepConfig({ reverifyEnabled: false }), db()), { dryRun: false, trigger: 'scheduled' });
    expect(f.calls.filter(c => c.startsWith('listMemories:') || c.startsWith('expire:'))).toEqual([]);
  });

  it('re-verify: dry-run adjudicates but never expires', async () => {
    const f = fakes([noteA], { priorFacts: { a: [{ id: 41, content: 'prior' }] } });
    f.llm.unsupported = [41];
    const res = await runMemorySweep(deps(f.engine, f.llm, sweepConfig(), db()), { dryRun: true, trigger: 'scheduled' });
    expect(f.calls.filter(c => c.startsWith('expire:'))).toEqual([]);
    expect(res.expired).toBe(0);
  });
});

describe('memory sweep dates (#459)', () => {
  it('tells the extraction model today in the configured zone', async () => {
    const f = fakes([{ id: 'a', title: 'A', file_path: 'Meetings/A.md', body: 'body a', hash: 'ha', facts: [] }]);
    const systems: string[] = [];
    const call = f.llm.structuredCall.bind(f.llm);
    f.llm.structuredCall = async req => { systems.push(req.system); return call(req); };
    await runMemorySweep(deps(f.engine, f.llm, sweepConfig({ curatorTz: 'Asia/Tokyo' }), db()), { dryRun: false, trigger: 'scheduled' });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(Asia\/Tokyo\)\.$/);
  });
});
