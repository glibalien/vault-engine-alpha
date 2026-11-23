import { describe, expect, it, vi } from 'vitest';
import { StructuredCallFailure, type LlmClient, type StructuredCallRequest } from '../src/llm/types.js';
import { openAiCompatProviderPayloadChars } from '../src/llm/openai-compat.js';
import {
  TOPIC_REFRESH_ASSESSMENT_SCHEMA,
  assessTopicWebMateriality,
  sanitizeTopicWebMaterialityAssessment,
} from '../src/topic-refresh-assessment.js';
import { buildCanonicalWebProbe } from '../src/topic-refresh-evidence.js';

const USAGE = { input: 12, output: 4, cacheWrite: 0, cacheRead: 0 };

function probe(urls: readonly string[]) {
  const result = buildCanonicalWebProbe(urls.map((url, index) => ({
    url,
    title: `Result ${index + 1}`,
    snippet: `Evidence ${index + 1}`,
    published: null,
  })));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected canonical probe, got ${result.reason}`);
  return result.probe;
}

const committed = probe(['https://example.test/committed']);
const current = probe(['https://example.test/current', 'https://example.test/also-current']);
const allowedUrls = new Set([...committed.results, ...current.results].map(result => result.url));

function closed() {
  return { verdict: 'uncertain', reasonCode: 'insufficient_evidence', changedUrls: [] };
}

function input(overrides: Partial<Parameters<typeof assessTopicWebMateriality>[1]> = {}) {
  return {
    topic: 'Example Topic',
    brief: 'Keep the wiki current.',
    committed,
    current,
    model: 'assessment-model',
    maxTokens: 321,
    ...overrides,
  };
}

describe('sanitizeTopicWebMaterialityAssessment', () => {
  it('preserves valid material, immaterial, and uncertain assessments', () => {
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: 'material', reasonCode: 'changed_fact', changedUrls: ['https://example.test/current'],
    }, allowedUrls)).toEqual({
      verdict: 'material', reasonCode: 'changed_fact', changedUrls: ['https://example.test/current'],
    });
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: 'immaterial', reasonCode: 'ranking_or_source_churn', changedUrls: [],
    }, allowedUrls)).toEqual({
      verdict: 'immaterial', reasonCode: 'ranking_or_source_churn', changedUrls: [],
    });
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: 'uncertain', reasonCode: 'insufficient_evidence', changedUrls: [],
    }, allowedUrls)).toEqual(closed());
  });

  it('fails closed for unknown verdicts or reason codes', () => {
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: 'yes', reasonCode: 'changed_fact', changedUrls: ['https://example.test/current'],
    }, allowedUrls)).toEqual(closed());
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: 'material', reasonCode: 'invented', changedUrls: ['https://example.test/current'],
    }, allowedUrls)).toEqual(closed());
  });

  it('keeps only allowed changed URLs, removes duplicates, and caps the result at 20', () => {
    const manyAllowed = new Set(Array.from({ length: 21 }, (_, index) => `https://example.test/${index}`));
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: 'material',
      reasonCode: 'new_development',
      changedUrls: [
        'https://not-allowed.test/nope',
        'https://example.test/0',
        'https://example.test/0',
        ...Array.from({ length: 20 }, (_, index) => `https://example.test/${index + 1}`),
      ],
    }, manyAllowed)).toEqual({
      verdict: 'material',
      reasonCode: 'new_development',
      changedUrls: Array.from({ length: 20 }, (_, index) => `https://example.test/${index}`),
    });
  });

  it('fails material claims closed without a valid changed URL or with an incompatible reason', () => {
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: 'material', reasonCode: 'changed_fact', changedUrls: ['https://not-allowed.test/nope'],
    }, allowedUrls)).toEqual(closed());
    for (const reasonCode of ['restatement', 'ranking_or_source_churn', 'insufficient_evidence']) {
      expect(sanitizeTopicWebMaterialityAssessment({
        verdict: 'material', reasonCode, changedUrls: ['https://example.test/current'],
      }, allowedUrls)).toEqual(closed());
    }
  });

  it('fails closed for every mismatched verdict and reason code pair', () => {
    const compatible = {
      material: new Set(['new_development', 'changed_fact', 'time_sensitive_update']),
      immaterial: new Set(['restatement', 'ranking_or_source_churn']),
      uncertain: new Set(['insufficient_evidence']),
    } as const;
    const reasonCodes = [
      'new_development',
      'changed_fact',
      'time_sensitive_update',
      'restatement',
      'ranking_or_source_churn',
      'insufficient_evidence',
    ];
    for (const [verdict, allowedReasons] of Object.entries(compatible)) {
      for (const reasonCode of reasonCodes) {
        if (allowedReasons.has(reasonCode)) continue;
        expect(sanitizeTopicWebMaterialityAssessment({
          verdict,
          reasonCode,
          changedUrls: ['https://example.test/current'],
        }, allowedUrls)).toEqual(closed());
      }
    }
  });

  it('ignores extra fields and safely closes wrong types, hostile proxies, and throwing getters', () => {
    const raw = {
      verdict: 'material',
      reasonCode: 'time_sensitive_update',
      changedUrls: ['https://example.test/current'],
      rawProviderOutput: 'do not retain this',
    };
    const sanitized = sanitizeTopicWebMaterialityAssessment(raw, allowedUrls);
    expect(sanitized).toEqual({
      verdict: 'material', reasonCode: 'time_sensitive_update', changedUrls: ['https://example.test/current'],
    });
    expect(sanitized).not.toHaveProperty('rawProviderOutput');
    expect(sanitized).not.toBe(raw);
    expect(sanitizeTopicWebMaterialityAssessment({
      verdict: ['material'], reasonCode: 1, changedUrls: 'https://example.test/current',
    }, allowedUrls)).toEqual(closed());
    expect(() => sanitizeTopicWebMaterialityAssessment(new Proxy({}, {
      get() { throw new Error('untrusted getter'); },
    }), allowedUrls)).not.toThrow();
    expect(sanitizeTopicWebMaterialityAssessment(new Proxy({}, {
      get() { throw new Error('untrusted getter'); },
    }), allowedUrls)).toEqual(closed());
    const getterThrowing = Object.create(null, {
      verdict: { get() { throw new Error('untrusted getter'); } },
    });
    expect(sanitizeTopicWebMaterialityAssessment(getterThrowing, allowedUrls)).toEqual(closed());
  });
});

