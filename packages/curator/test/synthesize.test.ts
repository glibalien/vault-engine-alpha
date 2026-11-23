// allow: SIZE_OK — legacy synthesis regression matrix; Task 9 splits topology coverage.
import { pageKindDescriptions } from '../src/page-templates.js';
import { describe, expect, it } from 'vitest';
import { SPEC_A_SYSTEM_PROMPT, TOPIC_SYSTEM_PROMPT, TOPIC_WEB_SYSTEM_PROMPT, validateSections, stampLog, parseMemories, synthesize, synthesizeRequestedPage, synthesizeTopologyPlan } from '../src/synthesize.js';
import type { LlmClient, StructuredCallRequest } from '../src/llm/types.js';
import { buildEvidence, truncate } from '../src/evidence.js';
import { estimateCostUsd, pricingFor, addUsage } from '../src/pricing.js';
import type { ExistingWiki, ProjectDigest, EngineNode, ProjectRef, TokenUsage } from '../src/types.js';

function stubLlm(output: unknown): LlmClient {
  return { structuredCall: async () => ({ output, usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } }) };
}

describe('SPEC_A_SYSTEM_PROMPT grounding rules', () => {
  it('bucket-anchors open-status claims and uses CLOSED SINCE', () => {
    expect(SPEC_A_SYSTEM_PROMPT).toContain('current actionable task buckets');
    expect(SPEC_A_SYSTEM_PROMPT).toContain('CLOSED SINCE LAST CURATION');
  });
});

describe('SPEC_A_SYSTEM_PROMPT gap-fill guardrail', () => {
  it('names the low-confidence related candidates the evidence may carry', () => {
    expect(SPEC_A_SYSTEM_PROMPT).toContain('low-confidence RELATED candidates');
    expect(SPEC_A_SYSTEM_PROMPT).toContain('CHANGED SINCE LAST CURATION');
  });
});

describe('validateSections', () => {
  it('accepts a complete section set and trims', () => {
    const out = validateSections({ now: ' a ', focus: 'b', open_threads: 'c', log_entry: 'd' });
    expect(out).toEqual({ now: 'a', focus: 'b', open_threads: 'c', log_entry: 'd' });
  });

  it('rejects a missing or empty section', () => {
    expect(() => validateSections({ now: 'a', focus: 'b', open_threads: 'c' })).toThrow(/log_entry/);
    expect(() => validateSections({ now: '', focus: 'b', open_threads: 'c', log_entry: 'd' })).toThrow(/now/);
    expect(() => validateSections(null)).toThrow();
  });
});

describe('stampLog', () => {
  it('prepends an ISO date', () => {
    expect(stampLog('did a thing', new Date('2026-06-06T12:00:00Z'))).toBe('**2026-06-06** — did a thing');
  });
});

