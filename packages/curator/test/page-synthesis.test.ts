import { describe, expect, it, vi } from 'vitest';
import { PAGE_TEMPLATES } from '../src/page-templates.js';
import type OpenAI from 'openai';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { HOME_SECTIONS_TOOL, PAGE_SYNTHESIS_TOOL } from '../src/prompts/page.js';
import {
  accountTopologySynthesis,
  buildPageEvidenceBlock,
  synthesizeAcceptedPages,
  synthesizeHomeOverview,
} from '../src/page-synthesis.js';
import { StructuredCallFailure } from '../src/llm/types.js';
import type { StructuredCallRequest, StructuredCallResult, LlmClient } from '../src/llm/types.js';
import type { EngineNode, ExistingWiki, TokenUsage, TopologyPlan, WikiScopeV1 } from '../src/types.js';
import { estimateCostUsd, ZERO_USAGE } from '../src/pricing.js';
import { BudgetExhaustedError } from '../src/budget.js';

const scope = (facet: string): WikiScopeV1 => ({ v: 1, subject: 'Atlas', facet });
const usage = (value: number): TokenUsage => ({ input: value, output: value, cacheWrite: value, cacheRead: value });
const pageFrame = (body: string) => `<<<VAULT_PAGE_V1>>>\nlog_note:\n<<<VAULT_BODY>>>\n${body}\n<<<END_VAULT_PAGE>>>`;

class SequenceLlm implements LlmClient {
  readonly calls: StructuredCallRequest[] = [];

  constructor(private readonly results: readonly (StructuredCallResult | Error)[]) {}

  async structuredCall(request: StructuredCallRequest): Promise<StructuredCallResult> {
    this.calls.push(request);
    const result = this.results[this.calls.length - 1];
    if (result === undefined) throw new Error('missing fixture result');
    if (result instanceof Error) throw result;
    return result;
  }
}

function node(id: string, title: string, body: string): EngineNode {
  return { id, title, types: ['wiki'], fields: {}, body };
}

const existingWiki: ExistingWiki = {
  home_id: 'home',
  home: { id: 'home', version: 1 },
  topology_hash: 'topology',
  catalog_valid: true,
  subpages: [
    {
      id: 'refresh', title: 'Refresh page', file_path: 'Wikis/Refresh.md', version: 2,
      content_hash: 'refresh-hash', wiki_state: 'active', wiki_kind: 'timeline',
      wiki_origin: 'automatic', wiki_scope: scope('old refresh'), wiki_pinned: false,
    },
    {
      id: 'source', title: 'Source page', file_path: 'Wikis/Source.md', version: 3,
      content_hash: 'source-hash', wiki_state: 'active', wiki_kind: 'workstream',
      wiki_origin: 'automatic', wiki_scope: scope('source'), wiki_pinned: false,
    },
    {
      id: 'target', title: 'Target page', file_path: 'Wikis/Target.md', version: 4,
      content_hash: 'target-hash', wiki_state: 'active', wiki_kind: 'workstream',
      wiki_origin: 'automatic', wiki_scope: scope('target'), wiki_pinned: false,
    },
    {
      id: 'retire', title: 'Retire page', file_path: 'Wikis/Retire.md', version: 1,
      content_hash: 'retire-hash', wiki_state: 'active', wiki_kind: 'freeform',
      wiki_origin: 'automatic', wiki_scope: scope('retire'), wiki_pinned: false,
    },
  ],
};

function engine(nodes: readonly EngineNode[]) {
  const byId = new Map(nodes.map(item => [item.id, item]));
  const reads: string[] = [];
  return {
    reads,
    getNode: async (id: string) => {
      reads.push(id);
      const found = byId.get(id);
      if (found === undefined) throw new Error(`missing node ${id}`);
      return found;
    },
  };
}

