import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { interpretVizSpec, buildInterpretSystem, buildInterpretPrompt } from '../src/viz-interpret.js';
import type { VizVocabulary } from '../src/viz-vocab.js';
import type { VizSpec } from '../src/viz-emit.js';

const VOCAB: VizVocabulary = { types: [{ name: 'task', count: 312, fields: [
  { name: 'status', type: 'enum', enum_values: ['open', 'done'] },
  { name: 'due', type: 'date' },
] }] };

const GOOD_SPEC = {
  kind: 'kanban', title: 'open tasks', query: { types: ['task'], fields: { status: { eq: 'open' } } },
  display_fields: ['status', 'due'], group_by: 'status',
};

const USAGE = {
  inputTokens: { total: 200, noCache: 200, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40 },
};

const modelReturning = (...texts: string[]) => {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: texts[Math.min(i++, texts.length - 1)]! }],
      finishReason: 'stop', usage: USAGE, warnings: [],
    }),
  });
};

describe('buildInterpretSystem', () => {
  it('carries the vocabulary and ends with the date line (cache-stable prefix)', () => {
    const sys = buildInterpretSystem(VOCAB, new Date('2026-07-25T10:00:00'));
    expect(sys).toContain('task (312): status: enum(open|done)');
    expect(sys.trimEnd().split('\n').at(-1)).toMatch(/^Today is .*2026-07-25/);
  });

  it('substitutes a judgment-call line instead of a blank line when the vocabulary is empty', () => {
    const sys = buildInterpretSystem({ types: [] });
    expect(sys).toContain('(no schema vocabulary available — use your judgment for type and field names)');
    expect(sys).not.toMatch(/\n\n\n/); // no blank line left where the vocabulary would have rendered
  });
});

describe('buildInterpretPrompt', () => {
  it('tweak mode embeds the current spec and the minimal-change instruction', () => {
    const current = GOOD_SPEC as unknown as VizSpec;
    const p = buildInterpretPrompt('group by due', current);
    expect(p).toContain(JSON.stringify(current));
    expect(p).toContain('ONLY this change');
  });
  it('create mode is just the request', () => {
    expect(buildInterpretPrompt('open tasks')).toContain('open tasks');
    expect(buildInterpretPrompt('open tasks')).not.toContain('ONLY this change');
  });
});

describe('interpretVizSpec', () => {
  it('returns the sanitized spec + usage on a valid object', async () => {
    const got = await interpretVizSpec({ text: 'open tasks', vocab: VOCAB, model: modelReturning(JSON.stringify(GOOD_SPEC)) });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.spec.kind).toBe('kanban');
      expect(got.usage.outputTokens).toBe(40);
    }
  });

  it('retries once on an invalid spec and sums usage across attempts', async () => {
    const bad = JSON.stringify({ ...GOOD_SPEC, kind: 'pie' });
    const got = await interpretVizSpec({ text: 'x', vocab: VOCAB, model: modelReturning(bad, JSON.stringify(GOOD_SPEC)) });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.usage.outputTokens).toBe(80); // 40 + 40
  });

  it('fails after a second invalid attempt with the validation message', async () => {
    const bad = JSON.stringify({ ...GOOD_SPEC, kind: 'pie' });
    const got = await interpretVizSpec({ text: 'x', vocab: VOCAB, model: modelReturning(bad, bad) });
    expect(got).toMatchObject({ ok: false, error: expect.stringContaining('kind') });
  });

  it('strips unknown query keys through sanitizeVizInput', async () => {
    const sneaky = JSON.stringify({ ...GOOD_SPEC, query: { ...GOOD_SPEC.query, evil: 1 } });
    const got = await interpretVizSpec({ text: 'x', vocab: VOCAB, model: modelReturning(sneaky) });
    if (got.ok) expect(got.spec.query).not.toHaveProperty('evil');
  });

  it('reports a model error as ok:false (no throw)', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('relay down'); } });
    const got = await interpretVizSpec({ text: 'x', vocab: VOCAB, model });
    expect(got.ok).toBe(false);
  });

  it('a model whose doGenerate never resolves still settles ok:false within timeoutMs (shared deadline, never hangs)', async () => {
    const model = new MockLanguageModelV4({ doGenerate: () => new Promise<never>(() => {}) });
    const got = await interpretVizSpec({ text: 'x', vocab: VOCAB, model, timeoutMs: 25 });
    expect(got.ok).toBe(false);
  });
});
