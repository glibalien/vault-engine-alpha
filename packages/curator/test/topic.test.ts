import { pageOutputFrame } from './page-output-fixtures.js';
import { comparableTopicBody } from '../src/topic-refresh-evidence.js';
import { buildOpenAiCompatParams } from '../src/llm/openai-compat.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type OpenAI from 'openai';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { commitTopicRefreshBaseline, observedTopicRefreshSources } from '../src/db/topic-refresh.js';
import { admitTopicRefresh } from '../src/topic-refresh-admission.js';
import { webSourceId } from '../src/topic-evidence-selection.js';
import { selectTopicEvidence } from '../src/topic-evidence-selection.js';
import { topicCoverageNote } from '../src/topic-evidence-diagnostics.js';
import { immutablePreparedCapture } from '../src/llm/types.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTopicEvidence,
  buildWebEvidence,
  curateTopic,
  topicEvidenceHash,
  topicSynthesisHash,
  topicRefreshCommitMaterial,
  type CurateTopicOptions,
} from '../src/topic.js';
import type { Config } from '../src/config.js';
import { EngineError, type WikiReconcileInput, type WikiReconcileResult } from '../src/engine.js';
import type { LlmClient } from '../src/llm/types.js';
import type { TopicRefreshAdmission, TopicRefreshTrigger } from '../src/topic-refresh-admission.js';
import type { CanonicalWebProbe } from '../src/topic-refresh-evidence.js';
import type { ExistingWiki, GapFillCandidate, Memory, TopicSpec, TopologyPlan } from '../src/types.js';

const root = { id: 'root', title: 'Metro Owls', file_path: 'Topics/Metro Owls.md', status: null };
const usage = { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 };
const config = {
  topicRequestMaxBytes: 204800, topicPageRequestMaxBytes: 98304, topicSourceExcerptMaxBytes: 24576,
  wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0, wikiPlanningReasoningEffort: 'inherit', wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit', model: 'model', homeMaxTokens: 4096, semanticGapFillLimit: 15, bodyCharCap: 4000,
  fieldGuessModel: 'accounts/fireworks/models/gpt-oss-120b',
  fieldGuessModelError: null, fieldGuessCap: 25, fieldGuessMaxTokens: 2000,
  topicWebCadenceMs: 7 * 24 * 60 * 60 * 1000, webSearchResults: 5, webFetchTop: 2,
  webFetchCharCap: 4000, memoryWriteEnabled: false, memoryWriteCap: 3,
} as Config;

function wiki(over: Partial<ExistingWiki> = {}): ExistingWiki {
  return {
    home_id: 'home', home: { id: 'home', version: 2, wiki_evidence_hash: 'old', wiki_topology_hash: 'topology' },
    topology_hash: 'topology', catalog_valid: true, subpages: [], ...over,
  };
}

function admission(
  trigger: TopicRefreshTrigger = 'manual_request',
  over: Partial<TopicRefreshAdmission> = {},
): TopicRefreshAdmission {
  return {
    admit: trigger !== 'not_due',
    trigger,
    changedSourceNodeIds: [],
    warnings: [],
    ...over,
  };
}

function options(over: Partial<CurateTopicOptions> = {}): CurateTopicOptions {
  return {
    dryRun: false,
    force: false,
    pinnedNodeIds: new Set(),
    corrections: [],
    runRef: 'run',
    scheduled: false,
    admission: admission(),
    explicitSourceNodeIds: [],
    prioritySourceNodeIds: [],
    ...over,
  };
}

function result(input: WikiReconcileInput): WikiReconcileResult {
  return {
    operation_id: input.dry_run === true ? null : 'operation', reconcile_key: input.reconcile_key,
    plan_digest: 'digest', reused: false, dry_run: input.dry_run === true, created: [], updated: [], mappings: [],
    home: { node_id: 'home', title: 'Metro Owls Wiki', file_path: 'Wikis/Metro Owls Wiki.md', version: 3, created: false },
    topology_hash: 'post-topology', warnings: [], preview: { total: 0, items: [], truncated: false },
  };
}

function engineFor(existingWiki: ExistingWiki, resolvedRootId = root.id) {
  const reconcileCalls: WikiReconcileInput[] = [];
  const engine = {
    projectEvidence: vi.fn(async () => ({
      project: { id: resolvedRootId, title: root.title, file_path: root.file_path, status: null },
      existing_wiki: existingWiki,
    })),
    semanticRelated: vi.fn(async () => [{ id: 'source', title: 'Owls news', types: ['note'], status: null }]),
    getNode: vi.fn(async (id: string) => ({ id, title: 'Owls news', types: ['note'], fields: {}, body: 'signed a new ace' })),
    listMemories: vi.fn(async () => []),
    listMemoriesWithTotal: vi.fn(async (filters: Record<string, unknown>) => filters.query === `"${root.title}"`
      ? { memories: [{ id: 5, source: 'chat', scope: 'vault', node_id: null, content: 'The owls changed coaches in May.', category: 'fact', created_at: '', updated_at: '' }], total: 1 }
      : { memories: [], total: 0 }),
    webSearch: vi.fn(async () => []), fetchUrl: vi.fn(async (url: string) => ({ url, content: '' })),
    wikiReconcile: vi.fn(async (input: WikiReconcileInput) => {
      if (input.project_id !== resolvedRootId) {
        throw new Error(`invalid authoritative project_id: ${String(input.project_id)}`);
      }
      reconcileCalls.push(input);
      return { data: result(input), warnings: [] };
    }),
  };
  return { engine: engine as never, raw: engine, reconcileCalls };
}

