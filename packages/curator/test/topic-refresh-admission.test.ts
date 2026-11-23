import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { TopicRefreshSourceRow } from '../src/db/topic-refresh.js';
import {
  admitTopicRefresh,
  type TopicRefreshAdmissionDeps,
  type TopicRefreshAdmissionInput,
  type TopicRefreshAdmissionWarning,
  type TopicRefreshAssessmentBudget,
  type TopicRefreshTrigger,
  type TopicRefreshStateSnapshot,
  type TopicSourceReadResult,
} from '../src/topic-refresh-admission.js';
import type { TopicWebMaterialityAssessment } from '../src/topic-refresh-assessment.js';
import {
  buildCanonicalWebProbe,
  comparableTopicBody,
  topicVaultSourceFingerprint,
  type CanonicalWebProbe,
} from '../src/topic-refresh-evidence.js';

const CAPTURED_AT = '2026-08-30T12:00:00.000Z';

function probe(url: string, snippet = url): CanonicalWebProbe {
  const built = buildCanonicalWebProbe([{ url, title: url, snippet, published: null }]);
  if (!built.ok) throw new Error('test probe unexpectedly overflowed');
  return built.probe;
}

function present(
  nodeId: string,
  overrides: Partial<Extract<TopicSourceReadResult, { state: 'present' }>> = {},
): Extract<TopicSourceReadResult, { state: 'present' }> {
  return {
    nodeId,
    state: 'present',
    title: `Title ${nodeId}`,
    types: ['Source'],
    renderedBody: `Body ${nodeId}`,
    ...overrides,
  };
}

function sourceRow(
  nodeId: string,
  current: Extract<TopicSourceReadResult, { state: 'present' }> = present(nodeId),
  bodyIncluded = true,
  sourceKind: TopicRefreshSourceRow['source_kind'] = 'observed',
): TopicRefreshSourceRow {
  const fingerprint = topicVaultSourceFingerprint({
    nodeId,
    title: current.title,
    types: current.types,
    bodyIncluded,
    renderedBody: current.renderedBody,
  });
  return {
    root_title: 'Topic',
    node_id: nodeId,
    source_kind: sourceKind,
    title_at_commit: fingerprint.projection.state === 'present'
      ? fingerprint.projection.title
      : null,
    evidence_state: 'present',
    body_included: bodyIncluded ? 1 : 0,
    fingerprint_version: fingerprint.version,
    evidence_hash: fingerprint.hash,
    captured_at: CAPTURED_AT,
  };
}

function missingRow(nodeId: string): TopicRefreshSourceRow {
  const fingerprint = topicVaultSourceFingerprint({ nodeId, state: 'missing' });
  return {
    root_title: 'Topic',
    node_id: nodeId,
    source_kind: 'observed',
    title_at_commit: null,
    evidence_state: 'missing',
    body_included: 0,
    fingerprint_version: fingerprint.version,
    evidence_hash: fingerprint.hash,
    captured_at: CAPTURED_AT,
  };
}

function assessment(
  verdict: TopicWebMaterialityAssessment['verdict'],
  current: CanonicalWebProbe,
): TopicWebMaterialityAssessment {
  if (verdict === 'material') {
    return {
      verdict,
      reasonCode: 'new_development',
      changedUrls: [current.results[0]!.url],
    };
  }
  if (verdict === 'immaterial') {
    return { verdict, reasonCode: 'restatement', changedUrls: [] };
  }
  return { verdict, reasonCode: 'insufficient_evidence', changedUrls: [] };
}

function input(overrides: Partial<TopicRefreshAdmissionInput> = {}): TopicRefreshAdmissionInput {
  return {
    scheduled: true,
    force: false,
    cadenceDue: false,
    earlyRefreshEnabled: true,
    persistProbeCache: true,
    ...overrides,
  };
}

function state(overrides: Partial<TopicRefreshStateSnapshot> = {}): TopicRefreshStateSnapshot {
  return {
    pendingSourceChange: false,
    pendingBaselineRetry: false,
    sourceCommittedAt: CAPTURED_AT,
    committedSources: [],
    committedWebProbe: probe('https://example.com/committed'),
    ...overrides,
  };
}