describe('pricing', () => {
  const usage: TokenUsage = { input: 1000, output: 2000, cacheWrite: 0, cacheRead: 500 };

  it('prices a sonnet call from its rate card', () => {
    // (1000*3 + 2000*15 + 500*0.30) / 1e6
    expect(estimateCostUsd('claude-sonnet-4-6', usage)).toBeCloseTo(0.03315, 6);
  });

  it('falls back to model family for unknown exact ids', () => {
    expect(pricingFor('claude-opus-4-9')).toEqual(pricingFor('claude-opus-4-8'));
    expect(pricingFor('claude-sonnet-4-7')?.input).toBe(3);
  });

  it('returns null cost for a model with no pricing', () => {
    expect(estimateCostUsd('some-other-model', usage)).toBeNull();
  });

  it('sums usage across calls', () => {
    expect(addUsage(usage, usage)).toEqual({ input: 2000, output: 4000, cacheWrite: 0, cacheRead: 1000 });
  });

  it('prices Fireworks serverless Kimi models by exact id', () => {
    // (1000*0.95 + 2000*4 + 500*0.16) / 1e6
    expect(estimateCostUsd('accounts/fireworks/models/kimi-k2p6', usage)).toBeCloseTo(0.00903, 6);
    expect(pricingFor('accounts/fireworks/models/kimi-k2p5')?.output).toBe(3);
    // Pins the guard: cacheWrite mirrors input (never 0) so a future nonzero
    // report would be priced as plain input, not free.
    expect(pricingFor('accounts/fireworks/models/kimi-k2p6')?.cacheWrite)
      .toBe(pricingFor('accounts/fireworks/models/kimi-k2p6')?.input);
  });

  it('prices Fireworks serverless qwen3p7-plus (the curator default) by exact id', () => {
    // (1000*0.40 + 2000*1.60 + 500*0.08) / 1e6
    expect(estimateCostUsd('accounts/fireworks/models/qwen3p7-plus', usage)).toBeCloseTo(0.00364, 6);
    expect(pricingFor('accounts/fireworks/models/qwen3p7-plus')?.output).toBe(1.6);
    expect(pricingFor('accounts/fireworks/models/qwen3p7-plus')?.cacheWrite)
      .toBe(pricingFor('accounts/fireworks/models/qwen3p7-plus')?.input);
  });

  it('does not family-match Kimi router variants (2× price) — n/a beats silently wrong', () => {
    expect(pricingFor('accounts/fireworks/routers/kimi-k2p6-fast')).toBeNull();
  });
});

describe('truncate', () => {
  it('leaves short text alone and truncates long text with a marker', () => {
    expect(truncate('short', 100)).toBe('short');
    const t = truncate('x'.repeat(50), 10);
    expect(t.startsWith('x'.repeat(10))).toBe(true);
    expect(t).toContain('truncated 40 chars');
  });
});

