import { describe, expect, it, vi } from 'vitest';
import { ProviderSpendLimitError } from '../src/provider-limits.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import {
  conversationLedgerHash, upsertConversationLedger,
  lastConversationSweepAt, setLastConversationSweepAt,
} from '../src/db/conversation-sweep.js';
import type { TranscriptTurn } from '@vault/chat-core/transcript';
import type { Memory } from '../src/types.js';
import {
  ASSISTANT_TURN_CHARS, TRANSCRIPT_CHARS, CONVERSATION_EXTRACT_SYSTEM_PROMPT,
  renderTranscript, buildConversationUser, ftsQuery, transcriptHash, conversationSystem,
  runConversationSweep, type ConversationSweepDeps,
} from '../src/conversation-sweep.js';
import { CurationQueue } from '../src/queue.js';
import { EngineError, type Engine } from '../src/engine.js';
import type { Config } from '../src/config.js';
import type { LlmClient } from '../src/llm/types.js';

function db(): Database.Database {
  const d = new Database(':memory:');
  runMigrations(d);
  return d;
}

describe('conversation sweep ledger', () => {
  it('migration #9 creates the tables and bumps user_version to at least 9', () => {
    const d = db();
    expect(d.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(9);
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(r => r.name);
    expect(names).toContain('memory_sweep_conversation_ledger');
    expect(names).toContain('conversation_sweep_state');
  });

  it('round-trips a ledger row and upserts on conflict', () => {
    const d = db();
    expect(conversationLedgerHash(d, 'c1')).toBeUndefined();
    upsertConversationLedger(d, 'c1', 'h1', '2026-08-03T00:00:00.000Z');
    expect(conversationLedgerHash(d, 'c1')).toBe('h1');
    upsertConversationLedger(d, 'c1', 'h2', '2026-08-04T00:00:00.000Z');
    expect(conversationLedgerHash(d, 'c1')).toBe('h2');
    expect(d.prepare('SELECT COUNT(*) n FROM memory_sweep_conversation_ledger').get()).toEqual({ n: 1 });
  });

  it('round-trips the watermark, single-row enforced', () => {
    const d = db();
    expect(lastConversationSweepAt(d)).toBeNull();
    setLastConversationSweepAt(d, '2026-08-03T00:00:00.000Z');
    expect(lastConversationSweepAt(d)).toBe('2026-08-03T00:00:00.000Z');
    setLastConversationSweepAt(d, '2026-08-04T00:00:00.000Z');
    expect(lastConversationSweepAt(d)).toBe('2026-08-04T00:00:00.000Z');
    expect(d.prepare('SELECT COUNT(*) n FROM conversation_sweep_state').get()).toEqual({ n: 1 });
  });

  it('is independent of the note sweep ledger', () => {
    const d = db();
    upsertConversationLedger(d, 'c1', 'h1', 'T');
    expect(d.prepare('SELECT COUNT(*) n FROM memory_sweep_ledger').get()).toEqual({ n: 0 });
  });
});

const turn = (role: TranscriptTurn['role'], text: string): TranscriptTurn => ({ role, text });
const mem = (id: number, content: string): Memory => ({
  id, source: 'curator', scope: 'vault', node_id: null, content, category: 'fact',
  created_at: 't', updated_at: 't',
});

describe('renderTranscript', () => {
  it('labels turns and separates them with a blank line', () => {
    expect(renderTranscript([turn('user', 'hi'), turn('assistant', 'hello')]))
      .toBe('USER: hi\n\nASSISTANT: hello');
  });

  it('truncates long assistant turns but never user turns', () => {
    const longUser = 'u'.repeat(ASSISTANT_TURN_CHARS + 500);
    const longAsst = 'a'.repeat(ASSISTANT_TURN_CHARS + 500);
    const out = renderTranscript([turn('user', longUser), turn('assistant', longAsst)]);
    expect(out).toContain(longUser);
    expect(out).toContain(`${'a'.repeat(ASSISTANT_TURN_CHARS)}\n…[truncated]`);
    expect(out).not.toContain('a'.repeat(ASSISTANT_TURN_CHARS + 1));
  });

  it('caps the whole transcript as a backstop', () => {
    const many = Array.from({ length: 200 }, () => turn('user', 'x'.repeat(500)));
    const out = renderTranscript(many);
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_CHARS + '\n…[truncated]'.length);
    expect(out.endsWith('\n…[truncated]')).toBe(true);
  });
});