function harness(options: {
  snapshot?: TopicRefreshStateSnapshot;
  sourceResults?: readonly TopicSourceReadResult[];
  currentProbe?: CanonicalWebProbe;
  webAssessment?: TopicWebMaterialityAssessment;
  budgetAllows?: boolean;
} = {}): {
  deps: TopicRefreshAdmissionDeps;
  loadState: ReturnType<typeof vi.fn<TopicRefreshAdmissionDeps['loadState']>>;
  readCommittedSources: ReturnType<typeof vi.fn<TopicRefreshAdmissionDeps['readCommittedSources']>>;
  probeWeb: ReturnType<typeof vi.fn<TopicRefreshAdmissionDeps['probeWeb']>>;
  assessWeb: ReturnType<typeof vi.fn<TopicRefreshAdmissionDeps['assessWeb']>>;
  persistProbeCache: ReturnType<typeof vi.fn<NonNullable<TopicRefreshAdmissionDeps['persistProbeCache']>>>;
  tryConsumeNovelCall: ReturnType<typeof vi.fn<TopicRefreshAssessmentBudget['tryConsumeNovelCall']>>;
} {
  const snapshot = options.snapshot ?? state();
  const currentProbe = options.currentProbe ?? snapshot.committedWebProbe
    ?? probe('https://example.com/current');
  const loadState = vi.fn(() => snapshot);
  const readCommittedSources = vi.fn(async () => ({ results: options.sourceResults ?? [] }));
  const probeWeb = vi.fn(async () => ({ ok: true as const, probe: currentProbe }));
  const assessWeb = vi.fn(async () => options.webAssessment ?? assessment('immaterial', currentProbe));
  const persistProbeCache = vi.fn(() => undefined);
  const tryConsumeNovelCall = vi.fn(() => options.budgetAllows ?? true);
  const deps: TopicRefreshAdmissionDeps = {
    loadState,
    readCommittedSources,
    probeWeb,
    assessWeb,
    persistProbeCache,
    budget: { tryConsumeNovelCall, remaining: () => options.budgetAllows === false ? 0 : 1 },
  };
  return {
    deps,
    loadState,
    readCommittedSources,
    probeWeb,
    assessWeb,
    persistProbeCache,
    tryConsumeNovelCall,
  };
}

describe('implicit journal source exclusion', () => {
  it.each(['present', 'missing', 'unavailable'] as const)('ignores persisted journal membership when now %s without reading it', async currentState => {
    const prior = present('journal', { title: 'Curator Journal — 2026-09', renderedBody: 'old entry' });
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('journal', prior)] }),
      sourceResults: [currentState === 'present' ? { ...prior, renderedBody: 'new entry' } : { nodeId: 'journal', state: currentState }],
    });
    const result = await admitTopicRefresh(input(), h.deps);
    expect(result).toMatchObject({ admit: false, trigger: 'not_due', changedSourceNodeIds: [], warnings: [] });
    expect(h.readCommittedSources).not.toHaveBeenCalled();
    expect(h.assessWeb).not.toHaveBeenCalled();
  });

  it('ignores an observed source newly identified as a journal while keeping genuine changed sources', async () => {
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('journal'), sourceRow('news')] }),
      sourceResults: [
        present('journal', { title: 'Curator Journal — 2026-09' }),
        present('news', { renderedBody: 'real change' }),
      ],
    });
    expect(await admitTopicRefresh(input(), h.deps)).toMatchObject({
      admit: true, trigger: 'vault_source_changed', changedSourceNodeIds: ['news'],
    });
  });

  it('still admits a changed journal explicitly selected by the caller', async () => {
    const prior = present('journal', { title: 'Curator Journal — 2026-09', renderedBody: 'old' });
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('journal', prior, true, 'explicit')] }),
      sourceResults: [{ ...prior, renderedBody: 'new' }],
    });
    expect(await admitTopicRefresh(input(), h.deps)).toMatchObject({
      admit: true, trigger: 'vault_source_changed', changedSourceNodeIds: ['journal'],
    });
  });
});