describe('synthesizeAcceptedPages', () => {
  it('rejects a filtered fenced page without provenance capture or a paid retry', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '```json\n{"body":"# Timeline\\n\\nA filtered update."}\n```' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { fireworksExtensions: false });
    await expect(synthesizeAcceptedPages(llm, engine([]), {
      model: 'qwen/qwen3.7-plus', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Timeline', kind: 'timeline', scope: scope('timeline'), synthesis_brief: 'Summarize the timeline.' }] },
    })).rejects.toMatchObject({ message: expect.stringContaining('content_filtered'), usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('omits API schema mode for pages but retains it for home (Fireworks extensions: %s)', async fireworksExtensions => {
    const body = '# Timeline\n\nA grounded update.\n\n- Meeting scheduled.';
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: pageFrame(body) }, finish_reason: 'stop' }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }) }, finish_reason: 'stop' }] });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const llm = new OpenAiCompatLlmClient(client, { fireworksExtensions });
    const result = await synthesizeAcceptedPages(llm, engine([]), {
      model: 'qwen/qwen3.7-plus', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Timeline', kind: 'timeline', scope: scope('timeline'), synthesis_brief: 'Summarize the timeline.' }] },
    });
    expect(result.pages[0]?.body).toBe(body);
    const pageParams = create.mock.calls[0]![0] as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    expect(pageParams).not.toHaveProperty('response_format');
    expect(pageParams.messages[0]?.content).toContain('<<<VAULT_PAGE_V1>>>');
    expect(pageParams.messages[0]?.content).not.toContain('Respond with a single JSON object');

    await synthesizeHomeOverview(llm, { model: 'qwen/qwen3.7-plus', evidence: 'Source evidence', pageIndex: [] });
    const homeParams = create.mock.calls[1]![0] as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    expect(homeParams.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: HOME_SECTIONS_TOOL.name, schema: HOME_SECTIONS_TOOL.schema },
    });
  });

  it.each([
    { content: 'not an envelope', error: /invalid_page_envelope/, attempts: 1 },
    { content: '```json\n{"body":"Narrative."}\n```', error: /invalid_page_envelope/, attempts: 1 },
    { content: '{"body":"Narrative.","actions":[]}', error: /invalid_page_envelope/, attempts: 1 },
    { content: pageFrame('# Timeline'), error: /headings but no narrative/, attempts: 1 },
    { content: pageFrame('Narrative.## Timeline - Meeting'), error: /collapsed Markdown headings/, attempts: 1 },
  ])('rejects invalid page content without API schema mode: $content', async ({ content, error, attempts }) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { fireworksExtensions: false });
    try {
      await expect(synthesizeAcceptedPages(llm, engine([]), {
        model: 'qwen/qwen3.7-plus', existingWiki, evidenceNodes: [],
        plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Timeline', kind: 'timeline', scope: scope('timeline'), synthesis_brief: 'Summarize the timeline.' }] },
      })).rejects.toMatchObject({
        message: expect.stringMatching(error),
        usage: { input: 10 * attempts, output: 5 * attempts, cacheWrite: 0, cacheRead: 0 },
      });
      expect(create).toHaveBeenCalledTimes(attempts);
      for (const [params] of create.mock.calls) expect(params).not.toHaveProperty('response_format');
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    '<!-- ve:managed:Summary -->\n# Timeline\n\n- Meeting\n<!-- /ve:managed:Summary -->',
    '# Timeline## August### Kickoff- Meeting',
    '# Stakeholders\n\n| Name | Role ||---|---|| Alex | Owner |',
    '# Timeline',
    '# Timeline\n\n<!-- No new events -->',
    '# Timeline\n\n---',
    'The launch is scheduled.## Timeline\n\n- Meeting',
  ])('rejects malformed page output before returning a writable result: %s', body => {
    const llm = new SequenceLlm([{ output: { body }, usage: usage(1) }]);
    return expect(synthesizeAcceptedPages(llm, engine([]), {
      model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Timeline', kind: 'timeline', scope: scope('timeline'), synthesis_brief: 'Summarize the timeline.' }] },
    })).rejects.toThrow(/page synthesis/i);
  });

  it('accepts code examples and preserves actual Markdown line breaks', async () => {
    const body = '# Matching `foo## bar`\n\nThis pattern is used by the parser.\n\n```md\n# Timeline## August\n```';
    const llm = new SequenceLlm([{ output: { body }, usage: usage(1) }]);
    const result = await synthesizeAcceptedPages(llm, engine([]), {
      model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Patterns', kind: 'freeform', scope: scope('patterns'), synthesis_brief: 'Explain matching patterns.' }] },
    });
    expect(result.pages[0]!.body).toBe(body);
  });

  it('removes JSON escaping the model copied into a quoted note title link', async () => {
    // A project's Timeline page linked [[Alex - Sam Enterprise \"Demo\"]].
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content:
      '<<<VAULT_PAGE_V1>>>\nlog_note: Added [[Alex - Sam Enterprise \\"Demo\\"]].\n<<<VAULT_BODY>>>\n'
      + '## Recent\n\n- Demo session ([[Alex - Sam Enterprise \\"Demo\\"]]); the "Enterprise Demo" \\"name\\" stays.\n<<<END_VAULT_PAGE>>>' },
    finish_reason: 'stop' }] });
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { fireworksExtensions: false });
    const result = await synthesizeAcceptedPages(llm, engine([]), {
      model: 'qwen/qwen3.7-plus', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Timeline', kind: 'timeline', scope: scope('timeline'), synthesis_brief: 'Summarize the timeline.' }] },
    });
    expect(result.pages[0]).toMatchObject({
      body: '## Recent\n\n- Demo session ([[Alex - Sam Enterprise "Demo"]]); the "Enterprise Demo" \\"name\\" stays.',
      log_note: 'Added [[Alex - Sam Enterprise "Demo"]].',
    });
  });

  it('sends each page its kind\'s template on create and refresh', async () => {
    const llm = new SequenceLlm([{ output: { body: '## Upcoming\n\n- Launch' }, usage: usage(1) },
      { output: { body: '## Current risks\n\n- Vendor delay' }, usage: usage(1) }]);
    await synthesizeAcceptedPages(llm, engine([node('refresh', 'Refresh page', 'Old timeline.')]), {
      model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: ['refresh'], actions: [
        { op: 'refresh', node_id: 'refresh', scope: scope('timeline'), synthesis_brief: 'Update the timeline.' },
        { op: 'create', plan_key: 'risks', title: 'Risks', kind: 'risk-register', scope: scope('risks'), synthesis_brief: 'List risks.' },
      ] },
    });
    const templates = llm.calls.map(call => JSON.parse(call.user).template);
    expect(templates).toEqual([
      { headings: PAGE_TEMPLATES.timeline.headings, guidance: PAGE_TEMPLATES.timeline.guidance },
      { headings: PAGE_TEMPLATES['risk-register'].headings, guidance: PAGE_TEMPLATES['risk-register'].guidance },
    ]);
    expect(llm.calls[0]!.system).toContain('Use the template\'s headings as ## sections');
  });

  it('uses narrative and owner notes as refresh context without control markers or old logs', async () => {
    const llm = new SequenceLlm([{ output: { body: '# Timeline\n\n- New meeting' }, usage: usage(1) }]);
    await synthesizeAcceptedPages(llm, engine([node('refresh', 'Refresh page', [
      'Owner steering.', '<!-- ve:managed:Summary -->', '# Timeline', '', '- Meeting',
      '<!-- /ve:managed:Summary -->', '<!-- ve:managed:Log -->', 'OLD LOG', '<!-- /ve:managed:Log -->',
      'Owner afterword.',
    ].join('\n'))]), {
      model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: ['refresh'], actions: [{ op: 'refresh', node_id: 'refresh', scope: scope('timeline'), synthesis_brief: 'Update the timeline.' }] },
    });
    const body = JSON.parse(llm.calls[0]!.user).current_target.body;
    expect(body).toContain('# Timeline\n\n- Meeting');
    expect(body).toContain('Owner steering.');
    expect(body).toContain('Owner afterword.');
    expect(body).not.toContain('ve:managed:');
    expect(body).not.toContain('OLD LOG');
  });

  it.each([
    '<!-- ve:managed:Summary -->old<!-- /ve:managed:Summary --><!-- /ve:managed:Summary -->',
    '<!-- ve:managed: -->old<!-- /ve:managed: -->',
    '<!-- ve:managed: Summary -->old<!-- /ve:managed:Summary -->',
    '<!-- ve:managed:Summary -->old<!-- /ve:managed: Summary -->',
    '<!-- ve:managed:\tSummary -->old<!-- /ve:managed:\tSummary -->',
    '<!-- ve:managed:\u00a0Summary -->old<!-- /ve:managed:\u00a0Summary -->',
  ])('stops before a paid page call when existing section boundaries are corrupt: %s', async body => {
    const llm = new SequenceLlm([{ output: { body: 'New narrative' }, usage: usage(1) }]);
    await expect(synthesizeAcceptedPages(llm, engine([node('refresh', 'Refresh page', body)]), {
      model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [],
      plan: { reviewed_page_ids: ['refresh'], actions: [{ op: 'refresh', node_id: 'refresh', scope: scope('timeline'), synthesis_brief: 'Update the timeline.' }] },
    })).rejects.toMatchObject({ message: expect.stringMatching(/repair/i), usage: usage(0) });
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    { failure: { output: { body: '# Empty' }, usage: usage(3) }, expected: 5 },
    { failure: { output: { body: '' }, usage: usage(3) }, expected: 5 },
    { failure: new StructuredCallFailure('Invalid provider output', usage(3)), expected: 5 },
    { failure: new Error('Transport unavailable'), expected: 2 },
  ])('carries known usage across a failed page batch: $failure', async ({ failure, expected }) => {
    const llm = new SequenceLlm([{ output: { body: 'First narrative.' }, usage: usage(2) }, failure]);
    const plan: TopologyPlan = { reviewed_page_ids: [], actions: ['first', 'second'].map(key => ({
      op: 'create', plan_key: key, title: key, kind: 'timeline', scope: scope(key), synthesis_brief: 'Brief.',
    })) };
    await expect(synthesizeAcceptedPages(llm, engine([]), {
      model: 'claude-sonnet-4-6', plan, existingWiki, evidenceNodes: [],
    })).rejects.toMatchObject({ name: 'PageSynthesisError', usage: usage(expected) });
  });

  it('retains earlier page usage when corrupt context prevents the next call', async () => {
    const llm = new SequenceLlm([{ output: { body: 'First narrative.' }, usage: usage(2) }]);
    const plan: TopologyPlan = { reviewed_page_ids: ['refresh'], actions: [
      { op: 'create', plan_key: 'first', title: 'First', kind: 'timeline', scope: scope('first'), synthesis_brief: 'Brief.' },
      { op: 'refresh', node_id: 'refresh', scope: scope('refresh'), synthesis_brief: 'Brief.' },
    ] };
    await expect(synthesizeAcceptedPages(llm, engine([node('refresh', 'Refresh', '<!-- /ve:managed:Summary -->')]), {
      model: 'claude-sonnet-4-6', plan, existingWiki, evidenceNodes: [],
    })).rejects.toMatchObject({ usage: usage(2) });
  });

  it.each(['wiki', 'knowledge-page'])('sanitizes known wiki evidence independently of type: %s', async wikiType => {
    const wikiHome = node('home', 'Project Wiki', [
      'Owner note.', '<!-- ve:managed:Summary -->', 'Current narrative.', '<!-- /ve:managed:Summary -->',
      '<!-- ve:live:tasks -->', 'Old task appendix.', '<!-- /ve:live:tasks -->',
      '<!-- ve:managed:Log -->', 'Old log.', '<!-- /ve:managed:Log -->',
    ].join('\n'));
    const home = { ...wikiHome, types: [wikiType] };
    const catalogPage = { ...home, id: 'refresh', title: 'Catalog page' };
    const note = { ...node('note', 'Source note', 'Original source text.'), types: ['note'] };
    const llm = new SequenceLlm([{ output: { body: 'A grounded page.' }, usage: usage(1) }]);
    await synthesizeAcceptedPages(llm, engine([]), {
      model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [home, catalogPage, note], bodyCharCap: 100,
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'New', kind: 'timeline', scope: scope('new'), synthesis_brief: 'Brief.' }] },
    });
    const evidence = JSON.parse(llm.calls[0]!.user).evidence;
    expect(evidence).toContain('Owner note.');
    expect(evidence).toContain('Current narrative.');
    expect(evidence).toContain('[refresh] Catalog page');
    expect(evidence).toContain('Original source text.');
    expect(evidence).not.toMatch(/ve:|Old log|Old task appendix|truncated/);
    const rawNote = { ...note, body: '<!-- ve:managed:Summary -->quoted example<!-- /ve:managed:Summary -->' };
    expect(buildPageEvidenceBlock([rawNote], [], null)).toContain(rawNote.body);
  });

  it('rejects corrupt selected wiki evidence before a paid page call', async () => {
    const llm = new SequenceLlm([]);
    await expect(synthesizeAcceptedPages(llm, engine([]), {
      model: 'claude-sonnet-4-6', existingWiki,
      evidenceNodes: [node('home', 'Project Wiki', '<!-- /ve:managed:Summary -->')],
      plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'New', kind: 'timeline', scope: scope('new'), synthesis_brief: 'Brief.' }] },
    })).rejects.toMatchObject({ message: expect.stringContaining('repair'), usage: usage(0) });
    expect(llm.calls).toHaveLength(0);
  });

  it('selects cited evidence IDs and otherwise falls back to all bounded home reads', () => {
    // Given: two existing home reads and one cited source.
    const nodes = [node('e1', 'One', 'A'.repeat(20)), node('e2', 'Two', 'second body')];

    // When: page evidence is built with and without emitted IDs.
    const selected = buildPageEvidenceBlock(nodes, ['e1', 'missing'], 5);
    const fallback = buildPageEvidenceBlock(nodes, [], 100);

    // Then: citations select real nodes only, while omission reuses every home read.
    expect(selected).toContain('[e1] One');
    expect(selected).toContain('[truncated 15 chars]');
    expect(selected).not.toContain('[e2] Two');
    expect(selected).not.toContain('missing');
    expect(fallback).toContain('[e1] One');
    expect(fallback).toContain('[e2] Two');
  });

  it('skips keep/retire and synthesizes changed targets sequentially with accepted metadata', async () => {
    // Given: accepted actions in deterministic order and model output containing no topology fields.
    const plan: TopologyPlan = {
      reviewed_page_ids: ['refresh', 'source', 'target', 'retire'],
      actions: [
        { op: 'keep', node_id: 'source', scope: scope('source') },
        { op: 'refresh', node_id: 'refresh', scope: scope('fresh refresh'), synthesis_brief: 'Refresh from evidence e1.' },
        { op: 'retire', node_id: 'retire', scope: scope('retire'), state: 'retired', reason: 'Done.' },
        { op: 'create', plan_key: 'new-page', title: 'Accepted title', kind: 'risk-register', scope: scope('new risks'), synthesis_brief: 'Create from evidence e2.' },
      ],
    };
    const llm = new SequenceLlm([
      { output: { body: 'Refreshed body', log_note: 'Refreshed.' }, usage: usage(1) },
      { output: { body: 'Created body' }, usage: usage(2) },
    ]);
    const reader = engine([node('refresh', 'Refresh page', 'CURRENT REFRESH BODY')]);

    // When: changed targets are synthesized.
    const result = await synthesizeAcceptedPages(llm, reader, {
      model: 'claude-sonnet-4-6', plan, existingWiki,
      evidenceNodes: [node('e1', 'Evidence one', 'EVIDENCE ONE'), node('e2', 'Evidence two', 'EVIDENCE TWO')],
      evidenceIdsByTarget: { refresh: ['e1'], 'new-page': ['e2'] },
    });

    // Then: only changed targets call the model, in action order, and results retain accepted identity.
    expect(llm.calls.map(call => call.toolName)).toEqual(['emit_scoped_page', 'emit_scoped_page']);
    expect(reader.reads).toEqual(['refresh']);
    expect(result.pages.map(page => page.target)).toEqual([{ node_id: 'refresh' }, { plan_key: 'new-page' }]);
    expect(result.usage).toEqual(usage(3));
    expect(JSON.parse(llm.calls[0]?.user ?? '')).toMatchObject({
      action: 'refresh', title: 'Refresh page', kind: 'timeline', scope: scope('fresh refresh'),
      current_target: { id: 'refresh', body: 'CURRENT REFRESH BODY' },
    });
    expect(JSON.parse(llm.calls[1]?.user ?? '')).toMatchObject({
      action: 'create', title: 'Accepted title', kind: 'risk-register', scope: scope('new risks'),
    });
  });

  it('includes every bounded merge body and aborts without a partial result on any page failure', async () => {
    // Given: a merge followed by a create whose synthesis fails.
    const plan: TopologyPlan = {
      reviewed_page_ids: ['refresh', 'source', 'target', 'retire'],
      actions: [
        { op: 'merge', target: { node_id: 'target' }, sources: ['source'], scope: scope('combined'), reason: 'Overlap.', synthesis_brief: 'Consolidate.' },
        { op: 'create', plan_key: 'later', title: 'Later', kind: 'freeform', scope: scope('later'), synthesis_brief: 'Later brief.' },
      ],
    };
    const llm = new SequenceLlm([
      { output: { body: 'Merged body' }, usage: usage(1) },
      new Error('provider unavailable'),
    ]);
    const reader = engine([
      node('source', 'Source page', 'S'.repeat(30)),
      node('target', 'Target page', 'T'.repeat(30)),
    ]);

    // When: the accepted batch is synthesized.
    const pending = synthesizeAcceptedPages(llm, reader, {
      model: 'claude-sonnet-4-6', plan, existingWiki, evidenceNodes: [], bodyCharCap: 10,
    });

    // Then: the whole call rejects, while merge context included each labeled bounded body.
    await expect(pending).rejects.toThrow('provider unavailable');
    expect(reader.reads).toEqual(['target', 'source']);
    const payload = JSON.parse(llm.calls[0]?.user ?? '');
    expect(payload.current_target.body).toContain('[truncated 20 chars]');
    expect(payload.merge_sources).toEqual([{ id: 'source', title: 'Source page', body: expect.stringContaining('[truncated 20 chars]') }]);
  });

  it('rejects empty output and does not let model output redefine accepted topology', async () => {
    // Given: a model attempts to emit identity fields alongside an empty body.
    const plan: TopologyPlan = {
      reviewed_page_ids: [],
      actions: [{ op: 'create', plan_key: 'created', title: 'Canonical', kind: 'timeline', scope: scope('canonical'), synthesis_brief: 'Brief.' }],
    };
    const llm = new SequenceLlm([{ output: { body: ' ', title: 'Changed', kind: 'freeform', scope: scope('changed') }, usage: usage(1) }]);

    // When/Then: strict page parsing aborts rather than accepting any identity mutation.
    await expect(synthesizeAcceptedPages(llm, engine([]), {
      model: 'claude-sonnet-4-6', plan, existingWiki: { ...existingWiki, subpages: [] }, evidenceNodes: [],
    })).rejects.toThrow(/page synthesis/i);
  });
});

