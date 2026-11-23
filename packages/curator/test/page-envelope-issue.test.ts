import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { pageEnvelopeIssue, parsePageMarkdownOutput, type PageEnvelopeIssue } from '../src/llm/page-markdown-output.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { UsageReporter } from '../src/usage-reporter.js';
import type { Engine } from '../src/engine.js';
import type { StructuredCallRequest } from '../src/llm/types.js';

const envelope = (body: string, note = '') => `<<<VAULT_PAGE_V1>>>\nlog_note: ${note}\n<<<VAULT_BODY>>>\n${body}\n<<<END_VAULT_PAGE>>>`;
const valid = envelope('## Summary\n\nSECRET_BODY text.', 'Updated.');

describe('pageEnvelopeIssue', () => {
  const cases: Array<[PageEnvelopeIssue, string]> = [
    ['empty', '   \n'],
    ['fenced', '```markdown\n' + valid + '\n```'],
    ['leading_text', 'Here is the page:\n' + valid],
    ['missing_start_marker', '## Summary\n\nJust Markdown.'],
    ['missing_log_note', '<<<VAULT_PAGE_V1>>>\n<<<VAULT_BODY>>>\nBody\n<<<END_VAULT_PAGE>>>'],
    ['missing_body_marker', '<<<VAULT_PAGE_V1>>>\nlog_note: \nBody\n<<<END_VAULT_PAGE>>>'],
    ['missing_end_marker', '<<<VAULT_PAGE_V1>>>\nlog_note: \n<<<VAULT_BODY>>>\nBody'],
    ['trailing_text', valid + '\nLet me know if you need changes.'],
    ['marker_in_body', envelope('Body\n<<<VAULT_BODY>>>\nMore')],
    ['empty_body', envelope('   ')],
    ['log_note_too_long', envelope('Body', 'x'.repeat(501))],
    ['other', '<<<VAULT_PAGE_V1>>>\nlog_note: \nextra line\n<<<VAULT_BODY>>>\nBody\n<<<END_VAULT_PAGE>>>'],
  ];

  it.each(cases)('classifies %s', (issue, content) => {
    expect(pageEnvelopeIssue(content)).toBe(issue);
  });

  it('reports no issue exactly when the envelope parses', () => {
    expect(pageEnvelopeIssue(valid)).toBeNull();
    expect(pageEnvelopeIssue(`\n${envelope('Body')}\n`)).toBeNull();
    for (const [, content] of cases) expect(() => parsePageMarkdownOutput(content)).toThrow();
  });
});

describe('page envelope diagnostics', () => {
  const req: StructuredCallRequest = { model: 'pages', maxTokens: 1000, system: 'system', user: 'source', toolName: 'emit_page',
    toolDescription: 'emit', schema: {}, openAiResponseFormat: 'page-markdown', malformedOutputPolicy: 'fail-closed-redacted',
    wikiContext: { stage: 'page', attempt: 0, policyVersion: 1, maxTokens: 1000, configuration: { provider: 'fireworks', reasoningEffort: 'low' } } };

  it('records which envelope check failed with the usage, and never the content', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'gen-1', model: 'pages', choices: [{ finish_reason: 'stop',
      message: { content: '```markdown\n' + valid + '\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    const recordUsage = vi.fn().mockResolvedValue({});
    const reporter = new UsageReporter({ recordUsage } as unknown as Engine, { provider: 'fireworks', experiment: null, variant: null });
    reporter.setContext({ project: 'Atlas', runRef: 'run' });
    const llm = reporter.wrap(new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { provider: 'fireworks' }));
    await expect(llm.structuredCall(req)).rejects.toMatchObject({ reason: 'invalid_page_envelope' });
    const row = recordUsage.mock.calls[0]![0];
    expect(row.metadata.wiki_call.diagnostics.responses[0]).toMatchObject({ envelopeIssue: 'fenced', finishReason: 'stop' });
    expect(JSON.stringify(row.metadata)).not.toContain('SECRET_BODY');
  });

  it('records no envelope issue for an accepted page', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: valid } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 } });
    const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI, { provider: 'fireworks' });
    const result = await llm.structuredCall(req);
    expect(result.diagnostics?.responses[0]).not.toHaveProperty('envelopeIssue');
  });
});