describe('ftsQuery', () => {
  it('builds a quoted OR query from word tokens', () => {
    expect(ftsQuery('Curator model switch')).toBe('"curator" OR "model" OR "switch"');
  });

  it('neutralizes FTS5 operators and punctuation', () => {
    const q = ftsQuery('Limerick on Café-au-Lait Prices: NEAR("x") OR *');
    expect(q).not.toMatch(/[():*]/);
    expect(q).toContain('"limerick"');
    expect(q).toContain('"lait"');
  });

  it('drops stopwords, short tokens, and duplicates', () => {
    expect(ftsQuery('the and a qwen qwen')).toBe('"qwen"');
  });

  it('caps the term count', () => {
    const q = ftsQuery(Array.from({ length: 40 }, (_, i) => `term${i}`).join(' '), 5);
    expect(q.split(' OR ')).toHaveLength(5);
  });

  it('returns an empty string when nothing survives', () => {
    expect(ftsQuery('a b c !! ??')).toBe('');
    expect(ftsQuery('')).toBe('');
  });
});

describe('transcriptHash', () => {
  it('is stable for identical turns and differs on any change', () => {
    const a = [turn('user', 'one'), turn('assistant', 'two')];
    expect(transcriptHash(a)).toBe(transcriptHash([turn('user', 'one'), turn('assistant', 'two')]));
    expect(transcriptHash(a)).not.toBe(transcriptHash([turn('user', 'one'), turn('assistant', 'three')]));
    expect(transcriptHash(a)).not.toBe(transcriptHash([turn('assistant', 'one'), turn('user', 'two')]));
    expect(transcriptHash(a)).not.toBe(transcriptHash([turn('user', 'one')]));
  });

  it('is not confusable by concatenation across the role/text boundary', () => {
    expect(transcriptHash([turn('user', 'ab')])).not.toBe(transcriptHash([turn('user', 'a'), turn('user', 'b')]));
  });

  // Regression guard for the exact space-separator bug the brief describes: a space
  // separator makes {user,"x user y"} hash equal to {user,"x"},{user,"y"} because the
  // word "user" IS the role label, so the flattened strings collide char-for-char. The
  // word "user" inside the fixture text is load-bearing — do not "simplify" this to a
  // string that doesn't contain the literal word "user", or the guard goes silent.
  it('would collide under a space separator (regression guard)', () => {
    expect(transcriptHash([turn('user', 'x user y')]))
      .not.toBe(transcriptHash([turn('user', 'x'), turn('user', 'y')]));
  });
});

describe('buildConversationUser', () => {
  const turns = [turn('user', 'I moved the curator to qwen')];

  it('includes title, cap, and rendered transcript', () => {
    const out = buildConversationUser({ title: 'Model switch' }, turns, [], 2);
    expect(out).toContain('CONVERSATION: Model switch');
    expect(out).toContain('PER-CONVERSATION CAP: at most 2 facts.');
    expect(out).toContain('USER: I moved the curator to qwen');
  });

  it('names the vault owner first when the vault map has one (#554)', () => {
    expect(buildConversationUser({ title: 'T' }, turns, [], 2, [], 'Avery Stone')).toMatch(/^VAULT OWNER \(never a subject\): Avery Stone\nCONVERSATION: T/);
    expect(buildConversationUser({ title: 'T' }, turns, [], 2)).toMatch(/^CONVERSATION: T/);
  });

  it('omits both optional blocks when empty', () => {
    const out = buildConversationUser({ title: 'T' }, turns, [], 2);
    expect(out).not.toContain('ALREADY KNOWN');
    expect(out).not.toContain('PREVIOUSLY EXTRACTED');
  });

  it('renders the ALREADY KNOWN block', () => {
    const out = buildConversationUser({ title: 'T' }, turns, [mem(1, 'Avery lives in Chicago')], 2);
    expect(out).toContain('ALREADY KNOWN (do not re-extract):\n- Avery lives in Chicago');
  });

  it('renders the re-verify block with ids', () => {
    const out = buildConversationUser({ title: 'T' }, turns, [], 2, [mem(41, 'stale fact')]);
    expect(out).toContain('PREVIOUSLY EXTRACTED FROM THIS CONVERSATION');
    expect(out).toContain('- [id 41] stale fact');
  });
});

