import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { UIMessage } from 'ai';
import { firstExchangeText, sanitizeTitle, generateConversationTitle, runTitleFlow } from '../src/title.js';

const msg = (role: 'user' | 'assistant', text: string): UIMessage =>
  ({ id: `${role}-${text.slice(0, 8)}`, role, parts: [{ type: 'text', text }] }) as UIMessage;

const mockModel = (text: string) => new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    // ai@7 / provider spec v4: usage is nested per direction.
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 6, text: 6 },
    },
    warnings: [],
  }),
});

const CATALOG = [{ title: 'GPT-OSS 120B', provider: 'fireworks' as const, model: 'accounts/fireworks/models/gpt-oss-120b', enabled: true }];
const AVAIL = { fireworks: true, anthropic: false };

describe('sanitizeTitle', () => {
  it('strips think blocks, quotes, trailing punctuation, collapses whitespace', () => {
    expect(sanitizeTitle('<think>hmm the user wants…</think> "Identifying  Project Alpha Task." ')).toBe('Identifying Project Alpha Task');
  });
  it('caps at 80 chars', () => {
    expect(sanitizeTitle('x'.repeat(120))!.length).toBeLessThanOrEqual(80);
  });
  it('returns null when nothing survives', () => {
    expect(sanitizeTitle('<think>only thoughts</think>  ')).toBeNull();
    expect(sanitizeTitle('"…"')).toBeNull();
  });
  it('strips an unterminated think block (truncated by maxOutputTokens)', () => {
    expect(sanitizeTitle('<think>truncated reasoning that never closes')).toBeNull();
    expect(sanitizeTitle('Title Here<think>truncated')).toBe('Title Here');
  });
});

describe('firstExchangeText', () => {
  it('pairs the first non-empty user message with the first assistant reply after it', () => {
    const got = firstExchangeText([msg('user', 'find my project alpha task'), msg('assistant', 'Found it: Project Alpha onboarding.')]);
    expect(got).toEqual({ userText: 'find my project alpha task', assistantText: 'Found it: Project Alpha onboarding.' });
  });
  it('returns null without a user message', () => {
    expect(firstExchangeText([msg('assistant', 'hi')])).toBeNull();
  });
  it('tolerates a missing assistant reply (empty assistantText)', () => {
    expect(firstExchangeText([msg('user', 'hello')])).toEqual({ userText: 'hello', assistantText: '' });
  });
});

describe('generateConversationTitle', () => {
  it('returns sanitized title + usage', async () => {
    const got = await generateConversationTitle({ model: mockModel('"Identifying Project Alpha Task."'), userText: 'u', assistantText: 'a' });
    expect(got?.title).toBe('Identifying Project Alpha Task');
    expect(got?.usage.outputTokens).toBe(6);
  });
  it('returns null on model error', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('boom'); } });
    expect(await generateConversationTitle({ model, userText: 'u', assistantText: 'a' })).toBeNull();
  });
  it('returns null on empty output', async () => {
    expect(await generateConversationTitle({ model: mockModel('  '), userText: 'u', assistantText: 'a' })).toBeNull();
  });
});

describe('runTitleFlow', () => {
  const base = (over: Partial<Parameters<typeof runTitleFlow>[0]>) => ({
    conversationId: 'c1',
    messages: [msg('user', 'find my project alpha task'), msg('assistant', 'Found it.')],
    fallbackTitle: 'find my project alpha task',
    titleModelRef: '[[GPT-OSS 120B]]',
    catalog: CATALOG,
    availability: AVAIL,
    makeModel: () => mockModel('Identifying Project Alpha Task'),
    service: 'chat-web' as const,
    saveTitle: vi.fn(async () => {}),
    recordUsage: vi.fn(),
    log: vi.fn(),
    ...over,
  });

  it('saves the LLM title and records title-generation usage', async () => {
    const o = base({});
    expect(await runTitleFlow(o)).toBe(true);
    expect(o.saveTitle).toHaveBeenCalledWith('Identifying Project Alpha Task');
    expect(o.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'title-generation', service: 'chat-web', conversation_id: 'c1',
      model: 'accounts/fireworks/models/gpt-oss-120b',
    }));
  });
  it("records OpenRouter's reported charge and response id with the title's usage", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Charged Title' }], finishReason: 'stop',
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2 } },
        warnings: [], providerMetadata: { openrouter: { usage: { cost: 0.0002 } } }, response: { id: 'gen-title' },
      }),
    });
    const o = base({ makeModel: () => model });
    expect(await runTitleFlow(o)).toBe(true);
    expect(o.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'title-generation', provider_cost_usd: 0.0002, request_id: 'gen-title',
    }));
  });
  it('falls back to the mechanical title on LLM failure (and records nothing)', async () => {
    const o = base({ makeModel: () => new MockLanguageModelV4({ doGenerate: async () => { throw new Error('down'); } }) });
    expect(await runTitleFlow(o)).toBe(true);
    expect(o.saveTitle).toHaveBeenCalledWith('find my project alpha task');
    expect(o.recordUsage).not.toHaveBeenCalled();
  });
  it('falls back to the mechanical title when makeModel throws synchronously', async () => {
    const o = base({ makeModel: () => { throw new Error('no such model'); } });
    expect(await runTitleFlow(o)).toBe(true);
    expect(o.saveTitle).toHaveBeenCalledWith('find my project alpha task');
    expect(o.recordUsage).not.toHaveBeenCalled();
    expect(o.log).toHaveBeenCalled();
  });
  it('still saves the LLM title when recordUsage throws after successful generation', async () => {
    const o = base({ recordUsage: vi.fn(() => { throw new Error('ledger down'); }) });
    expect(await runTitleFlow(o)).toBe(true);
    expect(o.saveTitle).toHaveBeenCalledWith('Identifying Project Alpha Task');
    expect(o.log).toHaveBeenCalled();
  });
  it('falls back when the ref is unresolvable or the provider key is missing', async () => {
    const o = base({ titleModelRef: '[[Nope]]' });
    expect(await runTitleFlow(o)).toBe(true);
    expect(o.saveTitle).toHaveBeenCalledWith('find my project alpha task');
    expect(o.log).toHaveBeenCalled();
    const o2 = base({ availability: { fireworks: false, anthropic: false } });
    await runTitleFlow(o2);
    expect(o2.saveTitle).toHaveBeenCalledWith('find my project alpha task');
  });
  it('returns false and saves nothing when there is no exchange and no fallback', async () => {
    const o = base({ messages: [msg('assistant', 'hi')], fallbackTitle: null });
    expect(await runTitleFlow(o)).toBe(false);
    expect(o.saveTitle).not.toHaveBeenCalled();
  });
  it('returns false when saveTitle throws (caller resets its guard)', async () => {
    const o = base({ saveTitle: vi.fn(async () => { throw new Error('engine down'); }) });
    expect(await runTitleFlow(o)).toBe(false);
    expect(o.log).toHaveBeenCalled();
  });
});