describe('topic refresh admission branch order', () => {
  it('keeps trigger and warning contracts closed to the specified values', () => {
    expectTypeOf<TopicRefreshTrigger>().toEqualTypeOf<
      | 'manual_request'
      | 'manual_force'
      | 'cadence_due'
      | 'baseline_retry'
      | 'vault_source_changed'
      | 'web_material_change'
      | 'not_due'
    >();
    expectTypeOf<TopicRefreshAdmissionWarning>().toEqualTypeOf<
      | 'source_baseline_not_ready'
      | 'source_read_unavailable'
      | 'web_baseline_not_ready'
      | 'web_probe_unavailable'
      | 'web_probe_overflow'
      | 'assessment_cap_exhausted'
      | 'assessment_failed'
      | 'refresh_state_persist_failed'
    >();
  });

  it.each([
    ['non-scheduled force', input({ scheduled: false, force: true }), 'manual_force'],
    ['non-scheduled ordinary request', input({ scheduled: false }), 'manual_request'],
    ['scheduled force', input({ force: true }), 'manual_force'],
    ['cadence due', input({ cadenceDue: true }), 'cadence_due'],
  ] as const)('%s returns before refresh-state, source, and web work', async (_label, request, trigger) => {
    const h = harness();

    await expect(admitTopicRefresh(request, h.deps)).resolves.toEqual({
      admit: true,
      trigger,
      changedSourceNodeIds: [],
      warnings: [],
    });
    expect(h.loadState).not.toHaveBeenCalled();
    expect(h.readCommittedSources).not.toHaveBeenCalled();
    expect(h.probeWeb).not.toHaveBeenCalled();
    expect(h.assessWeb).not.toHaveBeenCalled();
  });

  it('returns not_due after checking only durable retry state when early refresh is disabled', async () => {
    const h = harness();

    await expect(admitTopicRefresh(input({ earlyRefreshEnabled: false }), h.deps)).resolves.toEqual({
      admit: false,
      trigger: 'not_due',
      changedSourceNodeIds: [],
      warnings: [],
    });
    expect(h.loadState).toHaveBeenCalledOnce();
    expect(h.readCommittedSources).not.toHaveBeenCalled();
    expect(h.probeWeb).not.toHaveBeenCalled();
    expect(h.assessWeb).not.toHaveBeenCalled();
  });

  it('admits a durable baseline retry before the feature-off gate without source or web work', async () => {
    const h = harness({ snapshot: state({ pendingBaselineRetry: true }) });

    await expect(admitTopicRefresh(input({ earlyRefreshEnabled: false }), h.deps)).resolves.toEqual({
      admit: true,
      trigger: 'baseline_retry',
      changedSourceNodeIds: [],
      warnings: [],
    });
    expect(h.loadState).toHaveBeenCalledOnce();
    expect(h.readCommittedSources).not.toHaveBeenCalled();
    expect(h.probeWeb).not.toHaveBeenCalled();
    expect(h.assessWeb).not.toHaveBeenCalled();
  });

  it('admits a pending source configuration before source or web reads', async () => {
    const h = harness({ snapshot: state({ pendingSourceChange: true }) });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'vault_source_changed',
    });
    expect(h.readCommittedSources).not.toHaveBeenCalled();
    expect(h.probeWeb).not.toHaveBeenCalled();
  });

  it('admits a committed source change before web or assessment work', async () => {
    const row = sourceRow('source-a');
    const h = harness({
      snapshot: state({ committedSources: [row] }),
      sourceResults: [present('source-a', { title: 'Changed title' })],
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'vault_source_changed',
      changedSourceNodeIds: ['source-a'],
    });
    expect(h.probeWeb).not.toHaveBeenCalled();
    expect(h.assessWeb).not.toHaveBeenCalled();
  });

  it('does not admit a source that only gained links around its words (#332)', async () => {
    const before = present('source-a', { renderedBody: 'Met Dana Whitfield of Acme.' });
    const linked = present('source-a', { renderedBody: 'Met [[Dana Whitfield]] of [[Acme Inc|Acme]].' });
    const h = harness({ snapshot: state({ committedSources: [sourceRow('source-a', before)] }), sourceResults: [linked] });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({ admit: false, trigger: 'not_due' });
  });

  it('reads a record from before #332, made from the body as written, as unchanged too', async () => {
    const written = present('source-a', { renderedBody: 'Met [[Dana Whitfield]] of Acme.' });
    const row = sourceRow('source-a', written);
    // As recorded before #332: the body's hash with its links kept.
    const legacy = topicVaultSourceFingerprint({ nodeId: 'source-a', title: written.title, types: written.types,
      bodyIncluded: true, renderedBody: written.renderedBody, keepLinks: true });
    const h = harness({ snapshot: state({ committedSources: [{ ...row, evidence_hash: legacy.hash }] }), sourceResults: [written] });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({ admit: false, trigger: 'not_due' });
  });

  it('does not admit a capped source that gained a link, inside or past the cap (Codex, #696)', async () => {
    const tail = ' and more text after it.'.repeat(4);
    const read = (raw: string) => present('source-a', { renderedBody: raw.slice(0, 30), comparableBody: comparableTopicBody(raw, 30) });
    const before = read(`Met Dana Whitfield of Acme.${tail} See Acme.`);
    const row = { ...sourceRow('source-a', before), evidence_hash: topicVaultSourceFingerprint({ nodeId: 'source-a', title: before.title,
      types: before.types, bodyIncluded: true, renderedBody: before.renderedBody, comparableBody: before.comparableBody }).hash };
    for (const linked of [`Met [[Dana Whitfield]] of Acme.${tail} See Acme.`, `Met Dana Whitfield of Acme.${tail} See [[Acme]].`]) {
      const h = harness({ snapshot: state({ committedSources: [row] }), sourceResults: [read(linked)] });
      await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({ admit: false });
    }
  });

  it('still admits a source whose words changed', async () => {
    const before = present('source-a', { renderedBody: 'Met Dana Whitfield of Acme.' });
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('source-a', before)] }),
      sourceResults: [present('source-a', { renderedBody: 'Met [[Dana Whitfield]] of Acme. The pilot slipped.' })],
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({ admit: true, changedSourceNodeIds: ['source-a'] });
  });

  it('proceeds to web comparison after unchanged committed sources', async () => {
    const current = present('source-a');
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('source-a', current)] }),
      sourceResults: [current],
    });

    const result = await admitTopicRefresh(input(), h.deps);

    expect(result).toMatchObject({ admit: false, trigger: 'not_due' });
    expect(h.probeWeb).toHaveBeenCalledOnce();
  });

  it('warns on a missing source baseline without mass-refreshing and still compares web', async () => {
    const h = harness({ snapshot: state({ sourceCommittedAt: undefined }) });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      warnings: ['source_baseline_not_ready'],
    });
    expect(h.readCommittedSources).not.toHaveBeenCalled();
    expect(h.probeWeb).toHaveBeenCalledOnce();
  });

  it('treats an empty committed source set as a ready unchanged baseline', async () => {
    const h = harness();

    const result = await admitTopicRefresh(input(), h.deps);

    expect(result.warnings).not.toContain('source_baseline_not_ready');
    expect(h.readCommittedSources).not.toHaveBeenCalled();
    expect(h.probeWeb).toHaveBeenCalledOnce();
  });

  it('returns web_baseline_not_ready without probing when no committed web baseline exists', async () => {
    const h = harness({ snapshot: state({ committedWebProbe: undefined }) });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      warnings: ['web_baseline_not_ready'],
    });
    expect(h.probeWeb).not.toHaveBeenCalled();
  });

  it('does not let an unavailable source admit but independently admits a material web change', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/new');
    const h = harness({
      snapshot: state({
        committedSources: [sourceRow('source-a')],
        committedWebProbe: committed,
      }),
      sourceResults: [{ nodeId: 'source-a', state: 'unavailable' }],
      currentProbe: current,
      webAssessment: assessment('material', current),
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'web_material_change',
      changedSourceNodeIds: [],
      warnings: ['source_read_unavailable'],
    });
  });

  it('fails a rejected source read closed and still permits independent web comparison', async () => {
    const h = harness({ snapshot: state({ committedSources: [sourceRow('source-a')] }) });
    h.readCommittedSources.mockRejectedValueOnce(new Error('transport unavailable'));

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      changedSourceNodeIds: [],
      warnings: ['source_read_unavailable'],
    });
    expect(h.probeWeb).toHaveBeenCalledOnce();
  });
});