describe('assessTopicWebMateriality', () => {
  it('makes one fail-closed structured call with the bounded assessment contract', async () => {
    const structuredCall = vi.fn<LlmClient['structuredCall']>().mockResolvedValue({
      output: { verdict: 'material', reasonCode: 'new_development', changedUrls: ['https://example.test/current'] },
      usage: USAGE,
    });

    await expect(assessTopicWebMateriality({ structuredCall }, input())).resolves.toEqual({
      assessment: { verdict: 'material', reasonCode: 'new_development', changedUrls: ['https://example.test/current'] },
      usage: USAGE,
    });
    expect(structuredCall).toHaveBeenCalledTimes(1);
    const request = structuredCall.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: 'assessment-model',
      maxTokens: 321,
      toolName: 'assess_topic_web_materiality',
      malformedOutputPolicy: 'fail-closed-redacted',
      providerPromptCharCap: 140_000,
    });
    expect(request?.user).toContain('Example Topic');
    expect(request?.user).toContain('Keep the wiki current.');
    expect(request?.user).toContain(committed.snapshotJson);
    expect(request?.user).toContain(current.snapshotJson);
    expect(request?.system).toMatch(/ranking.*churn/i);
    expect(request?.system).toMatch(/restatement/i);
    expect(request?.schema).toEqual(TOPIC_REFRESH_ASSESSMENT_SCHEMA);
    expect(request?.schema).toMatchObject({
      additionalProperties: false,
      properties: {
        verdict: { enum: ['material', 'immaterial', 'uncertain'] },
        reasonCode: {
          enum: [
            'new_development', 'changed_fact', 'time_sensitive_update', 'restatement',
            'ranking_or_source_churn', 'insufficient_evidence',
          ],
        },
      },
    });
  });

  it('passes a total provider payload at the cap through once and propagates a closed over-cap failure', async () => {
    const requests: StructuredCallRequest[] = [];
    const structuredCall = vi.fn<LlmClient['structuredCall']>().mockImplementation(async request => {
      requests.push(request);
      if (openAiCompatProviderPayloadChars(request) > 140_000) {
        throw new StructuredCallFailure(
          'structured call failed (reason=provider_prompt_too_large)', undefined, 'provider_prompt_too_large',
        );
      }
      return { output: { verdict: 'immaterial', reasonCode: 'ranking_or_source_churn', changedUrls: [] }, usage: USAGE };
    });
    await assessTopicWebMateriality({ structuredCall }, input({ brief: '' }));
    const baseRequest = requests[0];
    if (baseRequest === undefined) throw new Error('expected base request');
    const exactBrief = 'b'.repeat(140_000 - openAiCompatProviderPayloadChars(baseRequest));
    await expect(assessTopicWebMateriality({ structuredCall }, input({ brief: exactBrief })))
      .resolves.toMatchObject({ assessment: { verdict: 'immaterial' } });
    const exactRequest = requests[1];
    expect(exactRequest).toBeDefined();
    expect(openAiCompatProviderPayloadChars(exactRequest!)).toBe(140_000);
    await expect(assessTopicWebMateriality({ structuredCall }, input({ brief: `${exactBrief}b` })))
      .rejects.toMatchObject({ reason: 'provider_prompt_too_large' });
    expect(structuredCall).toHaveBeenCalledTimes(3);
    expect(requests.every(request => request.providerPromptCharCap === 140_000)).toBe(true);
  });

  it('propagates provider and malformed-output failures without producing an assessment admission', async () => {
    const providerFailure = new StructuredCallFailure(
      'structured call failed (reason=provider_transport_failed)', undefined, 'provider_transport_failed',
    );
    await expect(assessTopicWebMateriality({
      structuredCall: async () => { throw providerFailure; },
    }, input())).rejects.toBe(providerFailure);
    const malformedFailure = new StructuredCallFailure(
      'structured call failed (reason=malformed_json)', undefined, 'malformed_json',
    );
    await expect(assessTopicWebMateriality({
      structuredCall: async () => { throw malformedFailure; },
    }, input())).rejects.toBe(malformedFailure);
  });
});
