import { describe, expect, it, vi } from 'vitest';
import { selectTopicEvidence, renderTopicEvidence, type TopicEvidenceSource } from '../src/topic-evidence-selection.js';
import { fitTopicRequest } from '../src/topic-request-budget.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type OpenAI from 'openai';
const source = (id: string, body: string, priority: TopicEvidenceSource['priority'] = 'semantic'): TopicEvidenceSource =>
  ({ id, title: id, body, priority, availability: 'present', origin: { kind: 'node', nodeId: id, types: ['note'] } });
const select = (sources: TopicEvidenceSource[], totalTextBytes = 1000, selectedIds?: string[]) =>
  selectTopicEvidence({ sources, query: 'reactor safety', totalTextBytes, perSourceBytes: 24576, selectedIds });
describe('topic evidence selection', () => {
  it.each(['Reactor', 'Ｒｅａｃｔｏｒ'])('retains a late %s match inside an oversized paragraph with its headings', keyword => {
    const body = '# Manual\n\n## Draft — not approved\n\n' + 'unrelated 😀 background '.repeat(3000)
      + keyword + ' safety: keep the interlock enabled. ' + 'more background 😀 '.repeat(3000);
    const selected = select([source('transcript', body)], 220);
    const excerpt = selected.excerpts[0]!;
    expect(excerpt.text).toContain(keyword + ' safety: keep the interlock enabled.');
    expect(excerpt.text).toContain('# Manual');
    expect(excerpt.text).toContain('## Draft — not approved');
    expect(excerpt.text).not.toContain('�');
    expect(excerpt.retainedBytes).toBeLessThanOrEqual(220);
    expect(excerpt.retainedBytes).toBe(excerpt.spans.reduce((n, s) => n + s.endByte - s.startByte, 0));
    expect(excerpt.text).toBe(excerpt.spans.map(s => Buffer.from(body).subarray(s.startByte, s.endByte).toString()).join('\n[… excerpt gap …]\n'));
    expect(select([source('transcript', body)], 220)).toEqual(selected);
  });
  it('carries governing Markdown headings with selected paragraphs', () => {
    const body = '# Safety manual\n\n## Superseded guidance — do not follow\n\n'
      + 'Reactor safety: disable the shutdown interlock during operation.\n\n'
      + 'Unrelated background. '.repeat(1000);
    const s = select([source('qualified', body)], 200);
    const text = s.excerpts[0]!.text;
    expect(text).toContain('Reactor safety: disable');
    expect(text).toContain('# Safety manual');
    expect(text).toContain('## Superseded guidance — do not follow');
    expect(s.excerpts[0]!.retainedBytes).toBeLessThanOrEqual(200);
  });
  it('selects a relevant late block and reports omitted text without mutating the source', () => {
    const body = 'unrelated history. '.repeat(20000) + '\n\n## Reactor safety\nNew shutdown procedure.\n\nFooter.';
    const node = source('n', body);
    const selection = select([node]);
    expect(selection.excerpts[0]?.text).toContain('New shutdown procedure');
    expect(selection.omissions).toContainEqual({ sourceId: 'n', reason: 'per_source_limit' });
    expect(node.body).toBe(body);
    for (const e of selection.excerpts) {
      expect(e.retainedBytes).toBeLessThanOrEqual(1000);
      expect(e.text).not.toContain('�');
      for (const span of e.spans) expect(Buffer.from(body).subarray(span.startByte, span.endByte).toString()).not.toContain('�');
    }
  });
  it('allocates explicit and changed sources before optional ones and honors explicit empty selection', () => {
    const sources = [source('optional', 'optional'.repeat(1000)), source('explicit', '😀'.repeat(1000), 'explicit'),
      source('changed', 'important'.repeat(1000), 'changed')];
    expect(select(sources, 1024).excerpts.map(e => e.sourceId)).toEqual(['changed', 'explicit']);
    expect(select(sources, 1024, []).excerpts).toEqual([]);
    expect(select(sources, 0).excerpts).toEqual([]);
    expect(() => select(sources, 10, ['unknown'])).toThrow(/unknown/i);
  });
  it('preserves web URL attribution and distinguishes unavailable from unselected', () => {
    const web: TopicEvidenceSource = { ...source('web:1', 'reactor safety sources'), priority: 'web',
      origin: { kind: 'web', url: 'https://example.org/source' } };
    const missing = { ...source('missing', ''), availability: 'unavailable' as const };
    const s = select([web, missing]);
    expect(renderTopicEvidence(s, [web, missing])).toContain('https://example.org/source');
    expect(s.omissions).toContainEqual({ sourceId: 'missing', reason: 'unavailable' });
  });
});
describe('topic request fitting', () => {
  it.each([204800, 98304])('fits actual serialized schema and escaped evidence below %i', async maxBytes => {
    const create = vi.fn();
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
    const sources = Array.from({ length: 10 }, (_, i) => source(String(i), 'reactor 😀 "safety"\n\n'.repeat(10000), 'explicit'));
    const context = { sources, query: 'reactor', topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576 };
    const buildRequest = (evidence: string) => ({ model: 'm', maxTokens: 10, system: 'instruction', user: evidence,
      schema: { type: 'object' }, toolName: 'emit', toolDescription: 'schema' });
    const fitted = await fitTopicRequest({ llm, model: 'm', context, query: 'reactor', maxBytes, buildRequest });
    expect(fitted.requestBytes).toBeLessThanOrEqual(maxBytes);
    expect(fitted.requestBytes).toBe(Buffer.byteLength(JSON.stringify((await fitted.llm.previewStructuredCall!(fitted.request)).payload)));
    expect(fitted.selection.excerpts.every(e => e.retainedBytes <= 24576)).toBe(true);
    expect(create).not.toHaveBeenCalled();
    await expect(fitTopicRequest({ llm, model: 'm', context, query: '', maxBytes: 100,
      buildRequest })).rejects.toThrow(/budget|large/i);
    await expect(fitTopicRequest({ llm: { structuredCall: vi.fn() }, model: 'm', context, query: '',
      maxBytes, buildRequest })).rejects.toThrow(/preview|configuration/i);
  });
});