describe('conversationSystem', () => {
  it('appends the date line to the default prompt', () => {
    const out = conversationSystem(new Date('2026-08-03T12:00:00Z'));
    expect(out).toContain(CONVERSATION_EXTRACT_SYSTEM_PROMPT);
    expect(out).toContain('2026-08-03');
  });

  it('falls back to the default when the override is blank', () => {
    expect(conversationSystem(new Date('2026-08-03T12:00:00Z'), '   '))
      .toContain(CONVERSATION_EXTRACT_SYSTEM_PROMPT);
  });

  it('uses a non-blank override', () => {
    expect(conversationSystem(new Date('2026-08-03T12:00:00Z'), 'CUSTOM')).toContain('CUSTOM');
  });
});

const USAGE = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };
const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

interface FakeConv {
  id: string; title: string; updatedAgoMs: number; archived?: number;
  userText: string; asstText?: string; facts: string[];
  /** H4 fixture: no messages at all — flattenTranscript yields turns.length===0
   *  AND droppedParts===0, the case the shape-regression guard does not cover. */
  emptyMessages?: boolean;
}

function convConfig(over: Partial<Config> = {}): Config {
  return {
    model: 'test-model',
    fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
    fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
    conversationSweepEnabled: true, conversationSweepSettleHours: 6,
    conversationSweepMinUserChars: 300, conversationSweepCap: 5,
    conversationSweepPerConversationCap: 2, conversationSweepMaxTokens: 4000,
    conversationSweepModel: null, conversationSweepSince: null,
    curatorConversationSweepPrompt: '',
    reverifyEnabled: true,
    ...over,
  } as Config;
}