function llmFor(plan: TopologyPlan) {
  const tools: string[] = [];
  const prompts: string[] = [];
  const llm: LlmClient = {
    configurationFor: () => ({ provider: 'fireworks', reasoningEffort: null }),
    withConfiguration() { return this; },
    previewStructuredCall: async req => immutablePreparedCapture('fireworks', req.model, 'test', buildOpenAiCompatParams(req)),
    structuredCall: async request => {
      tools.push(request.toolName);
      prompts.push(request.user);
      if (request.toolName === 'emit_topology_plan') return { output: plan, usage };
      if (request.toolName === 'emit_wiki_sections') return { output: { now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Threads' }], log_entry: 'Log' }, usage };
      throw new TypeError(`unexpected tool ${request.toolName}`);
    },
  };
  return { llm, tools, prompts };
}

function node(id: string, title = id, body = `${id} body`, types = ['note']) {
  return { id, title, types, fields: {}, body };
}

describe('topic evidence', () => {
  it('reports failed optional body reads as unavailable without making refresh fatal', async () => {
    const engine = {
      semanticRelated: vi.fn(async () => [{ id: 'unavailable', title: 'Unavailable note', types: ['note'], status: null }]),
      getNode: vi.fn(async () => { throw new Error('temporary read failure'); }),
    };
    const ev = await buildTopicEvidence(engine as never, config, root, undefined, [], wiki());
    expect(ev.stableSourceReadUnavailable).toBe(false);
    expect(ev.sourceProjections[0]?.bodyIncluded).toBe(0);
    expect(ev.sources[0]?.availability).toBe('unavailable');
    const selected = selectTopicEvidence({ sources: ev.sources, query: 'note', totalTextBytes: 1000, perSourceBytes: 500 });
    expect(selected.omissions).toContainEqual({ sourceId: 'unavailable', reason: 'unavailable' });
    expect(topicCoverageNote(selected)).toContain('unavailable');
  });
  it('rechecks a semantic source title after reading it so a stale search result cannot include a journal', async () => {
    const engine = {
      semanticRelated: vi.fn(async () => [{ id: 'renamed', title: 'Old search title', types: ['note'], status: null }]),
      getNode: vi.fn(async () => node('renamed', 'Curator Journal — 2026-09', 'journal body')),
    };
    const evidence = await buildTopicEvidence(engine as never, config, root, undefined, [], wiki());
    expect(evidence.evidenceNodes).toEqual([]);
    expect(evidence.observedSourceNodeIds).toEqual([]);
    expect(evidence.evidenceText).not.toContain('journal body');
  });

  it('excludes implicit monthly journals before reads and observed membership, preserving actual topic evidence', async () => {
    const sources = [
      ...['07', '08', '09'].map(month => ({ id: month, title: `Curator Journal — 2026-${month}`, types: ['note'], status: null })),
      { id: 'article', title: 'Curator Journal research', types: ['note'], status: null },
    ];
    const engine = {
      semanticRelated: vi.fn(async () => sources),
      getNode: vi.fn(async (id: string) => node(id, sources.find(s => s.id === id)!.title, id === 'article' ? 'real evidence' : 'huge journal')),
    };
    const evidence = await buildTopicEvidence(engine as never, config, root, undefined, [], wiki());
    expect(evidence.evidenceNodes.map(n => n.id)).toEqual(['article']);
    expect(evidence.observedSourceNodeIds).toEqual(['article']);
    expect(evidence.sourceProjections.map(n => n.nodeId)).toEqual(['article']);
    expect(evidence.evidenceText).toContain('real evidence');
    expect(evidence.evidenceText).not.toContain('huge journal');
    expect(engine.getNode.mock.calls.map(([id]) => id)).toEqual(['article']);
  });

  it('excludes a journal supplied as changed-observed priority but retains a deliberately explicit journal', async () => {
    const engine = {
      semanticRelated: vi.fn(async () => []),
      getNode: vi.fn(async (id: string) => node(id, 'Curator Journal — 2026-09', 'selected journal')),
    };
    const implicit = await buildTopicEvidence(engine as never, config, root, undefined, [], wiki(), [], {
      explicitSourceNodeIds: [], prioritySourceNodeIds: ['journal'],
    });
    expect(implicit.evidenceNodes).toEqual([]);
    expect(implicit.sourceProjections).toEqual([]);
    expect(implicit.observedSourceNodeIds).toEqual([]);
    const explicit = await buildTopicEvidence(engine as never, config, root, undefined, [], wiki(), [], {
      explicitSourceNodeIds: ['journal'], prioritySourceNodeIds: ['journal'],
    });
    expect(explicit.evidenceText).toContain('selected journal');
    expect(explicit.sourceProjections.map(n => n.nodeId)).toEqual(['journal']);
    expect(explicit.observedSourceNodeIds).toEqual([]);
  });

  it('hashes a source the same after links are added around its words (#332)', () => {
    const plain = topicEvidenceHash('T', 'b', [{ id: '1', body: 'Met Dana Whitfield of Acme.' }]);
    expect(topicEvidenceHash('T', 'b', [{ id: '1', body: 'Met [[Dana Whitfield]] of [[Acme Inc|Acme]].' }])).toBe(plain);
    expect(topicEvidenceHash('T', 'b', [{ id: '1', body: 'Met [[Dana Whitfield]] of Acme.' }], { keepLinks: true })).not.toBe(plain);
    expect(topicEvidenceHash('T', 'b', [{ id: '1', body: 'Met Dana Whitfield of Acme. Signed.' }])).not.toBe(plain);
  });

  it('hashes node content independently of input order', () => {
    const first = topicEvidenceHash('T', 'b', [{ id: '2', body: 'two' }, { id: '1', body: 'one' }]);
    const second = topicEvidenceHash('T', 'b', [{ id: '1', body: 'one' }, { id: '2', body: 'two' }]);
    expect(first).toBe(second);
  });

  it('reads explicit then changed-observed sources before semantic retrieval and keeps their stable-ID precedence', async () => {
    const events: string[] = [];
    const related: GapFillCandidate[] = [
      { id: 'root', title: 'Root result', types: ['topic'], status: null },
      { id: 'home', title: 'Home result', types: ['wiki'], status: null },
      { id: 'managed', title: 'Managed result', types: ['wiki'], status: null },
      { id: 'explicit', title: 'Semantic explicit', types: ['wrong'], status: null },
      { id: 'priority', title: 'Semantic priority', types: ['wrong'], status: null },
      { id: 'semantic', title: 'Semantic result', types: ['note'], status: null },
    ];
    const engine = {
      semanticRelated: vi.fn(async () => { events.push('semantic'); return related; }),
      getNode: vi.fn(async (id: string) => {
        events.push(`get:${id}`);
        if (id === 'explicit') return node(id, 'Explicit source', 'explicit body', ['source']);
        if (id === 'priority') return node(id, 'Priority source', 'priority body', ['source']);
        return node(id, 'Semantic node', 'semantic body', ['note']);
      }),
    } as never;

    const evidence = await buildTopicEvidence(
      engine,
      config,
      root,
      'season',
      [],
      wiki({ subpages: [{
        id: 'managed', title: 'Managed', file_path: 'Wikis/Managed.md', version: 1,
        content_hash: 'hash', wiki_state: 'active', wiki_origin: 'automatic',
        wiki_scope: { v: 1, subject: 'Metro Owls', facet: 'managed' }, wiki_pinned: false,
      }] }),
      [],
      {
        explicitSourceNodeIds: ['root', 'explicit', 'home', 'explicit'],
        prioritySourceNodeIds: ['priority', 'managed', 'explicit'],
      },
    );

    expect(events).toEqual(['get:explicit', 'get:priority', 'semantic', 'get:semantic']);
    expect(evidence.evidenceNodes.map(item => item.id)).toEqual(['explicit', 'priority', 'semantic']);
    expect(evidence.evidenceText).toContain('### Explicit source');
    expect(evidence.evidenceText).not.toContain('Semantic explicit');
    expect(evidence.sourceProjections.map(item => item.nodeId)).toEqual(['explicit', 'priority', 'semantic']);
    expect(evidence.observedSourceNodeIds).toEqual(['priority', 'semantic']);
  });

  it('records confirmed-missing explicit projections but treats other stable reads as unavailable', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = {
      semanticRelated: vi.fn(async () => [{ id: 'semantic', title: 'Semantic', types: ['note'], status: null }]),
      getNode: vi.fn(async (id: string) => {
        if (id === 'missing-explicit' || id === 'missing-priority') throw new EngineError('NOT_FOUND', 'gone');
        if (id === 'unavailable') throw new EngineError('INTERNAL_ERROR', 'offline');
        return node(id);
      }),
    } as never;

    const evidence = await buildTopicEvidence(engine, config, root, undefined, [], wiki(), [], {
      explicitSourceNodeIds: ['missing-explicit', 'unavailable'],
      prioritySourceNodeIds: ['missing-priority'],
    });

    expect(evidence.sourceProjections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'missing-explicit', titleAtCommit: null, evidenceState: 'missing', bodyIncluded: 0,
      }),
      expect.objectContaining({ nodeId: 'semantic', evidenceState: 'present' }),
    ]));
    expect(evidence.sourceProjections.map(item => item.nodeId)).not.toContain('missing-priority');
    expect(evidence.sourceProjections.map(item => item.nodeId)).not.toContain('unavailable');
    expect(evidence.warnings).toEqual(['source_read_unavailable']);
    expect(evidence.stableSourceReadUnavailable).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('missing explicit source missing-explicit'));
    warning.mockRestore();
  });

  it('caps a rendered body once and fingerprints exactly that rendered projection', async () => {
    const cappedConfig = { ...config, bodyCharCap: 5 } as Config;
    const engine = {
      semanticRelated: vi.fn(async () => []),
      getNode: vi.fn(async () => node('explicit', '  Explicit title  ', '  abcdefghij  ', ['z', 'a', 'z'])),
    } as never;

    const evidence = await buildTopicEvidence(engine, cappedConfig, root, undefined, [], wiki(), [], {
      explicitSourceNodeIds: ['explicit'], prioritySourceNodeIds: [],
    });
    const renderedBody = 'abcde\n…[truncated 5 chars]';
    const expectedSnapshot = JSON.stringify({
      version: 1,
      nodeId: 'explicit',
      state: 'present',
      title: 'Explicit title',
      types: ['a', 'z'],
      bodyIncluded: true,
      body: renderedBody,
    });
    const expectedHash = createHash('sha256').update(expectedSnapshot).digest('hex');

    expect(evidence.evidenceText).toContain(renderedBody);
    expect(evidence.evidenceText.match(/…\[truncated/g)).toHaveLength(1);
    expect(evidence.sourceProjections).toEqual([
      expect.objectContaining({ nodeId: 'explicit', evidenceHash: expectedHash, bodyIncluded: 1 }),
    ]);
  });

  it('caps observed membership at the first 50 non-explicit sources without displacing explicit membership', async () => {
    const prioritySourceNodeIds = Array.from({ length: 55 }, (_, index) => `priority-${index}`);
    const engine = {
      semanticRelated: vi.fn(async () => []),
      getNode: vi.fn(async (id: string) => node(id)),
    } as never;

    const evidence = await buildTopicEvidence(engine, config, root, undefined, [], wiki(), [], {
      explicitSourceNodeIds: ['explicit'], prioritySourceNodeIds,
    });

    expect(evidence.evidenceNodes).toHaveLength(56);
    expect(evidence.sourceProjections.map(item => item.nodeId)).toContain('explicit');
    expect(evidence.observedSourceNodeIds).toEqual(prioritySourceNodeIds.slice(0, 50));
    expect(evidence.observedSourceNodeIds).not.toContain('explicit');
  });
  it('dates each memory and names its source note, newest first (#474 idea 4)', async () => {
    const engine = {
      semanticRelated: vi.fn(async () => [{ id: 'src', title: 'Spring roster', types: ['note'], status: null }]),
      getNode: vi.fn(async () => node('src', 'Spring roster', 'roster body')),
    };
    const memory = (id: number, content: string, valid_at: string, evidence_node_id: string): Memory => ({ id, source: 'curator', scope: 'vault',
      node_id: null, content, category: 'fact', created_at: valid_at, updated_at: valid_at, valid_at, evidence_kind: 'note', evidence_node_id });
    const ev = await buildTopicEvidence(engine as never, config, root, undefined, [], wiki(), async () => [
      memory(1, 'Older fact.', '2026-03-02T12:00:00.000Z', 'src'), memory(2, 'Newer fact.', '2026-05-09T12:00:00.000Z', 'elsewhere')]);
    expect(ev.evidenceText).toContain([
      '## MEMORIES (durable facts about this topic from earlier notes, conversations and wiki builds; newest first, each with the day it became true and where it came from)',
      '- [fact] 2026-05-09, from a note: Newer fact.',
      '- [fact] 2026-03-02, from "Spring roster": Older fact.'].join('\n'));
  });
});