describe('topic refresh committed source comparison', () => {
  it.each([
    ['title', present('source-a', { title: 'New title' })],
    ['type', present('source-a', { types: ['ChangedType'] })],
    ['included body', present('source-a', { renderedBody: 'Changed body' })],
  ] as const)('admits when the synthesis-visible %s digest changes', async (_field, changed) => {
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('source-a')] }),
      sourceResults: [changed],
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'vault_source_changed',
      changedSourceNodeIds: ['source-a'],
    });
  });

  it('admits a confirmed missing projection after a present projection', async () => {
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('source-a')] }),
      sourceResults: [{ nodeId: 'source-a', state: 'missing' }],
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'vault_source_changed',
      changedSourceNodeIds: ['source-a'],
    });
  });

  it('does not change an already missing projection', async () => {
    const h = harness({
      snapshot: state({ committedSources: [missingRow('source-a')] }),
      sourceResults: [{ nodeId: 'source-a', state: 'missing' }],
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      changedSourceNodeIds: [],
    });
  });

  it('turns an unavailable result into only a warning and no new fingerprint', async () => {
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('source-a')] }),
      sourceResults: [{ nodeId: 'source-a', state: 'unavailable' }],
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      changedSourceNodeIds: [],
      warnings: ['source_read_unavailable'],
    });
  });

  it('ignores a body change when the committed source excluded its body', async () => {
    const original = present('source-a', { renderedBody: 'Old body' });
    const h = harness({
      snapshot: state({ committedSources: [sourceRow('source-a', original, false)] }),
      sourceResults: [present('source-a', { renderedBody: 'New body' })],
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      changedSourceNodeIds: [],
    });
  });

  it('deduplicates, lexically sorts, and caps changed source IDs at 70', async () => {
    const ids = Array.from({ length: 75 }, (_, index) => `source-${index}`);
    const rows = ids.flatMap((nodeId, index) => [
      sourceRow(nodeId),
      ...(index < 5 ? [sourceRow(nodeId, present(nodeId), true, 'explicit')] : []),
    ]);
    const h = harness({
      snapshot: state({ committedSources: rows }),
      sourceResults: ids.map(nodeId => present(nodeId, { title: `Changed ${nodeId}` })),
    });

    const result = await admitTopicRefresh(input(), h.deps);

    expect(result.changedSourceNodeIds).toEqual([...ids].sort().slice(0, 70));
    expect(result.changedSourceNodeIds).toHaveLength(70);
  });

  it('keeps semantic-neighborhood membership outside the admission dependency surface', () => {
    const h = harness();

    expectTypeOf(h.deps).toMatchTypeOf<TopicRefreshAdmissionDeps>();
    expect('semanticRelated' in h.deps).toBe(false);
  });
});

