import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { insertJournalEvent, unjournaledEvents, type JournalEventInsert } from '../src/db/journal.js';
import { ActionRecorder } from '../src/journal/recorder.js';
import { LEDE_MAX_TOKENS, LEDE_REASONING_BUDGET, ledeClient, markJournalNotes, writeJournalEntry, type JournalWriterDeps } from '../src/journal/writer.js';
import { EngineError, type Engine } from '../src/engine.js';
import type { LlmClient, LlmConfiguration, StructuredCallRequest } from '../src/llm/types.js';
import type { Config } from '../src/config.js';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';
import type OpenAI from 'openai';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';

const NOW = new Date('2026-07-13T09:04:00.000Z'); // 05:04 America/New_York

function event(overrides: Partial<JournalEventInsert> = {}): JournalEventInsert {
  return {
    ts: NOW.toISOString(), run_ref: 'r1', trigger: 'scheduled', function: 'org-sweep',
    kind: 'action', action: 'typed', node_id: null, target: null,
    detail: 'typed "X" → recipe', dry_run: 0, ...overrides,
  };
}

interface FakeEngine {
  engine: Engine;
  appends: Array<{ nodeId: string; text: string }>;
  created: Array<{ title: string; directory?: string; types: string[] }>;
  noteExists: boolean;
  noteMarked: boolean;
  failAppend: boolean;
  schemaEnsures: number;
  createdFields: Array<Record<string, unknown>>;
  marks: Array<{ nodeId: string; kind: string }>;
}

function fakeEngine(): FakeEngine {
  const f: FakeEngine = { appends: [], created: [], noteExists: false, noteMarked: false, failAppend: false, schemaEnsures: 0, createdFields: [], marks: [], engine: undefined as never };
  f.engine = {
    ensureNoteSchema: async () => { f.schemaEnsures += 1; },
    getNodeByTitle: async (title: string) => {
      if (!f.noteExists) throw new EngineError('NODE_NOT_FOUND', `no node titled ${title}`);
      return { id: 'journal-node', title, fields: f.noteMarked ? { vault_engine_projection: 'journal' } : {} } as never;
    },
    markSuiteNote: async (nodeId: string, kind: string) => { f.marks.push({ nodeId, kind }); f.noteMarked = true; },
    createNode: async (args: { title: string; types: string[]; directory?: string; fields?: Record<string, unknown> }) => {
      f.created.push({ title: args.title, directory: args.directory, types: args.types });
      f.createdFields.push(args.fields ?? {});
      f.noteExists = true;
      f.noteMarked = Object.prototype.hasOwnProperty.call(args.fields ?? {}, 'vault_engine_projection');
      return { node_id: 'journal-node', file_path: `Wikis/${args.title}.md` };
    },
    appendNodeBody: async (nodeId: string, text: string) => {
      if (f.failAppend) throw new EngineError('WRITE_FAILED', 'disk on fire');
      f.appends.push({ nodeId, text });
    },
  } as unknown as Engine;
  return f;
}