describe('malformed page retry', () => {
  const plan: TopologyPlan = { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Timeline', kind: 'timeline', scope: scope('timeline'), synthesis_brief: 'Summarize the timeline.' }] };
  const reply = (content: string | null, finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const body = '# Timeline\n\nA grounded update.';
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it.each([
    ['a wrong envelope', 'not an envelope'],
    ['no text', ''],
    ['an invalid body', pageFrame('# Timeline')],
  ])('retries %s once and keeps both attempts billed', async (_label, content) => {
    const warning = quiet();
    const create = vi.fn().mockResolvedValueOnce(reply(content)).mockResolvedValueOnce(reply(pageFrame(body)));
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { fireworksExtensions: false });
    try {
      const result = await synthesizeAcceptedPages(llm, engine([]), { model: 'qwen/qwen3.7-plus', existingWiki, evidenceNodes: [], plan, retryMalformed: true });
      expect(result.pages.map(page => page.body)).toEqual([body]);
      expect(result.usage).toEqual({ input: 20, output: 10, cacheWrite: 0, cacheRead: 0 });
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    } finally {
      warning.mockRestore();
    }
  });

  it('fails the page when the retry is malformed too', async () => {
    const warning = quiet();
    const create = vi.fn().mockResolvedValue(reply('not an envelope'));
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { fireworksExtensions: false });
    try {
      await expect(synthesizeAcceptedPages(llm, engine([]), { model: 'qwen/qwen3.7-plus', existingWiki, evidenceNodes: [], plan, retryMalformed: true }))
        .rejects.toMatchObject({ message: expect.stringMatching(/invalid_page_envelope/), usage: { input: 20, output: 10, cacheWrite: 0, cacheRead: 0 } });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    ['truncation', reply(pageFrame(body), 'length'), /truncated/],
    ['a content filter', reply(pageFrame(body), 'content_filter'), /content_filtered/],
    ['a provider failure', new Error('provider unavailable'), /Page synthesis failed/],
  ])('does not retry %s', async (_label, outcome, error) => {
    const warning = quiet();
    const create = outcome instanceof Error ? vi.fn().mockRejectedValue(outcome) : vi.fn().mockResolvedValue(outcome);
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { fireworksExtensions: false });
    try {
      await expect(synthesizeAcceptedPages(llm, engine([]), { model: 'qwen/qwen3.7-plus', existingWiki, evidenceNodes: [], plan, retryMalformed: true }))
        .rejects.toThrow(error);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('stops at a budget refusal on the retry', async () => {
    const llm = new SequenceLlm([
      new StructuredCallFailure('bad envelope', usage(1), 'invalid_page_envelope'),
      new BudgetExhaustedError('daily budget exhausted: spent 100c of 100c'),
    ]);
    await expect(synthesizeAcceptedPages(llm, engine([]), { model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [], plan, retryMalformed: true }))
      .rejects.toMatchObject({ message: expect.stringContaining('daily budget exhausted'), usage: usage(1) });
    expect(llm.calls).toHaveLength(2);
  });

  it('fails the first capture and stages only the retried page', async () => {
    const results: (StructuredCallResult | Error)[] = [new StructuredCallFailure('no text', usage(1), 'invalid_content_type'), { output: { body }, usage: usage(2) }];
    const calls: (number | undefined)[] = [];
    const llm: LlmClient = { supportsPreparedCapture: true, structuredCall: async request => {
      calls.push(request.wikiContext?.attempt);
      const next = results.shift()!;
      if (next instanceof Error) throw next;
      return next;
    } };
    const captures: string[] = [];
    let opened = 0;
    const result = await synthesizeAcceptedPages(llm, engine([]), {
      model: 'claude-sonnet-4-6', existingWiki, evidenceNodes: [], plan, retryMalformed: true,
      wikiContext: { policyVersion: 1, maxTokens: 1000, configuration: { provider: 'openrouter', reasoningEffort: null } },
      captureFactory: () => {
        const id = opened++;
        captures.push(`open-${id}`);
        return { onPrepared: async () => {}, stage: async () => { captures.push(`stage-${id}`); return null; }, fail: async () => { captures.push(`fail-${id}`); } };
      },
    });
    expect(result.pages.map(page => page.body)).toEqual([body]);
    expect(result.usage).toEqual(usage(3));
    expect(captures).toEqual(['open-0', 'fail-0', 'open-1', 'stage-1']);
    expect(calls).toEqual([0, 1]);
  });
});

describe('synthesizeHomeOverview', () => {
  it.each(['# Current status', 'Name | Role\n--- | ---\nAlex | Owner', '`Name | Role |--- | --- |Alex | Owner |`',
    '```md\nName | Role |--- | --- |Alex | Owner |\n```'])(
    'preserves valid section content and absent optional sections: %s', now => {
      const llm = new SequenceLlm([{ output: { now, focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }, usage: usage(1) }]);
      return expect(synthesizeHomeOverview(llm, { model: 'test', evidence: '', pageIndex: [] }))
        .resolves.toMatchObject({ sections: { now }, usage: usage(1) });
    },
  );

  it('removes JSON escaping the model copied into home links', async () => {
    const llm = new SequenceLlm([{ output: { now: 'See [[Alex - Sam Enterprise \\"Demo\\"]].', log_entry: 'Log',
      focus: [{ title: 'Follow up', detail: 'From [[Alex - Sam Enterprise \\"Demo\\"|the demo]].' }], open_threads: [{ title: 'Open' }] },
    usage: usage(1) }]);
    const home = await synthesizeHomeOverview(llm, { model: 'test', evidence: '', pageIndex: [] });
    expect(home.sections.now).toBe('See [[Alex - Sam Enterprise "Demo"]].');
    expect(home.sections.focus).toBe('- [ ] **Follow up** — From [[Alex - Sam Enterprise "Demo"|the demo]].');
    expect(home.validatedSections.focus).toBe(home.sections.focus);
  });

  it('retains billed home usage when section validation rejects the result', async () => {
    const llm = new SequenceLlm([{ output: { now: 'Name | Role |--- | --- |Alex | Owner |', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }, usage: usage(4) }]);
    await expect(synthesizeHomeOverview(llm, { model: 'test', evidence: '', pageIndex: [] }))
      .rejects.toMatchObject({ name: 'PageSynthesisError', usage: usage(4) });
  });

  it('receives the accepted post-plan page index but exposes no topology output fields', async () => {
    // Given: a final accepted index and a valid home-only response.
    const llm = new SequenceLlm([{ output: { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log', memories: [] }, usage: usage(4) }]);
    const pageIndex = [
      { target: { plan_key: 'new-page' }, title: 'Accepted title', scope: scope('new risks'), action: 'create' as const },
      { target: { node_id: 'retire' }, title: 'Retire page', scope: scope('retire'), action: 'retire' as const },
    ];

    // When: home prose is synthesized after page topology.
    const result = await synthesizeHomeOverview(llm, {
      model: 'claude-sonnet-4-6', evidence: 'HOME EVIDENCE', pageIndex,
    });

    // Then: the final index is input-only and the schema cannot emit plan changes.
    expect(JSON.parse(llm.calls[0]?.user ?? '')).toEqual({ evidence: 'HOME EVIDENCE', accepted_page_index: pageIndex });
    const schema = llm.calls[0]?.schema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).not.toEqual(expect.arrayContaining(['themed_pages', 'retire_pages']));
    expect(result.sections.now).toBe('Now');
    expect(result.usage).toEqual(usage(4));
  });
});

describe('accountTopologySynthesis', () => {
  it('sums cache-aware usage across planner, adjudicator, pages, and home and prices the total', () => {
    // Given/When: each stage reports distinct token usage.
    const sonnet = 'claude-sonnet-4-6';
    const result = accountTopologySynthesis({ planning: sonnet, page: sonnet, home: sonnet }, {
      planner: usage(1), adjudicator: usage(2), page: usage(3), home: usage(4),
    });

    // Then: every stage contributes to the aggregate and configured-model cost.
    expect(result.usage).toEqual(usage(10));
    expect(result.costUsd).toBeCloseTo(0.0002205, 8);
  });

  it('prices each stage with its own model', () => {
    const pageModel = 'accounts/fireworks/models/deepseek-v4-flash';
    const result = accountTopologySynthesis({ planning: 'claude-sonnet-4-6', page: pageModel, home: 'claude-sonnet-4-6' }, {
      planner: usage(1), adjudicator: usage(2), page: usage(3), home: usage(4),
    });

    expect(result.usage).toEqual(usage(10));
    expect(result.costUsd).toBeCloseTo(estimateCostUsd('claude-sonnet-4-6', usage(7))! + estimateCostUsd(pageModel, usage(3))!, 10);
  });

  it('reports unknown cost when any stage model has no pricing', () => {
    const models = { planning: 'claude-sonnet-4-6', page: 'unpriced/model', home: 'claude-sonnet-4-6' };
    expect(accountTopologySynthesis(models, { planner: usage(1), adjudicator: ZERO_USAGE, page: usage(2), home: usage(3) }).costUsd).toBeNull();
  });

  it('prices a model the static table lacks from the given rates (#356)', () => {
    const models = { planning: 'catalog/model', page: 'catalog/model', home: 'catalog/model' };
    const stages = { planner: usage(1), adjudicator: ZERO_USAGE, page: ZERO_USAGE, home: ZERO_USAGE };
    expect(accountTopologySynthesis(models, stages).costUsd).toBeNull();
    const rates = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    expect(accountTopologySynthesis(models, stages, model => (model === 'catalog/model' ? rates : null)).costUsd).toBeGreaterThan(0);
  });

  it('prices a single shared model exactly like the combined estimate', () => {
    const sonnet = 'claude-sonnet-4-6';
    const stages = { planner: usage(1), adjudicator: usage(2), page: usage(3), home: usage(4) };
    expect(accountTopologySynthesis({ planning: sonnet, page: sonnet, home: sonnet }, stages).costUsd)
      .toBe(estimateCostUsd(sonnet, usage(10)));
  });
});

it('redacts unprojected wrapper errors when page capture is enabled', async () => {
  const llm: LlmClient = { supportsPreparedCapture: true,
    structuredCall: async () => { throw new StructuredCallFailure('PRIVATE WRAPPER CONTENT', usage(3)); } };
  await expect(synthesizeAcceptedPages(llm, engine([]), {
    model: 'synthetic', existingWiki, evidenceNodes: [],
    plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Page', kind: 'freeform', scope: scope('new'), synthesis_brief: 'Brief' }] },
    captureFactory: () => ({ onPrepared: async () => {}, stage: async () => null, fail: async () => {} }),
  })).rejects.toMatchObject({ message: expect.stringContaining('reason=provider_call_failed'), usage: usage(3) });
});

it('freezes the complete prompt before the capture factory previews it', async () => {
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create: async () => ({ choices: [{ message: { content: pageFrame('Narrative.') }, finish_reason: 'stop' }] }) } } } as unknown as OpenAI);
  let checked = false;
  await synthesizeAcceptedPages({
    supportsPreparedCapture: true,
    structuredCall: request => {
      expect(Object.isFrozen(request)).toBe(true);
      return llm.structuredCall(request);
    },
  }, engine([]), {
    model: 'synthetic', existingWiki, evidenceNodes: [],
    plan: { reviewed_page_ids: [], actions: [{ op: 'create', plan_key: 'new', title: 'Page', kind: 'freeform', scope: scope('new'), synthesis_brief: 'Brief' }] },
    captureFactory: (_target, request) => {
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.schema)).toBe(true);
      expect(Object.isFrozen(request.schema.properties)).toBe(true);
      checked = true;
      return { onPrepared: async () => {}, stage: async () => null, fail: async () => {} };
    },
  });
  expect(checked).toBe(true);
});