describe('topic refresh web comparison, cache, and assessment cap', () => {
  it('skips an unchanged committed hash without model or cap consumption', async () => {
    const h = harness();

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
    });
    expect(h.assessWeb).not.toHaveBeenCalled();
    expect(h.tryConsumeNovelCall).not.toHaveBeenCalled();
  });

  it.each(['immaterial', 'uncertain'] as const)(
    'reuses a sanitized cached %s verdict without model or cap consumption',
    async (verdict) => {
      const committed = probe('https://example.com/old');
      const current = probe('https://example.com/current');
      const cached = assessment(verdict, current);
      const h = harness({
        snapshot: state({
          committedWebProbe: committed,
          lastProbe: { probe: current, assessment: cached },
        }),
        currentProbe: current,
      });

      await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
        admit: false,
        trigger: 'not_due',
        webProbe: current,
        webAssessment: cached,
      });
      expect(h.assessWeb).not.toHaveBeenCalled();
      expect(h.tryConsumeNovelCall).not.toHaveBeenCalled();
    },
  );

  it('re-admits a cached material verdict after a prior full-curation failure', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const cached = assessment('material', current);
    const h = harness({
      snapshot: state({
        committedWebProbe: committed,
        lastProbe: { probe: current, assessment: cached },
      }),
      currentProbe: current,
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'web_material_change',
      webAssessment: cached,
    });
    expect(h.assessWeb).not.toHaveBeenCalled();
    expect(h.tryConsumeNovelCall).not.toHaveBeenCalled();
  });

  it('compares a novel current probe with committed evidence rather than the cached probe', async () => {
    const committed = probe('https://example.com/committed');
    const cached = probe('https://example.com/cached');
    const current = probe('https://example.com/current');
    const h = harness({
      snapshot: state({
        committedWebProbe: committed,
        lastProbe: { probe: cached, assessment: assessment('immaterial', cached) },
      }),
      currentProbe: current,
    });

    await admitTopicRefresh(input(), h.deps);

    expect(h.assessWeb).toHaveBeenCalledWith(committed, current);
  });

  it.each([
    ['material without changed URL', { verdict: 'material', reasonCode: 'new_development', changedUrls: [] }],
    ['material with an incompatible reason', { verdict: 'material', reasonCode: 'restatement', changedUrls: ['https://example.com/current'] }],
    ['unknown verdict', { verdict: 'yes', reasonCode: 'new_development', changedUrls: ['https://example.com/current'] }],
  ])('fails closed for %s', async (_label, raw) => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const h = harness({
      snapshot: state({ committedWebProbe: committed }),
      currentProbe: current,
      webAssessment: raw as TopicWebMaterialityAssessment,
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      webAssessment: {
        verdict: 'uncertain',
        reasonCode: 'insufficient_evidence',
        changedUrls: [],
      },
    });
  });

  it('admits only a valid material assessment', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const h = harness({
      snapshot: state({ committedWebProbe: committed }),
      currentProbe: current,
      webAssessment: assessment('material', current),
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'web_material_change',
    });
  });

  it('fails closed with web_probe_unavailable when search throws', async () => {
    const h = harness();
    h.probeWeb.mockRejectedValueOnce(new Error('search unavailable'));

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      warnings: ['web_probe_unavailable'],
    });
    expect(h.assessWeb).not.toHaveBeenCalled();
  });

  it('fails closed with web_probe_overflow when canonicalization cannot fit identity data', async () => {
    const h = harness();
    h.probeWeb.mockResolvedValueOnce({ ok: false, reason: 'web_probe_overflow' });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      warnings: ['web_probe_overflow'],
    });
    expect(h.assessWeb).not.toHaveBeenCalled();
  });

  it('leaves a novel probe retryable when the shared cap is exhausted', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const h = harness({
      snapshot: state({ committedWebProbe: committed }),
      currentProbe: current,
      budgetAllows: false,
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      webProbe: current,
      warnings: ['assessment_cap_exhausted'],
    });
    expect(h.tryConsumeNovelCall).toHaveBeenCalledOnce();
    expect(h.assessWeb).not.toHaveBeenCalled();
    expect(h.persistProbeCache).not.toHaveBeenCalled();
  });

  it('consumes one shared budget unit exactly once for an actual novel structured call', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const h = harness({ snapshot: state({ committedWebProbe: committed }), currentProbe: current });

    await admitTopicRefresh(input(), h.deps);

    expect(h.tryConsumeNovelCall).toHaveBeenCalledOnce();
    expect(h.assessWeb).toHaveBeenCalledOnce();
  });
});