describe('buildEvidence', () => {
  const project: ProjectRef = { id: 'p1', title: 'Demo Project', file_path: 'Projects/Demo.md', status: 'in-progress' };
  const digest: ProjectDigest = {
    project: { id: 'p1', title: 'Demo Project', file_path: 'Projects/Demo.md' },
    tasks: {
      open: [{ id: 't1', title: 'Wire the thing', status: 'open', due: null }],
      overdue: [], blocked: [], upcoming: [], backlog: [], done_recent: [],
    },
    notes: [{ id: 'n1', title: 'Spec' }],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 3 },
    existing_wiki: { home_id: null, subpages: [] },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
  };

  it('includes project header, signals, tasks, and read bodies', () => {
    const nodes: Array<EngineNode & { reason?: string }> = [
      { id: 'n1', title: 'Spec', types: ['note'], fields: { status: { value: 'draft' } }, body: 'Design details here.', reason: 'Recent note' },
    ];
    const evidence = buildEvidence(project, digest, nodes, 4000);
    expect(evidence).toContain('# Project: Demo Project');
    expect(evidence).toContain('Status: in-progress');
    expect(evidence).toContain('Existing wiki: none — first build');
    expect(evidence).toContain('Open (1):');
    expect(evidence).toContain('Wire the thing');
    expect(evidence).toContain('### Spec');
    expect(evidence).toContain('why surfaced: Recent note');
    expect(evidence).toContain('status="draft"');
    expect(evidence).toContain('Design details here.');
  });

  it('truncates oversized bodies to the cap', () => {
    const nodes: Array<EngineNode & { reason?: string }> = [
      { id: 'n1', title: 'Big', types: ['note'], fields: {}, body: 'y'.repeat(9000) },
    ];
    const evidence = buildEvidence(project, digest, nodes, 100);
    expect(evidence).toContain('truncated 8900 chars');
  });

  it('notes when a wiki already exists', () => {
    const updating: ProjectDigest = { ...digest, existing_wiki: { home_id: 'w1', subpages: [{ id: 's1', title: 'Theme' }] } };
    const evidence = buildEvidence(project, updating, [], 4000);
    expect(evidence).toContain('Existing wiki: yes — this is an update');
    expect(evidence).toContain('Existing sub-pages: Theme');
    expect(evidence).toContain('(no high-signal nodes resolved)');
  });

  it('lists current subpage titles without emitting the retired home-topology block', () => {
    const withThemed: ProjectDigest = {
      ...digest,
      existing_wiki: {
        home_id: 'w1',
        subpages: [
          { id: 's1', title: 'Demo Project — Task Board' },               // spine → excluded
          { id: 's2', title: 'Demo Project — ID Check Pilot', wiki_state: 'active' },
          { id: 's3', title: 'Demo Project — Vendor Bake-off', wiki_state: 'dormant' },
        ],
      },
    };
    const evidence = buildEvidence(project, withThemed, [], 4000);
    expect(evidence).toContain('Existing sub-pages: Demo Project — ID Check Pilot, Demo Project — Vendor Bake-off');
    expect(evidence).not.toContain('## EXISTING THEMED PAGES');
    expect(evidence).not.toContain('Demo Project — Task Board');
  });

  it('does not duplicate catalog kind/state metadata in narrative evidence', () => {
    const withKind: ProjectDigest = {
      ...digest,
      existing_wiki: {
        home_id: 'w1',
        subpages: [{ id: 's2', title: 'Demo Project — ID Check Pilot', wiki_state: 'active', wiki_kind: 'workstream' }],
      },
    };
    const evidence = buildEvidence(project, withKind, [], 4000);
    expect(evidence).toContain('Existing sub-pages: Demo Project — ID Check Pilot');
    expect(evidence).not.toContain('kind: workstream');
    expect(evidence).not.toContain('state: active');
  });

  it('omits the themed block when there are no themed pages', () => {
    const spineOnly: ProjectDigest = {
      ...digest,
      existing_wiki: { home_id: 'w1', subpages: [{ id: 's1', title: 'Demo Project — Task Board' }] },
    };
    expect(buildEvidence(project, spineOnly, [], 4000)).not.toContain('EXISTING THEMED PAGES');
  });

  it('does not duplicate title-based pins after catalog pin migration', () => {
    const withThemed: ProjectDigest = {
      ...digest,
      existing_wiki: {
        home_id: 'w1',
        subpages: [
          { id: 's2', title: 'Demo Project — ID Check Pilot', wiki_state: 'active' },
        ],
      },
    };
    const txt = buildEvidence(project, withThemed, [], 4000, [], new Set(['Demo Project — ID Check Pilot']));
    expect(txt).not.toMatch(/PINNED/);
  });
});

