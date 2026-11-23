import { pageOutputFrame } from './page-output-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { marked } from 'marked';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { parseTopologyPlan } from '../src/topology.js';
import { validateTopologyPlan } from '../src/topology-validate.js';
import { synthesizeAcceptedPages, synthesizeHomeOverview } from '../src/page-synthesis.js';
import { topicCoverageNote } from '../src/topic-evidence-diagnostics.js';
import { synthesizeTopologyPlan } from '../src/synthesize.js';
import type { ExistingWiki, TopologyPlan } from '../src/types.js';
const wiki: ExistingWiki = { home_id: 'home', home: { id: 'home', version: 1 },
  catalog_valid: true, topology_hash: 'hash', subpages: [] };
const action = (id: string, evidence_ids?: string[]) => ({ op: 'create' as const, plan_key: id,
  title: id, kind: 'freeform' as const, scope: { v: 1 as const, subject: 'Reactor', facet: id },
  synthesis_brief: id, ...(evidence_ids === undefined ? {} : { evidence_ids }) });
const context = { sources: [
  { id: 'n', title: 'Node source', body: 'NATIVE_FACT', priority: 'explicit' as const, availability: 'present' as const,
    origin: { kind: 'node' as const, nodeId: 'n', types: ['note'] } },
  { id: 'web:1', title: 'Web source', body: 'WEB_FACT', priority: 'web' as const, availability: 'present' as const,
    origin: { kind: 'web' as const, url: 'https://example.org/evidence' } },
], query: 'Reactor', topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576 };
function model() {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: pageOutputFrame({
    body: '## Findings\n\nSupported findings from the selected evidence.' }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } });
  return { create, llm: new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI) };
}
describe('topic-only page selection', () => {
  it.each(['<!--', '```text\n', '<div>'])('keeps page and home coverage visible before model-controlled %s', construct => {
    const coverage = topicCoverageNote({ policyVersion: 1, excerpts: [],
      omissions: [{ sourceId: 'n', reason: 'not_selected' }] })!;
    const body = 'Supported narrative.\n\n' + construct + coverage;
    const { create, llm } = model();
    create.mockResolvedValueOnce({ choices: [{ message: { content: pageOutputFrame({ body }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } });
    return (async () => {
      const pages = await synthesizeAcceptedPages(llm, { getNode: vi.fn() }, { model: 'm', existingWiki: wiki,
        evidenceNodes: [], topicEvidence: context, plan: { reviewed_page_ids: [], actions: [action('page', [])] } });
      expect(marked.lexer(pages.pages[0]!.body)[0]).toMatchObject({ type: 'paragraph', text: coverage });
      create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        now: body, focus: [{ title: 'Focus' }], open_threads: [{ title: 'Open' }], log_entry: 'Log' }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const home = await synthesizeHomeOverview(llm, { model: 'm', evidence: '', pageIndex: [],
        requestBudget: { context, selectedIds: [], query: '', maxBytes: 204800 } });
      expect(marked.lexer(home.sections.now)[0]).toMatchObject({ type: 'paragraph', text: coverage });
      expect(home.validatedSections.now).toBe(body);
    })();
  });
  it('preserves missing versus empty IDs and rejects unknown IDs before synthesis', () => {
    const p: TopologyPlan = { reviewed_page_ids: [], actions: [action('first', []), action('second')] };
    const parsed = parseTopologyPlan(p);
    expect(parsed).toEqual({ ok: true, plan: p });
    const invalid = validateTopologyPlan({ ...p, actions: [action('first', ['unknown'])] }, wiki, 'Reactor',
      new Set(context.sources.map(s => s.id)));
    expect(invalid.ok).toBe(false);
  });
  it('gives distinct pages only their selected evidence and includes web attribution', async () => {
    const { create, llm } = model();
    const pages = await synthesizeAcceptedPages(llm, { getNode: vi.fn() }, { model: 'm', existingWiki: wiki,
      evidenceNodes: [], topicEvidence: context,
      plan: { reviewed_page_ids: [], actions: [action('first', ['n']), action('second', ['web:1']), action('empty', [])] } });
    const users = create.mock.calls.map(c => JSON.parse(c[0].messages[1].content).evidence as string);
    expect(users[0]).toContain('NATIVE_FACT'); expect(users[0]).not.toContain('WEB_FACT');
    expect(users[1]).toContain('WEB_FACT'); expect(users[1]).toContain('https://example.org/evidence');
    expect(users[1]).not.toContain('NATIVE_FACT');
    expect(users[2]).not.toContain('NATIVE_FACT'); expect(users[2]).not.toContain('WEB_FACT');
    expect(pages.pages.every(p => p.body.includes('Source coverage:'))).toBe(true);
  });
  it('uses page-relevant fallback IDs when the planner omits selection', async () => {
    const { create, llm } = model();
    const sources = context.sources.map((s, i) => ({ ...s, body: i === 0 ? 'engines engines engine design' : 'orbits orbital periods' }));
    await synthesizeAcceptedPages(llm, { getNode: vi.fn() }, { model: 'm', existingWiki: wiki,
      evidenceNodes: [], topicEvidence: { ...context, sources },
      plan: { reviewed_page_ids: [], actions: [action('engines')] } });
    const evidence = JSON.parse(create.mock.calls[0]?.[0].messages[1].content).evidence;
    expect(evidence).toContain('engine design');
    expect(evidence).not.toContain('orbital periods');
  });
  it('rejects protected page overflow before dispatch, even when bodyCharCap is small', async () => {
    const { create, llm } = model();
    const page = { id: 'page', title: 'History', file_path: 'history.md', version: 1,
      content_hash: 'hash', wiki_state: 'active' as const, wiki_kind: 'freeform' as const,
      wiki_origin: 'automatic' as const, wiki_pinned: false, wiki_scope: { v: 1 as const, subject: 'Reactor', facet: 'history' } };
    await expect(synthesizeAcceptedPages(llm, { getNode: vi.fn(async () => ({
      id: 'page', title: 'History', types: ['wiki'], fields: {}, body: 'P'.repeat(200000) })) },
      { model: 'm', existingWiki: { ...wiki, subpages: [page] }, evidenceNodes: [], topicEvidence: context,
        bodyCharCap: 10, plan: { reviewed_page_ids: ['page'], actions: [{ op: 'refresh', node_id: 'page',
          scope: page.wiki_scope, synthesis_brief: 'update' }] } })).rejects.toThrow(/budget/);
    expect(create).not.toHaveBeenCalled();
  });
  it('measures planner schema, instructions and repair context', async () => {
    const { create, llm } = model();
    await expect(synthesizeTopologyPlan(llm, { model: 'm', existingWiki: wiki, rootTitle: 'Reactor',
      evidence: 'mandatory repair context'.repeat(10000), requestBudget: {
        context, query: 'Reactor', maxBytes: 204800 } })).rejects.toThrow(/budget/);
    expect(create).not.toHaveBeenCalled();
  });
});