describe('topic refresh assessment cache persistence', () => {
  it('returns a dry-run novel assessment without writing the probe cache', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const material = assessment('material', current);
    const h = harness({
      snapshot: state({ committedWebProbe: committed }),
      currentProbe: current,
      webAssessment: material,
    });

    await expect(admitTopicRefresh(input({ persistProbeCache: false }), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'web_material_change',
      webProbe: current,
      webAssessment: material,
    });
    expect(h.persistProbeCache).not.toHaveBeenCalled();
  });

  it('atomically writes a successful sanitized assessment when persistence is enabled', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const material = assessment('material', current);
    const h = harness({
      snapshot: state({ committedWebProbe: committed }),
      currentProbe: current,
      webAssessment: material,
    });

    await admitTopicRefresh(input({ persistProbeCache: true }), h.deps);

    expect(h.persistProbeCache).toHaveBeenCalledOnce();
    expect(h.persistProbeCache).toHaveBeenCalledWith(current, material);
  });

  it('does not overwrite an older cached material verdict when assessment fails', async () => {
    const committed = probe('https://example.com/old');
    const cachedProbe = probe('https://example.com/cached');
    const current = probe('https://example.com/current');
    const cachedMaterial = assessment('material', cachedProbe);
    const h = harness({
      snapshot: state({
        committedWebProbe: committed,
        lastProbe: { probe: cachedProbe, assessment: cachedMaterial },
      }),
      currentProbe: current,
    });
    h.assessWeb.mockRejectedValueOnce(new Error('provider failed'));

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: false,
      trigger: 'not_due',
      warnings: ['assessment_failed'],
    });
    expect(h.persistProbeCache).not.toHaveBeenCalled();
  });

  it('preserves the admission result and records a closed warning when cache persistence fails', async () => {
    const committed = probe('https://example.com/old');
    const current = probe('https://example.com/current');
    const h = harness({
      snapshot: state({ committedWebProbe: committed }),
      currentProbe: current,
      webAssessment: assessment('material', current),
    });
    h.persistProbeCache.mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(admitTopicRefresh(input(), h.deps)).resolves.toMatchObject({
      admit: true,
      trigger: 'web_material_change',
      warnings: ['refresh_state_persist_failed'],
    });
  });
});