describe('synthesize themed output', () => {
  it('rejects legacy topology proposals after Task 11 migrates runtime callers', async () => {
    await expect(synthesize(stubLlm({
      now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l',
      themed_pages: [{ kind: 'workstream', title: 'Auth Pot', body: 'b', log_note: 'ln', state: 'active' }],
      retire_pages: [{ title: 'Demo — Gone', state: 'retired', reason: 'merged' }],
    }), 'claude-sonnet-4-6', 'EVIDENCE')).rejects.toThrow(/unrecognized/i);
  });

  it('defaults themed/retire to [] when absent', async () => {
    const res = await synthesize(stubLlm({ now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l' }),
      'claude-sonnet-4-6', 'EVIDENCE');
    expect(res.themedPages).toEqual([]);
    expect(res.retirePages).toEqual([]);
  });
});

describe('SPEC_A_SYSTEM_PROMPT themed guidance', () => {
  it('does not grant the home pass topology authority', () => {
    expect(SPEC_A_SYSTEM_PROMPT).not.toContain('themed_pages');
    expect(SPEC_A_SYSTEM_PROMPT).not.toContain('retire_pages');
  });
});

describe('validateSections at_a_glance', () => {
  it('omits at_a_glance when absent from input', () => {
    const out = validateSections({ now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l' });
    expect(out).not.toHaveProperty('at_a_glance');
    expect(out).toEqual({ now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l' });
  });

  it('carries at_a_glance when a non-empty string is present', () => {
    const out = validateSections({ now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l', at_a_glance: 'g' });
    expect(out.at_a_glance).toBe('g');
  });

  it('omits at_a_glance when whitespace-only (treated as absent, not an error)', () => {
    const out = validateSections({ now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l', at_a_glance: '   ' });
    expect(out).not.toHaveProperty('at_a_glance');
  });
});

describe('synthesize at_a_glance threading', () => {
  it('carries at_a_glance through when the stub emits it', async () => {
    const res = await synthesize(stubLlm({
      now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l', at_a_glance: 'GLANCE',
    }), 'claude-sonnet-4-6', 'EVIDENCE');
    expect(res.sections.at_a_glance).toBe('GLANCE');
    // four required still present
    expect(res.sections.now).toBe('n');
    expect(res.sections.focus).toBe('- [ ] **f**');
    expect(res.sections.open_threads).toBe('- **o**');
  });

  it('leaves at_a_glance undefined when the stub does not emit it', async () => {
    const res = await synthesize(stubLlm({
      now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l',
    }), 'claude-sonnet-4-6', 'EVIDENCE');
    expect(res.sections.at_a_glance).toBeUndefined();
    // four required still present
    expect(res.sections.now).toBe('n');
    expect(res.sections.focus).toBe('- [ ] **f**');
    expect(res.sections.open_threads).toBe('- **o**');
    expect(res.sections.log_entry).toMatch(/—/);
  });
});

describe('structured-call request construction', () => {
  function captureLlm(output: unknown): { llm: LlmClient; reqs: StructuredCallRequest[] } {
    const reqs: StructuredCallRequest[] = [];
    return {
      reqs,
      llm: {
        structuredCall: async (req) => {
          reqs.push(req);
          return { output, usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } };
        },
      },
    };
  }

  it('home synthesis sends the system prompt, emit_wiki_sections schema, and 4000-token cap', async () => {
    const { llm, reqs } = captureLlm({ now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l' });
    await synthesize(llm, 'claude-sonnet-4-6', 'EV');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.model).toBe('claude-sonnet-4-6');
    expect(reqs[0]?.maxTokens).toBe(4000);
    expect(reqs[0]?.system.startsWith(SPEC_A_SYSTEM_PROMPT)).toBe(true);
    expect(reqs[0]?.system).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
    expect(reqs[0]?.user).toBe('EVIDENCE:\n\nEV');
    expect(reqs[0]?.toolName).toBe('emit_wiki_sections');
    expect((reqs[0]?.schema as { required?: string[] }).required).toEqual(['now', 'focus', 'open_threads', 'log_entry']);
    const properties = (reqs[0]?.schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).not.toHaveProperty('themed_pages');
    expect(properties).not.toHaveProperty('retire_pages');
  });

  it('emit_wiki_sections schema includes at_a_glance as an optional property (not in required)', async () => {
    const { llm, reqs } = captureLlm({ now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l' });
    await synthesize(llm, 'claude-sonnet-4-6', 'EV');
    const schema = reqs[0]?.schema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('at_a_glance');
    expect(schema.required).not.toContain('at_a_glance');
  });

  it('passes an explicit maxTokens through (the CURATOR_HOME_MAX_TOKENS knob)', async () => {
    const home = captureLlm({ now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l' });
    await synthesize(home.llm, 'm', 'EV', 16384);
    expect(home.reqs[0]?.maxTokens).toBe(16384);
  });
});

describe('synthesizeRequestedPage', () => {
  const usage = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };

  it('returns kind/body/logNote and passes title+brief in the user message', async () => {
    let captured: { system: string; user: string; toolName: string } | undefined;
    const llm: LlmClient = {
      structuredCall: async (req) => {
        captured = { system: req.system, user: req.user, toolName: req.toolName };
        return { output: { kind: 'workstream', body: 'PAGE BODY', log_note: 'created on request' }, usage };
      },
    };
    const out = await synthesizeRequestedPage(llm, 'm', 'AskAcme — ID Check Pilot', 'auth workstream', 'EVIDENCE TEXT', 4000);
    expect(out).toEqual({ kind: 'workstream', body: 'PAGE BODY', logNote: 'created on request', usage });
    expect(captured?.toolName).toBe('emit_requested_page');
    expect(captured?.user).toContain('REQUESTED PAGE: AskAcme — ID Check Pilot');
    expect(captured?.user).toContain('BRIEF: auth workstream');
    expect(captured?.user).toContain('EVIDENCE TEXT');
  });

  it('defaults an unknown kind to workstream', async () => {
    const llm: LlmClient = {
      structuredCall: async () => ({ output: { kind: 'bogus', body: 'b', log_note: '' }, usage }),
    };
    const out = await synthesizeRequestedPage(llm, 'm', 'T', undefined, 'E');
    expect(out.kind).toBe('workstream');
  });

  it('throws on a missing/empty body', async () => {
    const llm: LlmClient = {
      structuredCall: async () => ({ output: { kind: 'workstream', body: '  ', log_note: '' }, usage }),
    };
    await expect(synthesizeRequestedPage(llm, 'm', 'T', undefined, 'E')).rejects.toThrow(/body/);
  });
});

describe('SPEC_A system prompt', () => {
  it('instructs the model to honor a CALLER CORRECTIONS section', () => {
    expect(SPEC_A_SYSTEM_PROMPT).toContain('CALLER CORRECTIONS');
  });
});

describe('TOPIC_SYSTEM_PROMPT', () => {
  it('frames the page for a topic and honors CALLER CORRECTIONS', () => {
    expect(TOPIC_SYSTEM_PROMPT).toMatch(/topic/i);
    expect(TOPIC_SYSTEM_PROMPT).toContain('CALLER CORRECTIONS');
  });
});

describe('validateSections — sources passthrough', () => {
  it('keeps a non-empty sources field', () => {
    const out = validateSections({ now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l', sources: '- [A](https://a)' });
    expect(out.sources).toBe('- [A](https://a)');
  });
  it('omits an empty/absent sources field', () => {
    const out = validateSections({ now: 'n', focus: 'f', open_threads: 'o', log_entry: 'l' });
    expect(out.sources).toBeUndefined();
  });
});

describe('TOPIC_WEB_SYSTEM_PROMPT', () => {
  it('frames web attribution + the sources field + corrections', () => {
    expect(TOPIC_WEB_SYSTEM_PROMPT).toMatch(/WEB MATERIAL/);
    expect(TOPIC_WEB_SYSTEM_PROMPT).toMatch(/attribut/i);
    expect(TOPIC_WEB_SYSTEM_PROMPT).toMatch(/sources/i);
    expect(TOPIC_WEB_SYSTEM_PROMPT).toMatch(/CALLER CORRECTIONS/);
  });
});

describe('parseMemories', () => {
  it('keeps well-formed entries, trims content, defaults/validates category', () => {
    expect(parseMemories([
      { content: ' Owner prefers terse standups. ', category: 'preference' },
      { content: 'No category given' },
      { content: 'Bad category', category: 'nope' },
    ])).toEqual([
      { content: 'Owner prefers terse standups.', category: 'preference' },
      { content: 'No category given', category: 'fact' },
      { content: 'Bad category', category: 'fact' },
    ]);
  });

  it('drops malformed entries (non-object, empty/missing content)', () => {
    expect(parseMemories([
      'garbage',
      { content: '   ' },
      { category: 'fact' },
      { content: 'kept' },
    ])).toEqual([{ content: 'kept', category: 'fact' }]);
  });

  it('returns [] for a non-array', () => {
    expect(parseMemories(undefined)).toEqual([]);
    expect(parseMemories({})).toEqual([]);
  });
});

describe('synthesize memories output', () => {
  it('returns parsed memories alongside the sections', async () => {
    const res = await synthesize(stubLlm({
      now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l',
      memories: [{ content: ' Ships on Fridays. ', category: 'fact' }],
    }), 'claude-sonnet-4-6', 'EVIDENCE');
    expect(res.memories).toEqual([{ content: 'Ships on Fridays.', category: 'fact' }]);
  });

  it('defaults memories to [] when absent', async () => {
    const res = await synthesize(stubLlm({ now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l' }),
      'claude-sonnet-4-6', 'EVIDENCE');
    expect(res.memories).toEqual([]);
  });

  it('rejects malformed optional memories at the strict home boundary', async () => {
    await expect(synthesize(stubLlm({
      now: 'n', focus: [{ title: 'f' }], open_threads: [{ title: 'o' }], log_entry: 'l',
      memories: [{ content: 'Keep this.', category: 'note' }, { content: '   ', category: 'fact' }],
    }), 'claude-sonnet-4-6', 'EVIDENCE')).rejects.toThrow();
  });
});

describe('memory-write prompt guidance', () => {
  it('each active home/topic prompt instructs persisting durable memories', () => {
    for (const p of [SPEC_A_SYSTEM_PROMPT, TOPIC_SYSTEM_PROMPT, TOPIC_WEB_SYSTEM_PROMPT]) {
      expect(p).toContain('## Persisting memory');
      expect(p).toContain('OWNER MEMORIES');
      expect(p).not.toContain('create-memory returns');
    }
  });
});

/** Every schema a JSON Schema gives the property `name`, wherever it is nested. */
function propertySchemas(schema: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(schema)) return schema.flatMap(item => propertySchemas(item, name));
  if (schema === null || typeof schema !== 'object') return [];
  const record = schema as Record<string, unknown>;
  const own = (record['properties'] as Record<string, unknown> | undefined)?.[name];
  return [...(own === undefined ? [] : [own as Record<string, unknown>]), ...Object.values(record).flatMap(value => propertySchemas(value, name))];
}

function capturingLlm(output: unknown): { llm: LlmClient; requests: StructuredCallRequest[] } {
  const requests: StructuredCallRequest[] = [];
  const llm: LlmClient = {
    structuredCall: async (req) => {
      requests.push(req);
      return { output, usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } };
    },
  };
  return { llm, requests };
}

describe('current-date injection', () => {
  it('synthesize appends the date line after the system prompt', async () => {
    const { llm, requests } = capturingLlm({ now: 'a', focus: [{ title: 'b' }], open_threads: [{ title: 'c' }], log_entry: 'd' });
    await synthesize(llm, 'model-x', 'some evidence');
    expect(requests[0]?.system.startsWith(SPEC_A_SYSTEM_PROMPT)).toBe(true);
    expect(requests[0]?.system).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
  });

  it('synthesizeRequestedPage appends the date line after the system prompt', async () => {
    const { llm, requests } = capturingLlm({ body: 'page body', kind: 'workstream', log_note: 'n' });
    await synthesizeRequestedPage(llm, 'model-x', 'Some Page', undefined, 'evidence');
    expect(requests[0]?.system).toMatch(/\n\nToday is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(.+\)\.$/);
  });
});

describe('synthesizeTopologyPlan', () => {
  const existingWiki: ExistingWiki = {
    home_id: 'home-1',
    home: { id: 'home-1', version: 3 },
    topology_hash: 'hash-1',
    catalog_valid: true,
    subpages: [{
      id: 'page-1',
      title: 'Negotiations',
      file_path: 'Wikis/Negotiations.md',
      version: 2,
      content_hash: 'content-1',
      wiki_state: 'active',
      wiki_origin: 'automatic',
      wiki_pinned: false,
    }],
  };

  it('makes one topology-only structured call and parses its plan', async () => {
    // Given: a topology model response and a complete catalog.
    const output = {
      reviewed_page_ids: ['page-1'],
      actions: [{
        op: 'keep',
        node_id: 'page-1',
        scope: { v: 1, subject: 'Orbital Builder Redux', facet: 'ceasefire negotiations' },
      }],
    };
    const { llm, requests } = capturingLlm(output);

    // When: additive topology synthesis is invoked.
    const result = await synthesizeTopologyPlan(llm, {
      model: 'model-x',
      evidence: 'evidence',
      existingWiki,
      rootTitle: 'Orbital Builder Redux',
      maxTokens: 2_048,
    });

    // Then: the existing LLM seam receives the topology tool and returns attributed usage.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.toolName).toBe('emit_topology_plan');
    expect(requests[0]?.maxTokens).toBe(2_048);
    const schemaProperties = requests[0]?.schema['properties'] as Record<string, unknown>;
    const reviewed = schemaProperties['reviewed_page_ids'] as Record<string, unknown>;
    expect((reviewed['items'] as Record<string, unknown>)['enum']).toEqual(['page-1']);
    expect(JSON.parse(requests[0]?.user ?? '')).toEqual({
      wiki_root_title: 'Orbital Builder Redux',
      page_title_prefix: 'Orbital Builder Redux — ',
      evidence: 'evidence',
      existing_wiki: existingWiki,
      page_kinds: pageKindDescriptions(),
    });
    expect(result).toEqual({ plan: output, usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } });
  });

  it('sends no length limit on a brief, and parses a long one for the plan validator to judge (#633)', async () => {
    // A provider enforcing a maxLength cut a brief off mid-word at the limit, and the clipped brief passed.
    const brief = 'Cover the ceasefire terms, the open questions and the next round. '.repeat(80);
    const output = {
      reviewed_page_ids: ['page-1'],
      actions: [{ op: 'refresh', node_id: 'page-1', scope: { v: 1, subject: 'Orbital Builder Redux', facet: 'negotiations' }, synthesis_brief: brief }],
    };
    const { llm, requests } = capturingLlm(output);

    const result = await synthesizeTopologyPlan(llm, {
      model: 'model-x', evidence: 'evidence', existingWiki, rootTitle: 'Orbital Builder Redux',
      sources: [{ id: 'note-1', title: 'Note', types: ['note'] }], memories: [{ id: 1, category: null, text: 'A rule.' }],
    });

    expect(brief.length).toBeGreaterThan(5_000);
    expect(result.plan.actions[0]).toMatchObject({ op: 'refresh', synthesis_brief: brief });
    const schema = requests[0]!.schema;
    const briefs = propertySchemas(schema, 'synthesis_brief');
    expect(briefs).toHaveLength(4);
    for (const briefSchema of briefs) expect(briefSchema).not.toHaveProperty('maxLength');
    // The only limits left are on the audit-only reason fields, which stay as they are.
    const reasons = propertySchemas(schema, 'reason');
    expect(reasons.map(reason => reason['maxLength'])).toEqual([1_000, 1_000]);
    expect(JSON.stringify(schema).match(/"maxLength"/g)).toHaveLength(reasons.length);
  });

  it('rejects malformed topology output without returning a partial plan', async () => {
    // Given: a model response containing a forbidden delete operation.
    const { llm } = capturingLlm({
      reviewed_page_ids: ['page-1'],
      actions: [{ op: 'delete', node_id: 'page-1' }],
    });

    // When: topology synthesis parses the response.
    const result = synthesizeTopologyPlan(llm, {
      model: 'model-x',
      evidence: 'evidence',
      existingWiki,
      rootTitle: 'Orbital Builder Redux',
    });

    // Then: callers receive a hard phase error rather than a shortened plan.
    await expect(result).rejects.toThrow('INVALID_PLAN_SHAPE');
  });
});