describe('curateTopic reconciliation', () => {
  const spec: TopicSpec = { source: 'vault', brief: 'season' };

  it("selects topic memories from the topic's own source notes too", async () => {
    const { engine, raw } = engineFor(wiki());
    const { llm } = llmFor({ reviewed_page_ids: [], actions: [] });
    await curateTopic(engine, llm, config, root, spec, options({ force: true }));
    expect(raw.listMemoriesWithTotal).toHaveBeenCalledWith(expect.objectContaining({ scope: 'vault', evidence_node_ids: expect.arrayContaining(['source']) }));
  });

  it("shows the topic's own memories, selected by its name, not the newest in the vault (#297)", async () => {
    const { engine, raw } = engineFor(wiki());
    const { llm, prompts } = llmFor({ reviewed_page_ids: [], actions: [] });
    await curateTopic(engine, llm, config, root, spec, options({ force: true }));
    expect(raw.listMemoriesWithTotal).toHaveBeenCalledWith(expect.objectContaining({ scope: 'vault', query: `"${root.title}"` }));
    expect(raw.listMemoriesWithTotal).not.toHaveBeenCalledWith(expect.objectContaining({ source: 'curator', scope: 'vault', limit: 50 }));
    expect(prompts.some(p => p.includes('## MEMORIES (durable facts about this topic') && p.includes('The owls changed coaches in May.'))).toBe(true);
  });

  it('uses the shared topology pipeline and wiki-reconcile only', async () => {
    const { engine, raw, reconcileCalls } = engineFor(wiki());
    const { llm, tools } = llmFor({ reviewed_page_ids: [], actions: [] });

    const response = await curateTopic(engine, llm, config, root, spec, options({ force: true }));

    expect(response.outcome).toBe('written');
    expect(tools).toEqual(['emit_topology_plan', 'emit_wiki_sections']);
    expect(raw.projectEvidence).toHaveBeenCalledWith(root.id);
    expect(reconcileCalls.map(call => call.dry_run)).toEqual([true, false]);
    expect(reconcileCalls[0]).toMatchObject({ project: root.title, project_id: root.id });
    expect(response.topologyHash).toBe('post-topology');
    // A topic has no tasks, so its Focus items are plain bullets.
    expect(JSON.stringify(reconcileCalls[1])).toContain('"name":"Focus","mode":"replace","content":"- **Focus**"');
  });

  it('defers proposed memory writes behind the core-owned refresh commit material', async () => {
    const { engine, raw } = engineFor(wiki());
    const createMemory = vi.fn(async () => ({ id: 1, operation: 'add' }));
    Object.assign(raw, { createMemory });
    const llm: LlmClient = {
    configurationFor: () => ({ provider: 'fireworks', reasoningEffort: null }),
    withConfiguration() { return this; },
    previewStructuredCall: async req => immutablePreparedCapture('fireworks', req.model, 'test', buildOpenAiCompatParams(req)),
      structuredCall: async request => {
        if (request.toolName === 'emit_topology_plan') {
          return { output: { reviewed_page_ids: [], actions: [] }, usage };
        }
        if (request.toolName === 'emit_wiki_sections') {
          return {
            output: {
              now: 'Now', focus: [{ title: 'Focus' }], open_threads: [{ title: 'Threads' }], log_entry: 'Log',
              memories: [{ content: 'The owls signed a new ace', category: 'fact' }],
            },
            usage,
          };
        }
        throw new TypeError(`unexpected tool ${request.toolName}`);
      },
    };

    const response = await curateTopic(
      engine,
      llm,
      { ...config, memoryWriteEnabled: true },
      root,
      spec,
      options({ force: true }),
    );

    expect(createMemory).not.toHaveBeenCalled();
    const material = topicRefreshCommitMaterial(response);
    await expect(material?.persistMemories?.()).resolves.toMatchObject([{ action: 'created' }]);
    expect(createMemory).toHaveBeenCalledOnce();
  });

  it('resolves a nullable registered root through evidence before reconciliation', async () => {
    const registeredRoot = { ...root, id: null } as unknown as typeof root;
    const { engine, raw, reconcileCalls } = engineFor(wiki(), 'resolved-topic-root');
    const { llm } = llmFor({ reviewed_page_ids: [], actions: [] });

    const response = await curateTopic(engine, llm, config, registeredRoot, spec, options({ force: true }));

    expect(response.outcome).toBe('written');
    expect(raw.projectEvidence).toHaveBeenCalledWith(registeredRoot.title);
    expect(reconcileCalls[0]).toMatchObject({ project: registeredRoot.title, project_id: 'resolved-topic-root' });
    expect(reconcileCalls[0]?.project_id).not.toBe(registeredRoot.title);
  });

  it('skips matching evidence and topology before any LLM or mutation', async () => {
    const hash = topicSynthesisHash(topicEvidenceHash(root.title, spec.brief, [{ id: 'source', body: 'signed a new ace' }]), config);
    const existing = wiki({ home: { id: 'home', version: 2, wiki_evidence_hash: hash, wiki_topology_hash: 'topology', wiki_curated_at: new Date().toISOString() } });
    const { engine, raw } = engineFor(existing);
    const { llm, tools } = llmFor({ reviewed_page_ids: [], actions: [] });

    const response = await curateTopic(engine, llm, config, root, spec, options());

    expect(response.outcome).toBe('skipped');
    expect(topicRefreshCommitMaterial(response)).toBeUndefined();
    expect(tools).toEqual([]);
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
  });

  it('skips a wiki stamped before #332 whose sources are unchanged, links and all', async () => {
    const body = 'Signed [[Ace Pitcher|a new ace]]';
    const stamped = topicSynthesisHash(topicEvidenceHash(root.title, spec.brief, [{ id: 'source', body }], { keepLinks: true }), config);
    expect(stamped).not.toBe(topicSynthesisHash(topicEvidenceHash(root.title, spec.brief, [{ id: 'source', body }]), config));
    const existing = wiki({ home: { id: 'home', version: 2, wiki_evidence_hash: stamped, wiki_topology_hash: 'topology', wiki_curated_at: new Date().toISOString() } });
    const { engine, raw } = engineFor(existing);
    raw.getNode.mockImplementation(async (id: string) => ({ id, title: 'Owls news', types: ['note'], fields: {}, body }));
    const { llm, tools } = llmFor({ reviewed_page_ids: [], actions: [] });

    const response = await curateTopic(engine, llm, config, root, spec, options());

    expect(response.outcome).toBe('skipped');
    expect(tools).toEqual([]);
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
  });

  it('skips a capped wiki whose source gained a link past the cap (Codex, #696)', async () => {
    const capped = { ...config, bodyCharCap: 12 };
    const plain = 'Signed a new ace pitcher today, and more text past the cap. See Owls.';
    const stamped = topicSynthesisHash(topicEvidenceHash(root.title, spec.brief, [{ id: 'source', body: comparableTopicBody(plain, 12) }]), capped);
    const existing = wiki({ home: { id: 'home', version: 2, wiki_evidence_hash: stamped, wiki_topology_hash: 'topology', wiki_curated_at: new Date().toISOString() } });
    const { engine, raw } = engineFor(existing);
    raw.getNode.mockImplementation(async (id: string) => ({ id, title: 'Owls news', types: ['note'], fields: {}, body: plain.replace('See Owls.', 'See [[Owls]].') }));
    const { llm, tools } = llmFor({ reviewed_page_ids: [], actions: [] });

    const response = await curateTopic(engine, llm, capped, root, spec, options());

    expect(response.outcome).toBe('skipped');
    expect(tools).toEqual([]);
  });

  it('runs cadence, baseline-retry, vault-change, and web-change refreshes even when both hashes match', async () => {
    const webSpec: TopicSpec = { source: 'vault+web', brief: 'season', cadence: '1h' };
    const hash = topicEvidenceHash(root.title, webSpec.brief, [{ id: 'source', body: 'signed a new ace' }]);
    const existing = wiki({ home: { id: 'home', version: 2, wiki_evidence_hash: hash, wiki_topology_hash: 'topology', wiki_curated_at: new Date().toISOString() } });

    for (const trigger of ['cadence_due', 'baseline_retry', 'vault_source_changed', 'web_material_change'] as const) {
      const { engine, raw } = engineFor(existing);
      const { llm } = llmFor({ reviewed_page_ids: [], actions: [] });
      const response = await curateTopic(engine, llm, config, root, webSpec, options({
        scheduled: true,
        admission: admission(trigger),
      }));
      expect(response.outcome, trigger).toBe('written');
      expect(raw.webSearch, trigger).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['cadence_due', 'manual_request'] as const)('does not retain old observed priority membership for %s runs', async trigger => {
    const { engine, raw } = engineFor(wiki());
    const { llm } = llmFor({ reviewed_page_ids: [], actions: [] });

    const response = await curateTopic(engine, llm, config, root, spec, options({
      force: trigger === 'cadence_due',
      admission: admission(trigger),
      prioritySourceNodeIds: ['old-observed'],
    }));

    expect(response.outcome).toBe('written');
    expect(raw.getNode).not.toHaveBeenCalledWith('old-observed');
    expect(topicRefreshCommitMaterial(response)?.observedSourceNodeIds).toEqual(['source']);
  });

  it('uses changed observed sources as priority evidence only for vault-source admissions', async () => {
    const { engine, raw } = engineFor(wiki());
    const { llm, prompts } = llmFor({ reviewed_page_ids: [], actions: [] });
    raw.getNode.mockImplementation(async (id: string) => node(id, id === 'changed' ? 'Changed source' : 'Owls news'));

    const response = await curateTopic(engine, llm, config, root, spec, options({
      admission: admission('vault_source_changed', { changedSourceNodeIds: ['changed'] }),
      prioritySourceNodeIds: ['changed'],
    }));

    expect(response.outcome).toBe('written');
    expect(raw.getNode).toHaveBeenCalledWith('changed');
    expect(prompts.join('\n')).toContain('Changed source');
  });

  it('stops before reconciliation when a required stable source becomes unavailable', async () => {
    const { engine, raw } = engineFor(wiki());
    raw.semanticRelated.mockResolvedValue([]);
    raw.getNode.mockRejectedValue(new EngineError('INTERNAL_ERROR', 'offline'));
    const { llm, tools } = llmFor({ reviewed_page_ids: [], actions: [] });

    const response = await curateTopic(engine, llm, config, root, spec, options({
      force: true,
      explicitSourceNodeIds: ['explicit'],
    }));

    expect(response).toMatchObject({
      outcome: 'error',
      detail: 'stable topic source unavailable; refresh state unchanged for retry',
      refreshWarnings: ['source_read_unavailable'],
    });
    expect(raw.getNode).toHaveBeenCalledWith('explicit');
    expect(tools).toEqual([]);
    expect(raw.wikiReconcile).not.toHaveBeenCalled();
    expect(topicRefreshCommitMaterial(response)).toBeUndefined();
  });
});

describe('buildWebEvidence', () => {
  it('skips malformed web URLs without discarding valid results or inventing a probe', async () => {
    const engine = {
      webSearch: vi.fn(async () => [
        { title: 'Before', url: 'https://example.test/before', snippet: 'BEFORE_FACT' },
        { title: 'Missing', url: '', snippet: 'INVALID_FACT' },
        { title: 'Invalid', url: 'not a URL', snippet: 'INVALID_FACT' },
        { title: 'After', url: 'https://example.test/after', snippet: 'AFTER_FACT' },
      ]),
      fetchUrl: vi.fn(async (_url: string) => { throw new Error('use snippet'); }),
    };
    const evidence = await buildWebEvidence(engine as never, config, root.title, undefined);
    expect(evidence.resultCount).toBe(2);
    expect(evidence.webText).toContain('BEFORE_FACT');
    expect(evidence.webText).toContain('AFTER_FACT');
    expect(evidence.webText).not.toContain('INVALID_FACT');
    expect(evidence.evidenceSources?.map(s => s.origin)).toEqual([
      { kind: 'web', url: 'https://example.test/before' }, { kind: 'web', url: 'https://example.test/after' },
    ]);
    expect(evidence.sources.map(s => s.url)).toEqual(['https://example.test/before', 'https://example.test/after']);
    expect(engine.fetchUrl.mock.calls.map(c => c[0])).not.toContain('');
    expect(evidence.probe).toBeUndefined();
  });
  it('attributes and fetches configured top sources during an ordinary full search', async () => {
    const engine = {
      webSearch: vi.fn(async () => [
        { title: 'Report', url: 'https://example.test/report', snippet: 'snippet' },
        { title: 'Follow-up', url: 'https://example.test/follow-up', snippet: 'follow-up snippet' },
        { title: 'Third', url: 'https://example.test/third', snippet: 'third snippet' },
      ]),
      fetchUrl: vi.fn(async (url: string) => ({ url, content: `full ${url}` })),
    };
    const evidence = await buildWebEvidence(engine as never, config, root.title, undefined);
    expect(evidence.webText).toContain('full https://example.test/report');
    expect(evidence.sources).toEqual([
      { title: 'Report', url: 'https://example.test/report' },
      { title: 'Follow-up', url: 'https://example.test/follow-up' },
      { title: 'Third', url: 'https://example.test/third' },
    ]);
    expect(engine.fetchUrl).toHaveBeenCalledTimes(config.webFetchTop);
    expect(evidence.probe?.results).toHaveLength(3);
  });

  it('keeps all configured ordinary search results for synthesis while bounding the canonical probe', async () => {
    const resultCount = 25;
    const searchResults = Array.from({ length: resultCount }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.test/result-${String(index).padStart(2, '0')}`,
      snippet: `Snippet ${index}`,
    }));
    const expandedConfig = {
      ...config,
      webSearchResults: resultCount,
      webFetchTop: 23,
    } as Config;
    const engine = {
      webSearch: vi.fn(async () => searchResults),
      fetchUrl: vi.fn(async (url: string) => ({ url, content: `full ${url}` })),
    };

    const evidence = await buildWebEvidence(
      engine as never,
      expandedConfig,
      root.title,
      undefined,
    );

    expect(engine.webSearch).toHaveBeenCalledWith(root.title, resultCount);
    expect(evidence.resultCount).toBe(resultCount);
    expect(evidence.sources).toEqual(searchResults.map(({ title, url }) => ({ title, url })));
    expect(evidence.webText).toContain('### Result 24');
    expect(engine.fetchUrl).toHaveBeenCalledTimes(expandedConfig.webFetchTop);
    expect(engine.fetchUrl).toHaveBeenLastCalledWith('https://example.test/result-22');
    expect(evidence.probe?.results).toHaveLength(20);
  });

  it('reuses admitted results without another search and fetches only the configured top pages', async () => {
    const admitted: CanonicalWebProbe = {
      version: 1,
      hash: 'admitted-hash',
      snapshotJson: '{"version":1,"results":[]}',
      results: [
        { title: 'A', url: 'https://example.test/a', snippet: 'A snippet', published: null },
        { title: 'B', url: 'https://example.test/b', snippet: 'B snippet', published: '2026-08-29' },
        { title: 'C', url: 'https://example.test/c', snippet: 'C snippet', published: null },
      ],
    };
    const engine = {
      webSearch: vi.fn(async () => { throw new Error('must not search'); }),
      fetchUrl: vi.fn(async (url: string) => ({ url, content: `fetched ${url}` })),
    };

    const evidence = await buildWebEvidence(engine as never, config, root.title, undefined, admitted);

    expect(engine.webSearch).not.toHaveBeenCalled();
    expect(engine.fetchUrl).toHaveBeenCalledTimes(2);
    expect(engine.fetchUrl).toHaveBeenNthCalledWith(1, 'https://example.test/a');
    expect(engine.fetchUrl).toHaveBeenNthCalledWith(2, 'https://example.test/b');
    expect(evidence.webText).toContain('C snippet');
    expect(evidence.probe).toBe(admitted);
  });

  it('returns a valid canonical empty probe for an empty successful search', async () => {
    const engine = {
      webSearch: vi.fn(async () => []),
      fetchUrl: vi.fn(async () => ({ url: '', content: '' })),
    };

    const evidence = await buildWebEvidence(engine as never, config, root.title, undefined);

    expect(evidence).toMatchObject({ webText: '', sources: [], resultCount: 0 });
    expect(evidence.probe).toMatchObject({ version: 1, results: [] });
  });

  it('returns unavailable after a failed search instead of inventing an empty baseline', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = {
      webSearch: vi.fn(async () => { throw new Error('offline'); }),
      fetchUrl: vi.fn(async () => ({ url: '', content: '' })),
    };

    const evidence = await buildWebEvidence(engine as never, config, root.title, undefined);

    expect(evidence).toMatchObject({ webText: '', sources: [], resultCount: 0 });
    expect(evidence.probe).toBeUndefined();
    warning.mockRestore();
  });

  it('threads an admitted web probe into synthesis and written-only internal commit material', async () => {
    const admitted: CanonicalWebProbe = {
      version: 1,
      hash: 'admitted-hash',
      snapshotJson: '{"version":1,"results":[]}',
      results: [{ title: 'Admitted', url: 'https://example.test/admitted', snippet: 'material update', published: null }],
    };
    const { engine, raw } = engineFor(wiki());
    const { llm, prompts } = llmFor({ reviewed_page_ids: [], actions: [] });
    raw.webSearch.mockImplementation(async () => { throw new Error('must not search'); });

    const response = await curateTopic(
      engine,
      llm,
      config,
      root,
      { source: 'vault+web', brief: 'season' },
      options({ admission: admission('web_material_change', { webProbe: admitted }) }),
    );

    expect(response.outcome).toBe('written');
    expect(raw.webSearch).not.toHaveBeenCalled();
    expect(prompts.join('\n')).toContain('material update');
    expect(topicRefreshCommitMaterial(response)?.webProbe).toBe(admitted);
    expect(Object.keys(response)).not.toContain('refreshCommitMaterial');
    expect(JSON.stringify(response)).not.toContain('snapshotJson');
    expect(JSON.stringify(response)).not.toContain('signed a new ace');
  });
});

it('bounds a repaired multi-megabyte topic run, attributes web pages and commits exact selection metadata', async () => {
  const sourceBody = 'Historical unrelated material. '.repeat(80000) + '\n\n## Engines\nNATIVE_LATE_FACT engine design';
  const existing = wiki({ subpages: ['engines', 'orbits'].map(id => ({
    id, title: id, file_path: id + '.md', version: 1, content_hash: id, wiki_state: 'active' as const,
    wiki_kind: 'freeform' as const, wiki_origin: 'automatic' as const, wiki_pinned: false,
    wiki_scope: { v: 1 as const, subject: root.title, facet: id },
  })) });
  const { engine, raw, reconcileCalls } = engineFor(existing);
  raw.getNode.mockImplementation(async id => node(id, id, id === 'source' ? sourceBody : '## Prior facts\n\nKeep these facts.'));
  raw.webSearch.mockResolvedValue([{ title: 'Orbits', url: 'https://example.org/orbits', snippet: 'orbital changes' }] as never);
  raw.fetchUrl.mockImplementation(async url => ({ url, content: 'WEB_ORBIT_FACT orbital periods' }));
  let plannerCalls = 0;
  const requests: Record<string, any>[] = [];
  const create = vi.fn(async (params: Record<string, any>) => {
    requests.push(params);
    const tool = params.response_format?.json_schema?.name;
    let output: unknown;
    if (tool === 'emit_topology_plan') {
      plannerCalls++;
      output = { reviewed_page_ids: ['engines', 'orbits'], actions: existing.subpages.map(page => ({
        op: 'refresh', node_id: page.id, scope: page.wiki_scope, synthesis_brief: page.id,
        evidence_ids: plannerCalls === 1 ? ['unknown'] : [page.id === 'engines' ? 'source' : webSourceId('https://example.org/orbits')],
      })) };
    } else if (tool === 'emit_wiki_sections') output = { now: 'Current findings.', focus: [{ title: 'Review changes.' }],
      open_threads: [{ title: 'Check remaining sources.' }], log_entry: 'Updated pages.' };
    else output = { body: '## Findings\n\nSupported findings from selected sources.' };
    return { choices: [{ message: { content: tool ? JSON.stringify(output) : pageOutputFrame(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } };
  });
  const llm = new OpenAiCompatLlmClient({ chat: { completions: { create } } } as unknown as OpenAI);
  const result = await curateTopic(engine, llm, { ...config, bodyCharCap: null }, root,
    { source: 'vault+web', brief: 'Engines and orbits' }, options({ scheduled: true, admission: admission('cadence_due') }));
  expect(result.outcome, result.detail).toBe('written');
  expect(plannerCalls).toBe(2);
  expect(requests).toHaveLength(5);
  for (const req of requests) {
    expect(Buffer.byteLength(JSON.stringify(req))).toBeLessThanOrEqual(req.response_format ? 204800 : 98304);
  }
  const pages = requests.filter(req => !req.response_format).map(req => JSON.parse(req.messages[1].content));
  expect(pages[0].evidence).toContain('NATIVE_LATE_FACT');
  expect(pages[0].evidence).not.toContain('WEB_ORBIT_FACT');
  expect(pages[1].evidence).toContain('WEB_ORBIT_FACT');
  expect(pages[1].evidence).toContain('https://example.org/orbits');
  expect(JSON.stringify(reconcileCalls)).toContain('Source coverage:');
  expect(result.evidenceSelection?.calls).toHaveLength(5);
  const material = topicRefreshCommitMaterial(result)!;
  const db = new Database(':memory:'); runMigrations(db);
  commitTopicRefreshBaseline(db, { rootTitle: root.title, sourceCommittedAt: '2026-09-27T00:00:00.000Z',
    sourceProjections: material.sourceProjections, observedSourceNodeIds: material.observedSourceNodeIds });
  const rows = observedTopicRefreshSources(db, root.title);
  const row = rows.find(r => r.node_id === 'source')!;
  const metadata = JSON.parse(row.selection_json!);
  expect(metadata.originalBytes).toBeGreaterThan(2000000);
  expect(metadata.retainedBytes).toBeLessThan(metadata.originalBytes);
  expect(metadata.inputHash).toBe(row.evidence_hash);
  expect(metadata.freshnessHash).not.toBe(metadata.inputHash);
  const admissionResult = await admitTopicRefresh({ scheduled: true, force: false, cadenceDue: false,
    earlyRefreshEnabled: true, persistProbeCache: false }, {
    loadState: () => ({ pendingSourceChange: false, pendingBaselineRetry: false, sourceCommittedAt: '2026-09-27T00:00:00.000Z',
      committedSources: rows }),
    readCommittedSources: async () => ({ results: [{ nodeId: 'source', state: 'present', title: 'source', types: ['note'], renderedBody: sourceBody }] }),
    probeWeb: async () => ({ ok: false, reason: 'web_probe_overflow' }),
    assessWeb: async () => { throw new Error('unexpected'); },
    budget: { remaining: () => 0, tryConsumeNovelCall: () => false },
  });
  expect(admissionResult.changedSourceNodeIds).toEqual([]);
  db.close();
});