function setup(llmLede: string | Error = 'LLM LEDE.') {
  const db = new Database(':memory:');
  runMigrations(db);
  const fake = fakeEngine();
  const llm: LlmClient = {
    structuredCall: async () => {
      if (llmLede instanceof Error) throw llmLede;
      return { output: { lede: llmLede }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const config = {
    journalEnabled: true, journalModel: null, model: 'test-model', curatorTz: 'America/New_York',
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
  } as Config;
  const deps: JournalWriterDeps = { engine: fake.engine, llm, config, db, recorder: new ActionRecorder(db) };
  return { db, fake, deps };
}

describe('writeJournalEntry', () => {
  it('creates the monthly note marked as the suite\'s own, and marks an unmarked one once (#600)', async () => {
    const { db, fake, deps } = setup();
    insertJournalEvent(db, event());
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(fake.createdFields).toEqual([{ vault_engine_projection: 'journal' }]);
    expect(fake.marks).toEqual([]);

    const unmarked = setup();
    unmarked.fake.noteExists = true;
    insertJournalEvent(unmarked.db, event({ run_ref: 'r2' }));
    await writeJournalEntry(unmarked.deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    insertJournalEvent(unmarked.db, event({ run_ref: 'r3' }));
    await writeJournalEntry(unmarked.deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(unmarked.fake.marks).toEqual([{ nodeId: 'journal-node', kind: 'journal' }]);
    expect(unmarked.fake.appends).toHaveLength(2);
  });

  it('still writes the entry when marking the note fails (#600)', async () => {
    const { db, fake, deps } = setup();
    fake.noteExists = true;
    fake.engine.markSuiteNote = async () => { throw new EngineError('WRITE_FAILED', 'refused'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      insertJournalEvent(db, event());
      await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
      expect(fake.appends).toHaveLength(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('could not mark');
    } finally {
      warn.mockRestore();
    }
  });

  it('creates the monthly note on first write (Wikis/, type note) and appends the entry', async () => {
    const { db, fake, deps } = setup();
    for (let i = 0; i < 3; i++) insertJournalEvent(db, event({ detail: `typed "N${i}" → note` }));
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(fake.created).toEqual([{ title: 'Curator Journal — 2026-07', directory: 'Wikis', types: ['note'] }]);
    expect(fake.schemaEnsures).toBe(1); // a vault may have no `note` type yet
    expect(fake.appends).toHaveLength(1);
    const text = fake.appends[0]!.text;
    expect(text).toContain('## 2026-07-13 05:04 — nightly sweep');
    expect(text).toContain('LLM LEDE.'); // ≥3 actions → LLM lede
    expect(text).toContain('- typed "N0" → note');
    expect(unjournaledEvents(db)).toHaveLength(0); // stamped after successful append
  });

  it('creates the monthly note in the wiki folder Engine reports', async () => {
    const { db, fake, deps } = setup();
    deps.config = { ...deps.config, wikiDir: 'Curator Wikis' };
    insertJournalEvent(db, event());
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(fake.created).toEqual([{ title: 'Curator Journal — 2026-07', directory: 'Curator Wikis', types: ['note'] }]);
  });

  it('creates the monthly note as the vault map\'s journal kind, and finds an existing one by title', async () => {
    const { db, fake, deps } = setup();
    const kinds: string[] = [];
    fake.engine.ensureNoteSchema = async (type: string) => { kinds.push(type); };
    deps.config = { ...deps.config, vault: { ...(defaultsFor('vault') as unknown as VaultSettings), journalType: 'log' } };
    insertJournalEvent(db, event());
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(fake.created).toEqual([{ title: 'Curator Journal — 2026-07', directory: 'Wikis', types: ['log'] }]);
    expect(kinds).toEqual(['log']);
  });

  it('is off when the journal kind is none: nothing read, written or stamped', async () => {
    const { db, fake, deps } = setup();
    const getNodeByTitle = vi.spyOn(fake.engine, 'getNodeByTitle');
    deps.config = { ...deps.config, vault: { ...(defaultsFor('vault') as unknown as VaultSettings), journalType: null } };
    insertJournalEvent(db, event());
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(getNodeByTitle).not.toHaveBeenCalled();
    expect(fake.created).toEqual([]);
    expect(fake.appends).toEqual([]);
    expect(unjournaledEvents(db)).toHaveLength(1);
  });

  it('appends to an existing monthly note without creating it or its schema', async () => {
    const { db, fake, deps } = setup();
    fake.noteExists = true;
    insertJournalEvent(db, event());
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(fake.created).toEqual([]);
    expect(fake.schemaEnsures).toBe(0);
    expect(fake.appends).toEqual([{ nodeId: 'journal-node', text: expect.stringContaining('typed "X" → recipe') }]);
  });

  it('uses the deterministic lede (no LLM call) for ≤2 clean actions', async () => {
    const boom = vi.fn(async () => { throw new Error('LLM must not be called'); });
    const { db, fake, deps } = setup();
    deps.llm = { structuredCall: boom };
    insertJournalEvent(db, event());
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'on-demand: X', NOW);
    expect(boom).not.toHaveBeenCalled();
    expect(fake.appends[0]!.text).toContain('Quick update: typed "X" → recipe.');
  });

  it('never calls the model with modelLede: false, however many actions or errors', async () => {
    const boom = vi.fn(async () => { throw new Error('LLM must not be called'); });
    const { db, fake, deps } = setup();
    deps.llm = { structuredCall: boom };
    for (let i = 0; i < 3; i++) insertJournalEvent(db, event({ detail: `typed "N${i}" → note` }));
    insertJournalEvent(db, event({ kind: 'summary', action: null, detail: JSON.stringify({ line: 'failed', stats: { errors: 1 } }) }));
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'wiki field check', NOW, { modelLede: false });
    expect(boom).not.toHaveBeenCalled();
    expect(fake.appends[0]!.text).toContain('Quick update: typed "N0" → note;');
  });

  it('falls back to the deterministic lede when the LLM fails (entry still written)', async () => {
    const { db, fake, deps } = setup(new Error('model offline'));
    for (let i = 0; i < 3; i++) insertJournalEvent(db, event());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    warn.mockRestore();
    expect(fake.appends).toHaveLength(1);
    expect(fake.appends[0]!.text).toContain('Quick update:');
  });

  it('run-refs scope journals only its own events; a failed append leaves events unstamped', async () => {
    const { db, fake, deps } = setup();
    insertJournalEvent(db, event({ run_ref: 'mine', detail: 'mine' }));
    insertJournalEvent(db, event({ run_ref: 'other', detail: 'other' }));
    await writeJournalEntry(deps, { kind: 'run-refs', runRefs: ['mine'] }, 'on-demand: P', NOW);
    expect(fake.appends[0]!.text).toContain('mine');
    expect(fake.appends[0]!.text).not.toContain('other');
    expect(unjournaledEvents(db).map(r => r.detail)).toEqual(['other']);

    fake.failAppend = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeJournalEntry(deps, { kind: 'run-refs', runRefs: ['other'] }, 'on-demand: Q', NOW);
    warn.mockRestore();
    expect(unjournaledEvents(db).map(r => r.detail)).toEqual(['other']); // rolls forward
  });

  it('writes nothing for an empty scope or when journalEnabled is false', async () => {
    const { db, fake, deps } = setup();
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(fake.appends).toHaveLength(0);
    (deps.config as { journalEnabled: boolean }).journalEnabled = false;
    insertJournalEvent(db, event());
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(fake.appends).toHaveLength(0);
  });
});

describe('the lede call (#256)', () => {
  /** A client that records each call's request and the configuration it was bound to. */
  function configurable(base: LlmConfiguration) {
    const calls: Array<{ request: StructuredCallRequest; configuration: LlmConfiguration }> = [];
    const make = (configuration: LlmConfiguration): LlmClient => ({
      configurationFor: () => ({ ...configuration }),
      withConfiguration: (next) => make(next),
      structuredCall: async (request) => {
        calls.push({ request, configuration });
        return { output: { lede: 'LLM LEDE.' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
      },
    });
    return { llm: make(base), calls };
  }

  it('bounds reasoning with a budget on OpenRouter, leaving room to answer (#431)', async () => {
    const { db, fake, deps } = setup();
    const { llm, calls } = configurable({ provider: 'openrouter', reasoningEffort: 'high' });
    deps.llm = llm;
    for (let i = 0; i < 3; i++) insertJournalEvent(db, event({ detail: `typed "N${i}" → note` }));
    await writeJournalEntry(deps, { kind: 'all-unjournaled' }, 'nightly sweep', NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.configuration).toEqual({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: LEDE_REASONING_BUDGET });
    expect(calls[0]!.request.maxTokens).toBe(LEDE_MAX_TOKENS);
    expect(LEDE_MAX_TOKENS).toBeGreaterThanOrEqual(4000);
    expect(LEDE_MAX_TOKENS - LEDE_REASONING_BUDGET).toBeGreaterThanOrEqual(3000);
    expect(fake.appends[0]!.text).toContain('LLM LEDE.');
  });

  it('sends the OpenRouter budget even when no shared effort is set, and replaces a bound one', () => {
    for (const base of [
      { provider: 'openrouter', reasoningEffort: null },
      { provider: 'openrouter', reasoningEffort: null, reasoningBudget: 6000 },
    ] satisfies LlmConfiguration[]) {
      const { llm } = configurable(base);
      expect(ledeClient(llm, 'm').configurationFor!('m'))
        .toEqual({ provider: 'openrouter', reasoningEffort: null, reasoningBudget: LEDE_REASONING_BUDGET });
    }
  });

  it('sends reasoning.max_tokens and no reasoning_effort in the real OpenRouter request', async () => {
    const adapter = new OpenAiCompatLlmClient({} as OpenAI, { provider: 'openrouter', fireworksExtensions: false, reasoningEffort: 'high' });
    const preview = await ledeClient(adapter, 'qwen/qwen3.7-plus').previewStructuredCall!({ model: 'qwen/qwen3.7-plus',
      maxTokens: LEDE_MAX_TOKENS, system: 's', user: 'u', toolName: 'emit_journal_lede', toolDescription: 'd', schema: {} });
    expect(preview.payload).toMatchObject({ max_tokens: LEDE_MAX_TOKENS, reasoning: { max_tokens: LEDE_REASONING_BUDGET } });
    expect(preview.payload).not.toHaveProperty('reasoning_effort');
  });

  it('asks other providers for low effort only where an effort is already sent', () => {
    for (const provider of ['fireworks', 'openai'] as const) {
      const { llm } = configurable({ provider, reasoningEffort: 'high' });
      expect(ledeClient(llm, 'm').configurationFor!('m')).toEqual({ provider, reasoningEffort: 'low' });
    }
  });

  it('never adds a reasoning effort where none is sent, and leaves Anthropic alone', () => {
    for (const base of [
      { provider: 'fireworks', reasoningEffort: null },
      { provider: 'anthropic', reasoningEffort: null },
    ] satisfies LlmConfiguration[]) {
      const { llm } = configurable(base);
      expect(ledeClient(llm, 'm')).toBe(llm);
    }
    const plain: LlmClient = { structuredCall: async () => ({ output: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) };
    expect(ledeClient(plain, 'm')).toBe(plain);
  });
});

describe('markJournalNotes (#600)', () => {
  it('marks only unmarked monthly journal notes', async () => {
    const marks: string[] = [];
    const engine = {
      listNotesTitled: async () => [
        { id: 'sep', title: 'Curator Journal — 2026-09', marked: false },
        { id: 'oct', title: 'Curator Journal — 2026-10', marked: true },
        { id: 'spec', title: 'Curator Journal — Design Spec', marked: false },
        { id: 'bad-month', title: 'Curator Journal — 2026-13', marked: false },
      ],
      markSuiteNote: async (nodeId: string, kind: string) => { marks.push(`${nodeId}:${kind}`); },
    };
    expect(await markJournalNotes(engine)).toBe(1);
    expect(marks).toEqual(['sep:journal']);
  });
});