function fakes(
  convs: FakeConv[],
  opts: {
    getError?: Error; createError?: Error; expireError?: Error;
    priorFetchError?: Error; searchError?: Error; listError?: Error;
    priorFacts?: Record<string, Array<{ id: number; content: string }>>;
  } = {},
) {
  const writes: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let llmCallCount = 0;
  const engine = {
    listConversations: async () => {
      if (opts.listError) throw opts.listError;
      return convs.map(c => ({
        id: c.id, title: c.title, created_at: iso(c.updatedAgoMs),
        updated_at: iso(c.updatedAgoMs), archived: c.archived ?? 0,
      }));
    },
    getConversation: async (id: string) => {
      calls.push(`get:${id}`);
      if (opts.getError) throw opts.getError;
      const c = convs.find(x => x.id === id);
      if (!c) throw new Error('missing');
      if (c.emptyMessages) {
        return {
          conversation: { id: c.id, title: c.title, created_at: 'a', updated_at: 'b', archived: 0 },
          messages: [],
        };
      }
      return {
        conversation: { id: c.id, title: c.title, created_at: 'a', updated_at: 'b', archived: 0 },
        messages: [
          { role: 'user', parts: [{ type: 'text', text: c.userText }, { type: 'dynamic-tool', output: {} }] },
          { role: 'assistant', parts: [{ type: 'text', text: c.asstText ?? 'ok' }, { type: 'reasoning', text: 'hmm' }] },
        ],
      };
    },
    // Non-empty on purpose (I1 regression guard): a fallback list that is
    // empty either way would make the ALREADY-KNOWN fallback direction
    // unfalsifiable — a swapped success/failure assignment would still pass.
    listMemoriesWithTotal: async () => ({
      memories: [{ id: 99, source: 'curator', scope: 'vault', node_id: null, content: 'UNRELATED FALLBACK FACT', category: 'fact', created_at: 't', updated_at: 't' }],
      total: 42,
    }),
    searchMemories: async (a: { query: string }) => {
      calls.push(`search:${a.query}`);
      if (opts.searchError) throw opts.searchError;
      return [];
    },
    listMemories: async (f: { evidence_ref?: string }) => {
      calls.push(`priors:${f.evidence_ref}`);
      if (opts.priorFetchError) throw opts.priorFetchError;
      return (opts.priorFacts?.[f.evidence_ref ?? ''] ?? []).map(p => ({
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

  const userPrompts: string[] = [];
  const llm: LlmClient & { unsupported?: number[] } = {
    unsupported: undefined,
    structuredCall: async (req) => {
      llmCallCount += 1;
      userPrompts.push(req.user);
      const c = convs.find(x => req.user.includes(`CONVERSATION: ${x.title}`));
      return {
        output: {
          facts: (c?.facts ?? []).map(content => ({ content })),
          ...(llm.unsupported ? { unsupported_ids: llm.unsupported } : {}),
        },
        usage: USAGE,
      };
    },
  };
  return { engine, llm, writes, calls, llmCalls: () => llmCallCount, userPrompts };
}

function deps(engine: Engine, llm: LlmClient, config: Config, d?: Database.Database): ConversationSweepDeps {
  return { engine, llm, config, queue: new CurationQueue(), db: d };
}

const LONG = 'I decided to move the curator to qwen because the eval anchor is qwen. '.repeat(6); // >300 chars
const SHORT = 'attach the meeting summary to that node';

describe('runConversationSweep', () => {
  const settled: FakeConv = { id: 'c1', title: 'Model switch', updatedAgoMs: 24 * HOUR, userText: LONG, facts: ['Avery runs the curator on qwen'] };
  const fresh: FakeConv = { id: 'c2', title: 'Still going', updatedAgoMs: 1 * HOUR, userText: LONG, facts: ['too soon'] };
  const terse: FakeConv = { id: 'c3', title: 'Attach summary', updatedAgoMs: 24 * HOUR, userText: SHORT, facts: ['should not happen'] };

  it('is inert when disabled or without a db — zero engine calls', async () => {
    const f = fakes([settled]);
    expect((await runConversationSweep(deps(f.engine, f.llm, convConfig({ conversationSweepEnabled: false }), db()), { dryRun: false, trigger: 'scheduled' })).ran).toBe(false);
    expect((await runConversationSweep(deps(f.engine, f.llm, convConfig()), { dryRun: false, trigger: 'scheduled' })).ran).toBe(false);
    expect(f.llmCalls()).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it('stops at the first budget refusal and defers the rest without counting errors (#342)', async () => {
    const other: FakeConv = { ...settled, id: 'c9', title: 'Another' };
    const f = fakes([settled, other]);
    let calls = 0;
    f.llm.structuredCall = async () => {
      calls += 1;
      throw new ProviderSpendLimitError('OpenRouter refused calls: key spend limit or credit reached', 'openrouter', null);
    };
    const d = db();
    const mark = iso(30 * HOUR);
    setLastConversationSweepAt(d, mark);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
      expect(calls).toBe(1);
      expect(res).toMatchObject({ errors: 0, deferred: 2, written: 0 });
      expect(res.stopped).toBe('conversation sweep stopped: OpenRouter refused calls: key spend limit or credit reached; the rest is retried next run');
      expect(lastConversationSweepAt(d)).toBe(mark); // incomplete pass → watermark unchanged
    } finally { warn.mockRestore(); }
  });

  it('cold start: the first run sweeps nothing and sets the watermark to sweepStart − settleHours', async () => {
    const f = fakes([settled]);
    const d = db();
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ ran: true, scanned: 0, written: 0 });
    expect(f.llmCalls()).toBe(0);
    const mark = lastConversationSweepAt(d);
    expect(mark).not.toBeNull();
    const lagMs = Date.now() - Date.parse(mark as string);
    expect(lagMs).toBeGreaterThanOrEqual(6 * HOUR - 5000);
    expect(lagMs).toBeLessThan(6 * HOUR + 60_000);
  });

  it('extracts a settled conversation, persists with conversation provenance, ledgers', async () => {
    const f = fakes([settled]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ ran: true, scanned: 1, written: 1, errors: 0, deferred: 0, liveMemoryTotal: 42 });
    expect(f.writes[0]).toMatchObject({
      source: 'curator', scope: 'vault', content: 'Avery runs the curator on qwen',
      evidence: { kind: 'conversation', ref: 'c1' },
    });
    expect((f.writes[0]?.evidence as { hash?: string }).hash).toEqual(expect.any(String));
    expect(conversationLedgerHash(d, 'c1')).toEqual(expect.any(String));
  });

  it('tells the extraction model today in the configured zone (#459)', async () => {
    const f = fakes([settled]);
    const systems: string[] = [];
    const call = f.llm.structuredCall.bind(f.llm);
    f.llm.structuredCall = async req => { systems.push(req.system); return call(req); };
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    await runConversationSweep(deps(f.engine, f.llm, convConfig({ curatorTz: 'Asia/Tokyo' }), d), { dryRun: false, trigger: 'scheduled' });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(Asia\/Tokyo\)\.$/);
  });

  it('counts a consolidation noop as already known and spends the call under the sweep run (#298)', async () => {
    const f = fakes([settled]);
    const create = f.engine.createMemory.bind(f.engine);
    f.engine.createMemory = (async (args: Parameters<Engine['createMemory']>[0]) => ({ ...(await create(args)), operation: 'noop' })) as Engine['createMemory'];
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ written: 0, alreadyKnown: 1, errors: 0 });
    expect(f.writes[0]?.usage).toEqual({ runRef: expect.any(String), sourceRef: 'conversation-sweep' });
    expect(conversationLedgerHash(d, 'c1')).toEqual(expect.any(String));
  });

  it('settle gate: an unsettled conversation is never fetched and never blocks the watermark', async () => {
    const f = fakes([fresh]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.scanned).toBe(0);
    expect(f.calls).not.toContain('get:c2');
    // The watermark must stay BEHIND c2's updated_at so it is seen once settled.
    expect(Date.parse(lastConversationSweepAt(d) as string)).toBeLessThan(Date.parse(iso(1 * HOUR)));
  });

  it('prose floor: a terse conversation is ledgered and skipped with no LLM call', async () => {
    const f = fakes([terse]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ scanned: 1, skippedShort: 1, written: 0 });
    expect(f.llmCalls()).toBe(0);
    expect(conversationLedgerHash(d, 'c3')).toEqual(expect.any(String));
  });

  it('prose floor: a sub-floor conversation is re-examined once it grows past the floor', async () => {
    // M2: the other half of the prose-floor transition — the ledgered hash
    // must NOT survive once the transcript changes (grows past the floor).
    const f = fakes([terse]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res1 = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res1.skippedShort).toBe(1);
    expect(f.llmCalls()).toBe(0);

    const grown: FakeConv = { ...terse, userText: LONG, facts: ['Avery runs the curator on qwen'] };
    const f2 = fakes([grown]);
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res2 = await runConversationSweep(deps(f2.engine, f2.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res2.skippedShort).toBe(0);
    expect(res2.skippedLedger).toBe(0);
    expect(res2.written).toBe(1);
    expect(f2.llmCalls()).toBe(1);
  });

  it('H4: a zero-turn conversation with minUserChars 0 is ledgered without an LLM call, not sent to extraction', async () => {
    // conversationSweepMinUserChars is registry-permitted to be 0, which makes
    // `userChars < floor` (0 < 0) false. Without also checking turns.length===0,
    // a conversation with no text parts at all (droppedParts also 0, so the
    // shape-regression guard's warning does not fire either) would sail past
    // the prose floor and reach a real LLM call with an empty transcript.
    const empty: FakeConv = { id: 'c9', title: 'Empty', updatedAgoMs: 24 * HOUR, userText: '', facts: [], emptyMessages: true };
    const f = fakes([empty]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(
      deps(f.engine, f.llm, convConfig({ conversationSweepMinUserChars: 0 }), d),
      { dryRun: false, trigger: 'scheduled' },
    );
    expect(res.skippedShort).toBe(1);
    expect(f.llmCalls()).toBe(0);
    expect(conversationLedgerHash(d, 'c9')).toEqual(expect.any(String));
  });

  it('ledger gate: an unchanged transcript is skipped without an LLM call', async () => {
    const f = fakes([settled]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    const f2 = fakes([settled]);
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res2 = await runConversationSweep(deps(f2.engine, f2.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res2.skippedLedger).toBe(1);
    expect(f2.llmCalls()).toBe(0);
  });

  it('ledger gate: a changed transcript is re-swept, not skipped', async () => {
    // M2: the other half of the ledger-gate transition.
    const f = fakes([settled]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    const hash1 = conversationLedgerHash(d, 'c1');

    const changed: FakeConv = { ...settled, userText: `${LONG} Also, I prefer dark mode.`, facts: ['Avery prefers dark mode'] };
    const f2 = fakes([changed]);
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res2 = await runConversationSweep(deps(f2.engine, f2.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res2.skippedLedger).toBe(0);
    expect(res2.written).toBe(1);
    expect(f2.llmCalls()).toBe(1);
    expect(conversationLedgerHash(d, 'c1')).not.toBe(hash1);
  });

  it('sends an FTS-safe ALREADY KNOWN search and falls back on search failure', async () => {
    // Title is deliberately hostile (NEAR/parens/*) so this assertion is
    // load-bearing: a call site that passed the raw seed instead of
    // ftsQuery(seed) would leak these operators straight into the query.
    const hostile: FakeConv = { id: 'c4', title: 'NEAR(Model) switch*', updatedAgoMs: 24 * HOUR, userText: LONG, facts: ['hostile-title fact'] };
    const f = fakes([hostile]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    const search = f.calls.find(c => c.startsWith('search:'));
    expect(search).toBeDefined();
    // Slice off the harness's own "search:" call-log prefix (which itself
    // contains a colon) before checking the QUERY for FTS5 operators.
    expect(search?.slice('search:'.length)).not.toMatch(/[():*]/);

    const f2 = fakes([hostile], { searchError: new Error('fts5: syntax error') });
    const d2 = db();
    setLastConversationSweepAt(d2, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f2.engine, f2.llm, convConfig(), d2), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(1);   // non-fatal: extraction continues
    expect(res.errors).toBe(0);
  });

  it('ALREADY KNOWN direction: absent after a successful (even empty) search, present only on search failure', async () => {
    // I1 regression guard: `known` must come from a SUCCESSFUL search — even
    // an empty one — and must fall back to the untargeted list ONLY when the
    // search itself throws. Getting this backwards means every well-targeted
    // empty search silently floods the extraction prompt with the untargeted
    // fallback list instead of an honest "nothing relevant" signal.
    const f = fakes([settled]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(f.userPrompts[0]).not.toContain('ALREADY KNOWN');

    const f2 = fakes([settled], { searchError: new Error('fts5: syntax error') });
    const d2 = db();
    setLastConversationSweepAt(d2, iso(30 * HOUR));
    await runConversationSweep(deps(f2.engine, f2.llm, convConfig(), d2), { dryRun: false, trigger: 'scheduled' });
    expect(f2.userPrompts[0]).toContain('ALREADY KNOWN');
    expect(f2.userPrompts[0]).toContain('UNRELATED FALLBACK FACT');
  });

  it('re-verify expires unsupported priors and fetches them by evidence_ref', async () => {
    const f = fakes([settled], { priorFacts: { c1: [{ id: 41, content: 'stale fact' }] } });
    f.llm.unsupported = [41];
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ expired: 1, reverifiedConversations: 1 });
    expect(f.calls).toContain('priors:c1');
    expect(f.calls).toContain('expire:41:evidence-changed');
  });

  it('an expiry failure fails the conversation unledgered — no path back to retire the stale prior', async () => {
    // I2 regression guard: if a note IS ledgered despite an expiry failure,
    // the ledger hash matches on every subsequent run and the stale prior can
    // never be retried.
    const f = fakes([settled], {
      priorFacts: { c1: [{ id: 41, content: 'stale fact' }] },
      expireError: new Error('expire boom'),
    });
    f.llm.unsupported = [41];
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBeGreaterThanOrEqual(1);
    expect(res.written).toBe(1);   // the new fact is still persisted...
    expect(conversationLedgerHash(d, 'c1')).toBeUndefined();   // ...but the conversation stays unledgered
  });

  it('a failed prior fetch fails the conversation unledgered — never ledger a new hash without the re-check', async () => {
    const f = fakes([settled], { priorFetchError: new Error('boom') });
    const d = db();
    const mark = iso(30 * HOUR);   // capture once — iso() re-reads Date.now()
    setLastConversationSweepAt(d, mark);
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBe(1);
    expect(res.written).toBe(0);
    expect(conversationLedgerHash(d, 'c1')).toBeUndefined();
    expect(lastConversationSweepAt(d)).toBe(mark);  // errored pass → watermark unchanged
  });

  it('a getConversation failure is captured, skipped, and left unledgered', async () => {
    const f = fakes([settled], { getError: new Error('conversation fetch boom') });
    const d = db();
    const mark = iso(30 * HOUR);   // capture once — iso() re-reads Date.now()
    setLastConversationSweepAt(d, mark);
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.errors).toBe(1);
    // Mutation guard: a real getConversation failure still counts the candidate
    // as scanned (it survived the watermark/settle gates before the read failed).
    // Deleting getConversation's local try/catch would still pass every other
    // assertion here because the top-level catch returns the same result shape —
    // but it returns emptyResult(), whose `scanned` is hardcoded 0.
    expect(res.scanned).toBe(1);
    expect(res.written).toBe(0);
    expect(conversationLedgerHash(d, 'c1')).toBeUndefined();
    expect(f.llmCalls()).toBe(0);
    expect(lastConversationSweepAt(d)).toBe(mark);   // errored pass → watermark unchanged
  });

  it('run cap is conversation-granular: the overflowing conversation and everything after defer', async () => {
    const a: FakeConv = { ...settled, id: 'a', title: 'A', facts: ['fact a'] };
    const b: FakeConv = { ...settled, id: 'b', title: 'B', updatedAgoMs: 20 * HOUR, facts: ['fact b1', 'fact b2'] };
    const f = fakes([a, b]);
    const d = db();
    const mark = iso(30 * HOUR);   // capture once — iso() re-reads Date.now()
    setLastConversationSweepAt(d, mark);
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig({ conversationSweepCap: 1 }), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(1);
    expect(res.deferred).toBe(1);
    expect(conversationLedgerHash(d, 'b')).toBeUndefined();
    expect(lastConversationSweepAt(d)).toBe(mark);
  });

  it('halted propagation: everything AFTER the overflow defers with zero engine/LLM calls', async () => {
    // M1: with only two candidates, "if (halted)" never runs — the overflowing
    // conversation IS the last one. A third candidate proves halted skips are
    // truly free: no get-conversation, no ALREADY-KNOWN search, no prior fetch,
    // no LLM call for anything after the conversation that tripped the cap.
    const a: FakeConv = { ...settled, id: 'a', title: 'A', updatedAgoMs: 30 * HOUR, facts: ['fact a'] };
    const b: FakeConv = { ...settled, id: 'b', title: 'B', updatedAgoMs: 20 * HOUR, facts: ['fact b1', 'fact b2'] };
    const c: FakeConv = { ...settled, id: 'c', title: 'C', updatedAgoMs: 10 * HOUR, facts: ['fact c'] };
    const f = fakes([a, b, c]);
    const d = db();
    const mark = iso(40 * HOUR);   // capture once — iso() re-reads Date.now()
    setLastConversationSweepAt(d, mark);
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig({ conversationSweepCap: 1 }), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(1);      // a only
    expect(res.deferred).toBe(2);     // b (overflow) AND c (halted)
    expect(f.calls).not.toContain('get:c');
    expect(f.calls.filter(call => call.startsWith('search:'))).toHaveLength(4);   // a, b — curator + owner each, not c
    expect(f.llmCalls()).toBe(2);     // a, b — c never reached extraction
    expect(conversationLedgerHash(d, 'c')).toBeUndefined();
  });

  it('per-conversation cap slices the model output', async () => {
    const greedy: FakeConv = { ...settled, facts: ['f1', 'f2', 'f3', 'f4'] };
    const f = fakes([greedy]);
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.written).toBe(2);
  });

  it('dry run previews only — no writes, no ledger, no watermark', async () => {
    const f = fakes([settled]);
    const d = db();
    const mark = iso(30 * HOUR);   // capture once — iso() re-reads Date.now()
    setLastConversationSweepAt(d, mark);
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: true, trigger: 'scheduled' });
    expect(res.previews).toBe(1);
    expect(f.writes).toHaveLength(0);
    expect(conversationLedgerHash(d, 'c1')).toBeUndefined();
    expect(lastConversationSweepAt(d)).toBe(mark);
  });

  it('classifies DUPLICATE_MEMORY as non-fatal and still ledgers', async () => {
    const f = fakes([settled], { createError: new EngineError('DUPLICATE_MEMORY', 'dupe') });
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ duplicates: 1, errors: 0 });
    expect(conversationLedgerHash(d, 'c1')).toEqual(expect.any(String));
  });

  it('a listConversations failure is captured, never thrown', async () => {
    const f = fakes([settled], { listError: new Error('transport down') });
    const d = db();
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res).toMatchObject({ ran: true, errors: 1 });
    expect(lastConversationSweepAt(d)).toBeNull();
  });

  it('shape-regression guard: zero turns with dropped parts is counted', async () => {
    const f = fakes([settled]);
    (f.engine as unknown as { getConversation: unknown }).getConversation = async () => ({
      conversation: { id: 'c1', title: 'Model switch', created_at: 'a', updated_at: 'b', archived: 0 },
      messages: [{ role: 'user', parts: [{ type: 'some-future-type', text: 'invisible' }] }],
    });
    const d = db();
    setLastConversationSweepAt(d, iso(30 * HOUR));
    const res = await runConversationSweep(deps(f.engine, f.llm, convConfig(), d), { dryRun: false, trigger: 'scheduled' });
    expect(res.skippedNoText).toBe(1);
    expect(res.skippedShort).toBe(1);   // also below the prose floor → ledgered, no nightly re-warn
    expect(f.llmCalls()).toBe(0);
  });

  it('conversationSweepSince overrides the stored watermark', async () => {
    const f = fakes([settled]);
    const d = db();
    setLastConversationSweepAt(d, iso(1 * HOUR));      // would exclude c1
    const cfg = convConfig({ conversationSweepSince: iso(30 * HOUR) });
    const res = await runConversationSweep(deps(f.engine, f.llm, cfg, d), { dryRun: false, trigger: 'scheduled' });
    expect(res.scanned).toBe(1);
  });
});
