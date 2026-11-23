import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type OpenAI from 'openai';
import { defaultsFor, type VaultSettings } from '@vault/settings-registry';
import { runMigrations } from '../src/db/migrate.js';
import { registerWikiRoot } from '../src/db/wiki-roots.js';
import { BackgroundBuilds } from '../src/background-builds.js';
import { DailyBudget, RUN_BUDGET_PURPOSES, dailyBudgetPolicy, withDailyBudget, type BudgetGate } from '../src/budget.js';
import { USAGE_PURPOSES } from '@vault/contract';
import { CurationQueue } from '../src/queue.js';
import { EngineError, type Engine, type WikiReconcileInput } from '../src/engine.js';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import type { Config } from '../src/config.js';
import type { CoreDeps } from '../src/core.js';
import type { PrepareRequest, SourceObservation, StageRequest } from '../src/provenance-types.js';
import type { ExistingWiki, Memory, ProjectEvidence } from '../src/types.js';
import { buildDossierRequest, builtInDossierShape, dossierSchema, dossierSystemPrompt, parseDossierLines } from '../src/prompts/dossier.js';
import { BUILT_IN_DOSSIER_SECTIONS, builtInDossierSections, dossierSectionsFor, parseDossierSections } from '../src/dossier/sections.js';
import { DOSSIER_LIMITS, DossierError, bodyReadOrder, lastContactOf, readDossierBodies, readDossierMemories, renderDossierEvidence, resolveDossierSubject, sourcesPhrase, type DossierRef, type DossierSubject } from '../src/dossier/evidence.js';
import { dayInSameEntry, noContactLine, noteEntries, renderDossierPage } from '../src/dossier/page.js';
import { DOSSIER_ASSEMBLY, DOSSIER_TRANSFORM, ESTIMATED_OUTPUT_TOKENS, dossierBuildKey, estimateNote, recentAnswer, recoverDossierBuilds, startDossier } from '../src/dossier/build.js';
import { makeBuildDossierHandler, BUILD_DOSSIER_DESCRIPTION } from '../src/tools/build-dossier.js';
import { buildDossierRuleCheckRequest, checkDossierRules } from '../src/dossier/rules.js';
import { makeRemoveDossierHandler } from '../src/tools/remove-dossier.js';
import { getDossier } from '../src/db/dossiers.js';
import { leftDossierBuilds, queueDossierBuild } from '../src/db/dossier-builds.js';
import { memoryDay } from '../src/wiki-memories.js';

// Fictional people and companies only (repository rule): Dana Whitfield, Lee Okafor, Northwind, Avery Stone.

const observation = (kind: 'node' | 'memory', id: string): SourceObservation => ({ source: { namespace: 'vault', kind, native_id: id },
  authority: 'engine', observed_at: '2026-11-20T12:00:00Z', native_version: 1, content_hash: 'hash',
  hash_semantics: kind === 'node' ? 'engine_content_hash' : 'selected_projection_v1',
  observation_projection: kind === 'node' ? 'node-token-v2' : 'memory-content-v1',
  observation_digest: 'sha256:json-v1:' + 'a'.repeat(64), label: id, path: null });

const LIMITS = { componentBytes: 262144, itemCount: 512, requestBytes: 1048576, totalBytes: 2097152 };

function memory(id: number, content: string, extra: Partial<Memory> = {}): Memory {
  return { id, source: 'curator', scope: 'vault', node_id: null, content, category: null, created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:00:00.000Z', valid_at: '2026-03-04T00:00:00.000Z', evidence_kind: 'note', evidence_node_id: 'kickoff',
    provenance_observation: observation('memory', String(id)), ...extra };
}

function evidenceFor(subjectId: string, overrides: Omit<Partial<ProjectEvidence>, 'existing_wiki'> & { existing_wiki?: Partial<ExistingWiki> } = {}) {
  const ids = [subjectId, 'kickoff', 'planning', 'q3', 'task-1', 'lee', 'avery', 'northwind'];
  return {
    project: { id: subjectId, title: 'Dana Whitfield', file_path: 'People/Dana Whitfield.md', status: null },
    tasks: { open: [{ id: 'task-1', title: 'Send the proposal', status: 'open', due: '2026-11-30' }] },
    notes: [{ id: 'kickoff', title: 'Kickoff call' }, { id: 'q3', title: 'Q3 planning' }],
    signals: { overdue_count: 0, blocked_count: 0, churn_rate: 0 },
    synthesis_hints: { suggested_reads: [], overdue_task_ids: [], recently_done_ids: [] },
    meetings: {
      recent: [{ id: 'kickoff', title: 'Kickoff call', date: '2026-03-04', file_mtime: null, attendees: ['Dana Whitfield', 'Lee Okafor', 'Avery Stone'] }],
      upcoming: [{ id: 'planning', title: 'Planning call', date: '2026-12-02', file_mtime: null, attendees: ['Dana Whitfield'] }],
    },
    contacts: {
      people: [
        { id: subjectId, title: 'Dana Whitfield', companies: ['Northwind'], direct: false, meeting_count: 2, last_seen: null },
        { id: 'lee', title: 'Lee Okafor', companies: ['Northwind'], direct: false, meeting_count: 1, last_seen: null },
        { id: 'avery', title: 'Avery Stone', companies: [], direct: false, meeting_count: 1, last_seen: null },
      ],
      companies: [{ id: 'northwind', title: 'Northwind' }],
      unlinked: [{ name: 'Sam Patel', direct: false, meeting_count: 1 }],
    },
    evidence_hash: 'evidence-1', generated_at: '2026-11-20T12:00:00.000Z',
    provenance_observations: { nodes: Object.fromEntries(ids.map(id => [id, observation('node', id)])), truncated: false, aggregate_coverage: 'opaque' as const },
    ...overrides,
    existing_wiki: { home_id: null, home: null, topology_hash: 'topology', catalog_valid: true, subpages: [], ...overrides.existing_wiki },
  } as ProjectEvidence & { existing_wiki: ExistingWiki };
}

const subjectNode = (id = 'dana', types = ['person'], title = 'Dana Whitfield') => ({ id, title, types, fields: { company: { value: '[[Northwind]]' } },
  body: 'Account lead at Northwind.', file_path: `People/${title}.md`, provenance_observation: observation('node', id) });

type Fixture = ReturnType<typeof setup>;

function setup(options: {
  types?: string[]; title?: string; vault?: Partial<VaultSettings>; evidence?: ReturnType<typeof evidenceFor>;
  memories?: { owner?: Memory[]; rules?: Memory[]; preferences?: Memory[]; newest?: Memory[]; past?: Memory[]; replacements?: Memory[]; total?: number };
  output?: unknown; budget?: BudgetGate; dailyBudgetCents?: number | null; spentUsd?: number; builds?: boolean;
  reconcile?: (input: WikiReconcileInput) => unknown; peopleAt?: string[]; widerEvidence?: ReturnType<typeof evidenceFor>;
  recentCalls?: { events: number; output_tokens: number };
  /** The rule check's answer (#721); no line broken by default. An Error makes the call fail. */
  ruleCheck?: unknown;
  /** The page call never answers (a process stopped mid-call, #722). */
  hang?: boolean;
  /** Called as each model call goes out, with what it is. */
  onCall?: (what: 'page' | 'check') => void;
  /** A note's wiki home, as wiki-status reads it, and a home's title (#723). */
  homeOf?: Record<string, string>;
  homeTitles?: Record<string, string>;
  /** The dossierSections setting as written (#716). */
  dossierSections?: string;
  /** The dossierBodyReads setting. */
  bodyReads?: number;
} = {}) {
  const db = new Database(':memory:'); runMigrations(db);
  const node = subjectNode('dana', options.types ?? ['person'], options.title ?? 'Dana Whitfield');
  const memories = options.memories ?? {
    rules: [memory(3, 'Never share Northwind pricing with Dana Whitfield.', { category: 'rule' })],
    preferences: [memory(2, 'Dana Whitfield prefers short agendas.', { category: 'preference', evidence_kind: 'conversation', evidence_node_id: null,
      valid_at: '2026-05-02T09:00:00.000Z' })],
    newest: [memory(1, 'Dana Whitfield leads the Northwind account.')],
    owner: [memory(9, 'Write amounts in euros.', { source: 'owner', evidence_kind: 'note' })],
    total: 3,
  };
  const prepares: PrepareRequest[] = [];
  const stages: StageRequest[] = [];
  const reconciles: WikiReconcileInput[] = [];
  const transitions: Array<{ action: string }> = [];
  const listed: Array<Record<string, unknown>> = [];
  const engine = {
    getNode: vi.fn(async (id: string) => {
      if (id === 'missing') throw new EngineError('NOT_FOUND', 'no such node');
      if (id.startsWith('home')) return { ...subjectNode(id, ['wiki'], options.homeTitles?.[id] ?? 'Dana Whitfield Dossier'), file_path: `Wikis/${options.homeTitles?.[id] ?? 'Dana Whitfield Dossier'}.md` };
      return id === 'dana' ? node : { ...subjectNode(id, ['note'], id) };
    }),
    deleteNode: vi.fn(async () => ({ operationId: 'op-delete' })),
    wikiStatus: vi.fn(async (root: string) => ({ root_id: root, home_node_id: options.homeOf?.[root] ?? null, status: null, version: null, written: false })),
    findNodesByExactTitle: vi.fn(async (title: string) => title === 'Twice' ? [{ id: 'a' }, { id: 'b' }]
      : title === 'Dana Whitfield' ? [{ id: 'dana' }] : []),
    inspectProvenance: vi.fn(async (request: { select: string }) => request.select === 'status'
      ? { select: 'status', capability_version: 1, vault_namespace: 'vault', limits: LIMITS, actual_bytes: 0, reserved_bytes: 0, purge_restore_verification: 'unverified' }
      : { select: 'attempt', attempt: { state: 'prepared', availability: 'retained', derivation_id: 'derivation-1' } }),
    projectEvidence: vi.fn(async (_id: string, limit?: number) => limit === 100 && options.widerEvidence
      ? options.widerEvidence : options.evidence ?? evidenceFor('dana')),
    listMemoriesWithTotal: vi.fn(async (filters: Record<string, unknown>) => {
      listed.push(filters);
      if (filters.source === 'owner') return { memories: memories.owner ?? [], total: (memories.owner ?? []).length };
      if (filters.expire_reasons) return { memories: memories.past ?? [], total: (memories.past ?? []).length };
      if (filters.ids && filters.include_superseded) {
        const found = (memories.replacements ?? []).filter(m => (filters.ids as number[]).includes(m.id));
        return { memories: found, total: found.length };
      }
      if (filters.category === 'rule') return { memories: memories.rules ?? [], total: (memories.rules ?? []).length };
      if (filters.category === 'preference') return { memories: memories.preferences ?? [], total: (memories.preferences ?? []).length };
      return { memories: memories.newest ?? [], total: memories.total ?? null };
    }),
    listNotesById: vi.fn(async (ids: readonly string[]) => ids.map(id => ({ id, title: `Note ${id}`, file_path: `${id}.md` }))),
    listPeopleAt: vi.fn(async () => ({ titles: options.peopleAt ?? [], truncated: false })),
    updateNodeFields: vi.fn(async (_id: string, fields: Record<string, unknown>) => { Object.assign(node.fields, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }]))); }),
    readNodeField: vi.fn(async (_id: string, field: string) => (node.fields as Record<string, { value?: unknown } | undefined>)[field]?.value),
    usageReport: vi.fn(async () => ({ data: { groups: [], totals: options.recentCalls ?? { events: 0, output_tokens: 0 } }, warnings: [] })),
    prepareProvenance: vi.fn(async (request: PrepareRequest) => {
      prepares.push(request);
      if (request.dry_run) return { dry_run: true, bundle_digest: 'sha256:json-v1:' + 'b'.repeat(64), payload_bytes: 1234, reserved_bytes: 2048, item_count: request.bundle.items.length };
      return { derivation_id: 'derivation-1', bundle_digest: 'sha256:json-v1:' + 'b'.repeat(64), state: 'prepared', availability: 'retained', lease_expires_at: '2099-01-01T00:00:00Z' };
    }),
    transitionProvenance: vi.fn(async (request: { action: string }) => { transitions.push(request); return {}; }),
    stageProvenanceResult: vi.fn(async (request: StageRequest) => {
      stages.push(request);
      return { derivation_id: request.derivation_id, bundle_digest: request.bundle_digest, contribution_digest: 'contribution' };
    }),
    wikiReconcile: vi.fn(async (input: WikiReconcileInput) => {
      reconciles.push(input);
      const custom = options.reconcile?.(input);
      if (custom) return custom;
      const exists = (options.evidence ?? evidenceFor('dana')).existing_wiki.home_id;
      return { data: { home: { node_id: exists ?? (input.dry_run ? null : 'home-1'), title: 'Dana Whitfield Dossier',
        file_path: 'Wikis/Dana Whitfield Dossier.md', version: 1, created: exists === null },
        created: [], updated: [], mappings: [], warnings: [], operation_id: 'op', reconcile_key: input.reconcile_key, plan_digest: 'p', reused: false, dry_run: input.dry_run,
        topology_hash: 't', preview: { total: 0, items: [], truncated: false },
        ...(input.dry_run ? {} : { provenance_receipt: { derivation_id: 'derivation-1', output_revision_id: 'output-1', output_node_id: exists ?? 'home-1',
          committed_node_version: 2, committed_at: '2026-11-20T12:00:00Z', operation_id: 'op', reconcile_key: input.reconcile_key, request_digest: 'd' } }) },
        warnings: [] };
    }),
  };
  let calls = 0;
  const requests: unknown[] = [];
  const adapter = new OpenAiCompatLlmClient({ chat: { completions: { create: async (payload: unknown) => {
    calls++;
    requests.push(payload);
    const isCheck = JSON.stringify(payload).includes('emit_dossier_rule_check');
    options.onCall?.(isCheck ? 'check' : 'page');
    if (!isCheck && options.hang) return new Promise(() => {});
    if (isCheck) {
      if (options.ruleCheck instanceof Error) throw options.ruleCheck;
      return { choices: [{ message: { content: JSON.stringify(options.ruleCheck ?? { broken: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } };
    }
    const output = options.output ?? { lines: [
      { section: 'Who', text: 'Leads the Northwind account.', memory_ids: [1] },
      { section: 'Preferences', text: 'Prefers short agendas.', memory_ids: ['m2'] },
      { section: 'History', text: 'Met at the kickoff.', note_ids: ['n2'] },
      { section: 'Who', text: 'Cites nothing known.', memory_ids: [404] },
    ] };
    return { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } };
  } } } } as unknown as OpenAI, { provider: 'openrouter', fireworksExtensions: false });
  const config = {
    wikiPlanningMaxTokens: 0, wikiPageMaxTokens: 0, wikiHomeMaxTokens: 0, wikiPlanningReasoningEffort: 'inherit',
    wikiPageReasoningEffort: 'inherit', wikiHomeReasoningEffort: 'inherit', model: 'synthetic', wikiHomeModel: 'home-model',
    modelProviders: { synthetic: 'openrouter', 'home-model': 'openrouter' }, homeMaxTokens: 4000, meetingReads: 5, bodyCharCap: null,
    curatorTz: 'UTC', dailyBudgetCents: options.dailyBudgetCents === undefined ? 100 : options.dailyBudgetCents,
    modelPricing: { 'home-model': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    vault: { ...(defaultsFor('vault') as unknown as VaultSettings), ownerNote: 'Avery Stone', ...options.vault },
    ...(options.dossierSections !== undefined ? { dossierSections: options.dossierSections } : {}),
    ...(options.bodyReads !== undefined ? { dossierBodyReads: options.bodyReads } : {}),
  } as unknown as Config;
  const policy = dailyBudgetPolicy(config);
  const daily = new DailyBudget(async () => options.spentUsd ?? 0);
  const llm = withDailyBudget(adapter, daily, policy);
  const keepAlive: Array<Promise<unknown>> = [];
  const builds = options.builds ? new BackgroundBuilds(work => { keepAlive.push(work); }) : undefined;
  const deps = { engine: engine as unknown as Engine, llm, config, queue: new CurationQueue(), db,
    ...(options.budget ? { budget: options.budget } : {}), ...(builds ? { builds } : {}) } as CoreDeps;
  const handler = makeBuildDossierHandler(deps);
  const call = async (args: Record<string, unknown>) => {
    const result = await handler({ dry_run: true, ...args } as never, { authInfo: { scopes: ['curate:trigger'] } });
    return JSON.parse(result.content[0]!.text) as Record<string, any>;
  };
  return { db, engine, deps, call, prepares, stages, reconciles, transitions, listed, calls: () => calls, requests, keepAlive, builds };
}

const day = memoryDay('UTC');
const PERSON_SECTIONS = builtInDossierSections('person').map(section => section.name);

function refs(): Map<string, DossierRef> {
  return new Map([
    ['n1', { ref: 'n1', id: 'dana', title: 'Dana Whitfield', date: null, what: 'subject' }],
    ['n2', { ref: 'n2', id: 'kickoff', title: 'Kickoff call', date: '2026-03-04', what: 'meeting' }],
  ]);
}

describe('dossier prompt and schema (#554)', () => {
  it('offers each kind its own sections and asks for cited lines', () => {
    const person = JSON.stringify(dossierSchema(builtInDossierSections('person')));
    expect(person).toContain('"Who"');
    expect(person).not.toContain('"What it is"');
    expect(JSON.stringify(dossierSchema(builtInDossierSections('company')))).toContain('"Preferences & terms"');
    expect(dossierSystemPrompt(builtInDossierShape('person'), 'Avery Stone')).toContain('The vault owner, Avery Stone, reads this page');
    expect(dossierSystemPrompt(builtInDossierShape('company'), null)).toContain('- What it is:');
  });

  it('sends the evidence the way the Engine\'s home capture decodes it', () => {
    const request = buildDossierRequest({ shape: builtInDossierShape('person'), owner: null, evidence: 'E', model: 'm', maxTokens: 100, generatedAt: new Date('2026-11-20T12:00:00Z'), timeZone: 'UTC' });
    expect(JSON.parse(request.user)).toEqual({ evidence: 'E', accepted_page_index: [] });
    expect(request.system).toContain('Today is Friday, 2026-11-20 (UTC).');
  });

  it('reads the model\'s lines leniently', () => {
    expect(parseDossierLines({})).toBeNull();
    expect(parseDossierLines({ lines: [{ section: ' Who ', text: 'x', memory_ids: ['m12', 7, 'nope', -1], note_ids: 'N3' }, 'junk'] }))
      .toEqual([{ section: 'Who', text: 'x', memory_ids: [12, 7], note_ids: ['n3'] }]);
  });

  it('keeps a day only when it is a real calendar day written YYYY-MM-DD, and asks for one only from a note', () => {
    const days = (day: unknown) => parseDossierLines({ lines: [{ section: 'History', text: 'x', note_ids: ['n1'], day }] })![0]!;
    expect(days(' 2026-11-04 ')).toMatchObject({ day: '2026-11-04' });
    for (const bad of ['2026-02-30', '11/4', '2026-11-4', 'yesterday', 20261104, null]) expect(days(bad)).not.toHaveProperty('day');
    expect(dossierSystemPrompt(builtInDossierShape('person'), null)).toContain('writes out the day of the fact as YYYY-MM-DD');
    // Open items hold only what is still open (owner, 2026-11-21, after a side agent's point).
    for (const kind of ['person', 'company'] as const) {
      expect(dossierSystemPrompt(builtInDossierShape(kind), null)).toContain('An item whose day has passed (a deadline gone by, a meeting already held, a request from weeks ago) is History');
    }
    expect(JSON.stringify(dossierSchema(builtInDossierSections('person')))).toContain('"day"');
  });
});

describe('dossier page lines (#554)', () => {
  const memories = new Map<number, Memory>([
    [1, memory(1, 'Leads the account.')],
    [2, memory(2, 'Prefers mornings.', { evidence_kind: 'conversation', evidence_node_id: null, valid_at: '2026-05-02T09:00:00.000Z' })],
    [4, memory(4, 'Signed in June.', { valid_at: '2026-06-10T00:00:00.000Z', evidence_kind: 'curation-run', evidence_node_id: null })],
    [5, memory(5, 'Renewed in September.', { valid_at: '2026-09-01T00:00:00.000Z', evidence_node_id: 'unknown-note' })],
    [9, memory(9, 'Write amounts in euros.', { source: 'owner' })],
  ]);
  const titles = new Map([['kickoff', 'Kickoff call']]);
  const render = (lines: Parameters<typeof renderDossierPage>[0]['lines'], extra: Partial<Parameters<typeof renderDossierPage>[0]> = {}) =>
    renderDossierPage({ kind: 'person', sections: PERSON_SECTIONS, lines, memories, refs: refs(), sourceTitles: titles, rules: [], lastContact: null, header: '_Header._', day,
      today: '2026-11-21', ...extra });

  it('writes the day and source of each line and its memory marker', () => {
    const page = render([
      { section: 'Who', text: 'Leads the Northwind account.', memory_ids: [1], note_ids: [] },
      { section: 'preferences', text: '- Prefers mornings, at $40 an hour.', memory_ids: [2], note_ids: [] },
      { section: 'Relationships', text: 'Works with you.', memory_ids: [9, 1], note_ids: ['n2'] },
    ]);
    expect(page.content).toContain('- Leads the Northwind account. · since 2026-03-04 · [[Kickoff call]] <!-- memory:1 -->');
    expect(page.content).toContain('- Prefers mornings, at \\$40 an hour. · since 2026-05-02 · from a chat <!-- memory:2 -->');
    expect(page.content).toContain('- Works with you. · since 2026-03-04 · from you, [[Kickoff call]] <!-- memory:1 --> <!-- memory:9 -->');
    expect(page.content).toContain(`## Last contact\n\n${noContactLine('person')}`);
    expect(page.content.startsWith('_Header._\n\n## Who')).toBe(true);
    expect(page).toMatchObject({ kept: 3, dropped: 0, undated: 0 });
  });

  it('drops a line citing nothing known, with no text, or in no section of its kind, and counts them', () => {
    const page = render([
      { section: 'Who', text: 'Unknown ids.', memory_ids: [404], note_ids: ['n99'] },
      { section: 'Who', text: '   ', memory_ids: [1], note_ids: [] },
      { section: 'What it is', text: 'A company section.', memory_ids: [1], note_ids: [] },
      { section: 'Who', text: 'Partly known.', memory_ids: [404, 1], note_ids: [] },
    ]);
    expect(page).toMatchObject({ kept: 1, dropped: 3 });
    expect(page.content).toContain('- Partly known. · since 2026-03-04 · [[Kickoff call]] <!-- memory:1 -->');
    expect(page.content).not.toContain('Unknown ids');
  });

  it('lists History newest first by the bare day, a meeting-only line by its meeting\'s day', () => {
    const page = render([
      { section: 'History', text: 'Signed.', memory_ids: [4], note_ids: [] },
      { section: 'History', text: 'Met at the kickoff.', memory_ids: [], note_ids: ['n2'] },
      { section: 'History', text: 'Renewed.', memory_ids: [5], note_ids: [] },
    ]);
    const history = page.content.split('## History\n\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(history).toEqual([
      '- Renewed. · 2026-09-01 · from a note <!-- memory:5 -->',
      '- Signed. · 2026-06-10 · from a wiki build <!-- memory:4 -->',
      '- Met at the kickoff. · 2026-03-04 · [[Kickoff call]]',
    ]);
  });

  describe('a day the model read in a note (owner: "same entry only", 2026-11-21)', () => {
    const NOTE = [
      '## Background',
      '- Runs procurement at Northwind; joined from a logistics firm.',
      '',
      '## Timeline',
      '- **2026-02-10:** first call with [[Lee Okafor]] about the warehouse pilot.',
      '- **2026-03-04, [[Kickoff call]]:**',
      '  - Agreed the pilot scope with [[Lee Okafor]] and you.',
      '  - Asked for weekly status reports by email.',
      '- **2026-04-15:** renewal budget approved by the finance committee, with [[Lee Okafor]] copied.',
      '- **2026-12-01:** planned site visit at the Rotterdam warehouse.',
      '',
      'Working pattern: prefers mornings; replies within a day ([[2026-01-20 Weekly Summary]]).',
    ].join('\n');
    const withNote = (): Map<string, DossierRef> => new Map([
      ['n1', { ref: 'n1', id: 'dana', title: 'Dana Whitfield', date: null, what: 'subject', text: NOTE }],
      ['n2', { ref: 'n2', id: 'kickoff', title: 'Kickoff call', date: '2026-03-04', what: 'meeting' }],
      ['n3', { ref: 'n3', id: 'weekly', title: '2026-01-20 Weekly Summary', date: null, what: 'note' }],
    ]);
    const line = (section: string, text: string, day: string, note_ids = ['n1']) => ({ section, text, memory_ids: [], note_ids, day });

    it('splits a note into entries: a top-level item with what is indented under it, a paragraph, a heading', () => {
      const entries = noteEntries(NOTE);
      expect(entries).toContain('- **2026-03-04, [[Kickoff call]]:**\n  - Agreed the pilot scope with [[Lee Okafor]] and you.\n  - Asked for weekly status reports by email.');
      expect(entries).toContain('## Timeline');
      expect(entries.at(-1)).toMatch(/^Working pattern/);
    });

    it('keeps a loose list item whole across the blank lines inside it (Codex, #713)', () => {
      const loose = '- **2026-05-06:**\n\n  Signed the warehouse lease.\n\n  - Two-year term.\n\nA paragraph.\n\n    indented code';
      expect(noteEntries(loose)).toEqual(['- **2026-05-06:**\n\n  Signed the warehouse lease.\n\n  - Two-year term.', 'A paragraph.', '    indented code']);
      expect(dayInSameEntry(loose, '2026-05-06', 'Signed the warehouse lease for two years.')).toBe(true);
    });

    it('keeps sibling items apart however far the list is indented, and nests only what is deeper (Codex, #713)', () => {
      const indented = '  - **2026-03-04:** Signed the warehouse lease.\n  - **2026-05-06:** Approved the renewal budget.';
      expect(noteEntries(indented)).toHaveLength(2);
      expect(dayInSameEntry(indented, '2026-03-04', 'Approved the renewal budget.')).toBe(false);
      expect(dayInSameEntry(indented, '2026-05-06', 'Approved the renewal budget.')).toBe(true);
      expect(noteEntries('  - A\n      - a1\n  - B\n- C')).toEqual(['  - A\n      - a1', '  - B', '- C']);
    });

    it('keeps a day from the entry the fact came from, and not one from another entry of the same note', () => {
      const ignore = new Set(['dana', 'whitfield']);
      expect(dayInSameEntry(NOTE, '2026-03-04', 'Asked for weekly status reports by email.', ignore)).toBe(true);
      expect(dayInSameEntry(NOTE, '2026-02-10', 'Asked for weekly status reports by email.', ignore)).toBe(false);
      // Names on many entries tell little: the renewal entry wins on its own words, not on Lee Okafor.
      expect(dayInSameEntry(NOTE, '2026-04-15', 'The finance committee approved the renewal budget, with [[Lee Okafor]] copied.', ignore)).toBe(true);
      expect(dayInSameEntry(NOTE, '2026-02-10', 'The finance committee approved the renewal budget, with [[Lee Okafor]] copied.', ignore)).toBe(false);
      expect(dayInSameEntry(NOTE, '2026-04-16', 'The finance committee approved the renewal budget.', ignore)).toBe(false);
      expect(dayInSameEntry(NOTE, '2026-03-04', 'Runs procurement at Northwind.', ignore)).toBe(false);
      expect(dayInSameEntry(NOTE, '2026-03-04', 'He is.', ignore)).toBe(false);
    });

    it('shows a confirmed day as a memory\'s would be shown, sorts History by it, and counts the lines left without one', () => {
      const page = render([
        line('Preferences', 'Asked for weekly status reports by email.', '2026-03-04'),
        line('History', 'First call with [[Lee Okafor]] about the warehouse pilot.', '2026-02-10'),
        line('History', 'The finance committee approved the renewal budget.', '2026-04-15'),
        line('History', 'Agreed the pilot scope with [[Lee Okafor]].', '2026-04-15'),
        line('History', 'Planned a site visit at the Rotterdam warehouse.', '2026-12-01'),
        line('Who', 'Runs procurement at Northwind.', '2026-01-01'),
        line('Preferences', 'Prefers mornings and replies within a day.', '2026-01-20', ['n3']),
      ], { refs: withNote() });
      expect(page.content).toContain('- Asked for weekly status reports by email. · since 2026-03-04 · [[Dana Whitfield]]');
      expect(page.content).toContain('- Prefers mornings and replies within a day. · since 2026-01-20 · [[2026-01-20 Weekly Summary]]');
      expect(page.content).toContain('- Runs procurement at Northwind. · [[Dana Whitfield]]');
      const history = page.content.split('## History\n\n')[1]!.split('\n\n')[0]!.split('\n');
      expect(history).toEqual([
        '- The finance committee approved the renewal budget. · 2026-04-15 · [[Dana Whitfield]]',
        '- First call with [[Lee Okafor]] about the warehouse pilot. · 2026-02-10 · [[Dana Whitfield]]',
        // A day from another entry, and a day after the build, are dropped; the line stays, undated.
        '- Agreed the pilot scope with [[Lee Okafor]]. · [[Dana Whitfield]]',
        '- Planned a site visit at the Rotterdam warehouse. · [[Dana Whitfield]]',
      ]);
      expect(page).toMatchObject({ kept: 7, dropped: 0, undated: 3 });
    });

    it('lets a memory\'s day, then a meeting\'s, win over one the model read', () => {
      const page = render([
        { section: 'Who', text: 'Leads the account.', memory_ids: [5], note_ids: ['n1'], day: '2026-03-04' },
        line('History', 'Agreed the pilot scope with [[Lee Okafor]] and you.', '2026-02-10', ['n1', 'n2']),
      ], { refs: withNote() });
      expect(page.content).toContain('- Leads the account. · since 2026-09-01 · from a note, [[Dana Whitfield]] <!-- memory:5 -->');
      expect(page.content).toContain('- Agreed the pilot scope with [[Lee Okafor]] and you. · 2026-03-04 · [[Dana Whitfield]], [[Kickoff call]]');
    });
  });

  it('lists the rules under their fixed heading and gives the last contact', () => {
    const page = render([{ section: 'Who', text: 'Leads.', memory_ids: [1], note_ids: [] }], {
      rules: [memory(3, 'Never share pricing.', { category: 'rule' })], lastContact: { title: 'Kickoff call', date: '2026-03-04' } });
    expect(page.content).toMatch(/## Last contact\n\n- \[\[Kickoff call\]\] · 2026-03-04\n\n## Rules on what to say\n\n- Never share pricing\. <!-- memory:3 -->$/);
  });
});

describe('dossier evidence (#554)', () => {
  const subject: DossierSubject = { id: 'dana', title: 'Dana Whitfield', kind: 'person', types: ['person'], node: subjectNode() as never };

  it('reads rules and preferences first, then the newest, and counts what the limits left out', async () => {
    const f = setup({ memories: { rules: [memory(3, 'Rule.', { category: 'rule' })], preferences: [memory(2, 'Pref.', { category: 'preference' })],
      newest: [memory(1, 'Fact.'), memory(2, 'Pref.', { category: 'preference' }), memory(3, 'Rule.', { category: 'rule' })],
      owner: [memory(9, 'Own.', { source: 'owner' }), memory(1, 'Fact.')], total: 1214 } });
    const read = await readDossierMemories(f.deps.engine, 'dana');
    expect(read.rules.map(m => m.id)).toEqual([3]);
    expect(read.facts.map(m => m.id).sort()).toEqual([1, 2]);
    // An owner memory that is about the subject is one of its facts, not a standing note.
    expect(read.owner.map(m => m.id)).toEqual([9]);
    expect(read).toMatchObject({ total: 1214, omitted: 1211 });
    expect(f.listed.filter(l => l.subject_of === 'dana').map(l => [l.category ?? (l.expire_reasons ? 'past' : null), l.limit])).toEqual([['rule', 20], ['preference', 20], [null, 60], ['past', 10]]);
    expect(f.listed.every(l => l.includeProvenance === true)).toBe(true);
    expect(sourcesPhrase(read, { notes: 2, meetings: 1 })).toBe('3 of 1,214 memories (the 60 newest, with the rules and preferences), 2 notes and 1 meeting');
  });

  it('shows each line with the ref the model cites, and records each with what it was read from', () => {
    const memories = { owner: [memory(9, 'Own.', { source: 'owner' })], rules: [memory(3, 'Never share pricing.', { category: 'rule' })],
      facts: [memory(1, 'Leads the Northwind account.')], past: [], replacedBy: new Map(), total: 70, omitted: 66 };
    const rendered = renderDossierEvidence({ subject, evidence: evidenceFor('dana'), memories, owner: 'Avery Stone',
      sourceTitles: new Map([['kickoff', 'Kickoff call']]), meetingReads: 5, timeZone: 'UTC' });
    expect(rendered.text).toContain('VAULT OWNER (never the subject; call them "you"): Avery Stone');
    expect(rendered.text).toContain('- [m1] 2026-03-04, from "Kickoff call": Leads the Northwind account.');
    expect(rendered.text).toContain('- [m3] Never share pricing.');
    expect(rendered.text).toContain('- [n2] upcoming 2026-12-02 · Planning call');
    expect(rendered.text).toContain('- [n3] 2026-03-04 · Kickoff call · with Lee Okafor, Avery Stone');
    expect(rendered.text).toContain('- [n4] Q3 planning');
    expect(rendered.text).toContain('- [n5] Send the proposal (open; due 2026-11-30; status open)');
    expect(rendered.text).toContain('- Lee Okafor (Northwind; 1 meeting)');
    expect(rendered.text).not.toMatch(/^- Avery Stone/m);
    expect(rendered.text).not.toMatch(/^- Dana Whitfield \(/m);
    expect(rendered.text).toContain('- Sam Patel (1 meeting)');
    expect([...rendered.refs.values()].map(r => [r.ref, r.id, r.what])).toEqual([
      ['n1', 'dana', 'subject'], ['n2', 'planning', 'meeting'], ['n3', 'kickoff', 'meeting'], ['n4', 'q3', 'note'], ['n5', 'task-1', 'task']]);
    const memoryInputs = rendered.collector.items.filter(item => item.observation?.source.kind === 'memory').map(item => item.observation!.source.native_id);
    expect(memoryInputs.sort()).toEqual(['1', '3', '9']);
    const nodeInputs = new Set(rendered.collector.items.filter(item => item.observation?.source.kind === 'node').map(item => item.observation!.source.native_id));
    for (const id of ['dana', 'kickoff', 'planning', 'q3', 'task-1', 'lee', 'northwind']) expect(nodeInputs.has(id)).toBe(true);
    expect(nodeInputs.has('avery')).toBe(false);
    expect(rendered.collector.omissions).toContainEqual({ code: 'memory_limit', source: null });
  });
});

describe('dossier evidence reads the newest meetings and notes in full (#720)', () => {
  const subject: DossierSubject = { id: 'dana', title: 'Dana Whitfield', kind: 'person', types: ['person'], node: subjectNode() as never };
  const memories = { owner: [], rules: [], facts: [memory(1, 'Leads the Northwind account.')], past: [], replacedBy: new Map(), total: 1, omitted: 0 };
  const body = (id: string, text: string) => ({ id, title: id, types: ['meeting'], body: text, provenance_observation: observation('node', id) });

  it('reads past meetings and notes newest first: a meeting by its day, a note by its file time; no upcoming one, not the note itself', () => {
    const evidence = evidenceFor('dana', {
      notes: [{ id: 'dana', title: 'Dana Whitfield', file_mtime: Date.parse('2026-11-20') }, { id: 'q3', title: 'Q3 planning', file_mtime: Date.parse('2026-06-01') },
        { id: 'old', title: 'Old note', file_mtime: Date.parse('2026-01-01') }],
      meetings: { recent: [{ id: 'kickoff', title: 'Kickoff call', date: '2026-03-04', file_mtime: Date.parse('2026-11-19'), attendees: [] },
        { id: 'review', title: 'Review', date: '2026-07-10', file_mtime: null, attendees: [] }],
      upcoming: [{ id: 'planning', title: 'Planning call', date: '2026-12-02', file_mtime: null, attendees: [] }] },
    });
    expect(bodyReadOrder(evidence, 'dana')).toEqual(['review', 'q3', 'kickoff', 'old']);
  });

  it('reads at most eight, passes over a wiki page for the next, and lets an unreadable note take its place', async () => {
    const order = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const engine = { getNode: vi.fn(async (id: string) => {
      if (id === 'n1') throw new Error('gone');
      return { id, title: id, types: id === 'n2' ? ['wiki'] : ['note'], body: id };
    }) };
    const read = await readDossierBodies(engine as never, order, 'wiki');
    expect([...read.keys()]).toEqual(['n0', 'n1', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
    expect(read.get('n1')).toBeNull();
    expect(engine.getNode).toHaveBeenCalledTimes(9);
    expect(engine.getNode).toHaveBeenCalledWith('n0', { includeProvenance: true, includeEmbeds: false });
    expect(DOSSIER_LIMITS).toMatchObject({ readBodies: 8, readBodyChars: 4_000 });
  });

  it('shows each body under the ref its line has, records it as source material, cut at 4,000 characters', () => {
    const long = `Opening.\n${'word '.repeat(1_000)}`;
    const bodies = new Map<string, never>([
      ['kickoff', body('kickoff', '- Agreed to start the pilot on 2026-03-10.\n- Dana Whitfield asked for weekly reports.') as never],
      ['q3', body('q3', long) as never],
      ['gone', null as never],
    ]);
    const rendered = renderDossierEvidence({ subject, evidence: evidenceFor('dana'), memories, owner: 'Avery Stone',
      sourceTitles: new Map(), meetingReads: 5, timeZone: 'UTC', bodies });
    expect(rendered.text).toContain('## WHAT THE NEWEST MEETINGS AND NOTES SAY');
    expect(rendered.text).toContain('### [n3] 2026-03-04 · Kickoff call\n- Agreed to start the pilot on 2026-03-10.');
    expect(rendered.text).toContain('### [n4] Q3 planning\nOpening.');
    expect(rendered.text).toContain('…[truncated');
    expect(rendered.counts.bodies).toBe(2);
    const read = rendered.collector.items.filter(item => item.selection === 'dossier-body:v1');
    expect(read.map(item => [item.observation?.source.native_id, item.role, item.truncated])).toEqual([['kickoff', 'source_material', false], ['q3', 'source_material', true]]);
    expect(read[1]!.original_bytes).toBeGreaterThan(read[1]!.retained_bytes);
    expect(rendered.collector.omissions).toContainEqual({ code: 'source_body_unavailable', source: null });
    // A day the model reads in a body is checked against the entry it came from, as in the subject's own note.
    expect(rendered.refs.get('n4')!.text).toMatch(/^### \[n4\] Q3 planning\nOpening\./);
  });

  it('keeps a day a body states in the entry the line came from, and drops one it does not', () => {
    const shown = new Map(refs());
    shown.set('n3', { ref: 'n3', id: 'q3', title: 'Q3 planning', date: null, what: 'note',
      text: '### [n3] Q3 planning\n- **2026-06-01:** Northwind signed the pilot extension.\n- **2026-06-20:** Budget review moved to July.' });
    const page = renderDossierPage({ kind: 'person', sections: PERSON_SECTIONS, lines: [
      { section: 'History', text: 'Northwind signed the pilot extension.', memory_ids: [], note_ids: ['n3'], day: '2026-06-01' },
      { section: 'History', text: 'The budget review moved to July.', memory_ids: [], note_ids: ['n3'], day: '2026-06-01' },
    ], memories: new Map(), refs: shown, sourceTitles: new Map(), rules: [], lastContact: null, header: '_x_', day, today: '2026-11-21' });
    expect(page.content).toContain('- Northwind signed the pilot extension. · 2026-06-01 · [[Q3 planning]]');
    expect(page.content).toContain('- The budget review moved to July. · [[Q3 planning]]');
  });

  it('says how many it read in full in the dry run', async () => {
    const f = setup({ budget: { remainingUsd: async () => 0.9 } });
    const result = await f.call({ node_id: 'dana' });
    expect(result.reads).toMatchObject({ notes: 1, meetings: 2, read_in_full: 2 });
    expect(f.engine.getNode).toHaveBeenCalledWith('kickoff', { includeProvenance: true, includeEmbeds: false });
  });

  it('reads as many in full as dossierBodyReads says, none at 0', async () => {
    const none = setup({ bodyReads: 0, budget: { remainingUsd: async () => 0.9 } });
    expect((await none.call({ node_id: 'dana' })).reads).toMatchObject({ meetings: 2, read_in_full: 0 });
    expect(none.engine.getNode).not.toHaveBeenCalledWith('kickoff', expect.anything());
    const one = setup({ bodyReads: 1, budget: { remainingUsd: async () => 0.9 } });
    expect((await one.call({ node_id: 'dana' })).reads).toMatchObject({ read_in_full: 1 });
  });
});

describe('dossier last contact', () => {
  const meeting = (id: string, date: string, attendees: string[]) => ({ id, title: `Meeting ${id}`, date, file_mtime: null, attendees });
  const evidence = (recent: ReturnType<typeof meeting>[]) => evidenceFor('dana', { meetings: { recent, upcoming: [] } });

  it('is the newest past meeting the person attended, not one that only links to them', () => {
    const e = evidence([meeting('future', '2026-12-01', ['Dana Whitfield']), meeting('about', '2026-11-10', ['Lee Okafor']),
      meeting('with', '2026-11-02', ['dana whitfield', 'Lee Okafor'])]);
    expect(lastContactOf(e, '2026-11-21', { title: 'Dana Whitfield', kind: 'person' })).toEqual({ title: 'Meeting with', date: '2026-11-02' });
    expect(lastContactOf(evidence([meeting('about', '2026-11-10', ['Lee Okafor'])]), '2026-11-21', { title: 'Dana Whitfield', kind: 'person' })).toBeNull();
  });

  it('is, for a company, the newest past meeting someone placed at it attended', () => {
    // Lee Okafor is at Northwind (contacts); Avery Stone is not.
    const e = evidence([meeting('other-firm', '2026-11-12', ['Avery Stone']), meeting('client', '2026-11-05', ['Avery Stone', 'Lee Okafor'])]);
    expect(lastContactOf(e, '2026-11-21', { title: 'Northwind', kind: 'company' })).toEqual({ title: 'Meeting client', date: '2026-11-05' });
    expect(lastContactOf(evidence([meeting('other-firm', '2026-11-12', ['Avery Stone'])]), '2026-11-21', { title: 'Northwind', kind: 'company' })).toBeNull();
    expect(noContactLine('company')).toBe('- No past meeting attended by someone from it is on record.');
  });

  it('reads up to 100 meetings when the page\'s own show none attended and were cut off (Codex, #713)', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const mentions = ids.map((id, i) => meeting(id, `2026-11-1${i}`, ['Lee Okafor']));
    const capped = evidenceFor('dana', { meetings: { recent: mentions, upcoming: [] },
      provenance_observations: { nodes: Object.fromEntries(['dana', 'kickoff', 'planning', 'q3', 'task-1', 'lee', 'avery', 'northwind', ...ids]
        .map(id => [id, observation('node', id)])), truncated: false, aggregate_coverage: 'opaque' } });
    const attended = evidenceFor('dana', { meetings: { recent: [...mentions, meeting('m6', '2026-10-02', ['Dana Whitfield'])], upcoming: [] } });
    const f = setup({ evidence: capped, widerEvidence: attended });
    expect((await f.call({ node_id: 'dana' })).reads.last_contact).toEqual({ title: 'Meeting m6', date: '2026-10-02' });
    expect(f.engine.projectEvidence).toHaveBeenCalledWith('dana', 100);

    // Still none in a full 100: the page says how far it looked.
    const hundred = Array.from({ length: 100 }, (_, i) => meeting(`w${i}`, '2026-09-01', ['Lee Okafor']));
    const g = setup({ evidence: capped, widerEvidence: evidenceFor('dana', { meetings: { recent: hundred, upcoming: [] } }) });
    expect((await g.call({ node_id: 'dana' })).reads).toMatchObject({ last_contact: null, last_contact_searched: 100 });
    expect(noContactLine('person', 100)).toBe('- None of the 100 newest meetings that link to them lists them as attending.');
    // A list shorter than its limit was every linked meeting: nothing more is read.
    const h = setup({ evidence: evidenceFor('dana', { meetings: { recent: [], upcoming: [] } }) });
    expect((await h.call({ node_id: 'dana' })).reads).not.toHaveProperty('last_contact_searched');
    expect(h.engine.projectEvidence).not.toHaveBeenCalledWith('dana', 100);
  });

  it('counts, for a company, the people the vault places at it beyond the capped contact list (Codex, #713)', async () => {
    // Lee Okafor is in the contacts; Kim Novak is only in the vault's list of people at Northwind.
    const e = evidence([meeting('kickoff', '2026-11-18', ['Kim Novak']), meeting('planning', '2026-11-05', ['Lee Okafor'])]);
    expect(lastContactOf(e, '2026-11-21', { title: 'Northwind', kind: 'company' })).toEqual({ title: 'Meeting planning', date: '2026-11-05' });
    expect(lastContactOf(e, '2026-11-21', { title: 'Northwind', kind: 'company' }, ['Kim Novak'])).toEqual({ title: 'Meeting kickoff', date: '2026-11-18' });
    const f = setup({ types: ['company'], title: 'Northwind', evidence: e, peopleAt: ['Kim Novak'] });
    const result = await f.call({ node_id: 'dana' });
    expect(result.reads.last_contact).toEqual({ title: 'Meeting kickoff', date: '2026-11-18' });
    expect(f.engine.listPeopleAt).toHaveBeenCalledWith('dana', { personType: 'person', companyField: 'company' });
  });
});

describe('dossier refusals (#554)', () => {
  it('refuses a project, a wiki page, a note of another kind and the owner, before reading evidence', async () => {
    for (const [types, title, code] of [[['project'], 'Pilot', 'PROJECT_NOTE'], [['wiki'], 'Pilot Wiki', 'WIKI_PAGE'],
      [['meeting'], 'Kickoff call', 'NOT_AN_ENTITY'], [['person'], 'Avery Stone', 'VAULT_OWNER']] as const) {
      const f = setup({ types: [...types], title });
      const result = await f.call({ node_id: 'dana' });
      expect(result, `${title}`).toMatchObject({ ok: false, error: { code } });
      expect(f.engine.projectEvidence).not.toHaveBeenCalled();
      expect(f.calls()).toBe(0);
    }
  });

  it('refuses an ambiguous or unknown title, a missing note, and both identifiers', async () => {
    const f = setup();
    expect(await f.call({ title: 'Twice' })).toMatchObject({ error: { code: 'AMBIGUOUS_TITLE' } });
    expect(await f.call({ title: 'Nobody' })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await f.call({ node_id: 'missing' })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await f.call({ node_id: 'dana', title: 'Dana Whitfield' })).toMatchObject({ error: { code: 'INVALID_PARAMS' } });
  });

  it('takes the vault map\'s entity kinds, leaving projects out', async () => {
    const f = setup({ types: ['organization'], vault: { entityTypes: ['person', 'organization', 'project'] } });
    const subject = await resolveDossierSubject(f.deps, { node_id: 'dana' });
    expect(subject.kind).toBe('company');
    await expect(resolveDossierSubject(setup({ types: ['project'], vault: { entityTypes: ['project'] } }).deps, { node_id: 'dana' }))
      .rejects.toThrow(DossierError);
  });

  it('refuses a note that has a wiki of its own', async () => {
    const withPages = setup({ evidence: evidenceFor('dana', { existing_wiki: { subpages: [{ id: 'p' } as never] } }) });
    expect(await withPages.call({ node_id: 'dana' })).toMatchObject({ error: { code: 'HAS_WIKI' } });
    const registered = setup();
    registerWikiRoot(registered.db, { root_title: 'Dana Whitfield', root_node_id: 'dana', kind: 'topic', source: 'vault', cadence: null, brief: null,
      created_at: '2026-11-01T00:00:00Z', created_by: 'test' });
    expect(await registered.call({ node_id: 'dana' })).toMatchObject({ error: { code: 'HAS_WIKI' } });
  });

  it('names an older Engine clearly', async () => {
    const f = setup({ reconcile: () => { throw new EngineError('BAD_JSON', 'tool wiki-reconcile returned non-JSON: Unrecognized key: "title_suffix"'); } });
    expect(await f.call({ node_id: 'dana' })).toMatchObject({ error: { code: 'UPGRADE_REQUIRED' } });
  });

  it('names the owner given as a path', async () => {
    const f = setup({ title: 'Avery Stone', vault: { ownerNote: '[[People/Avery Stone.md|Avery]]' } });
    expect(await f.call({ node_id: 'dana' })).toMatchObject({ error: { code: 'VAULT_OWNER' } });
  });

  it('keeps apostrophes inside its description', () => {
    expect(BUILD_DOSSIER_DESCRIPTION).toContain("today's cap");
    expect(BUILD_DOSSIER_DESCRIPTION).toContain("the vault owner's own note");
  });
});

describe('build-dossier dry run (#554)', () => {
  it('is free: it reads, previews the call and asks the Engine for its dry runs, and writes nothing', async () => {
    const f = setup({ budget: { remainingUsd: async () => 0.9 } });
    const result = await f.call({ node_id: 'dana' });
    expect(result).toMatchObject({ ok: true, dry_run: true, subject: { node_id: 'dana', title: 'Dana Whitfield', kind: 'person' },
      page: { title: 'Dana Whitfield Dossier', path: 'Wikis/Dana Whitfield Dossier.md', node_id: null, action: 'create' },
      reads: { memories: { about: 3, shown: 3, left_out: 0, rules: 1, preferences: 1, owner: 1 }, notes: 1, meetings: 2, tasks: 1, people: 1, companies: 1,
        last_contact: { title: 'Kickoff call', date: '2026-03-04' } },
      model: { ref: 'home-model', provider: 'openrouter', max_output_tokens: 4000 },
      capture: { payload_bytes: 1234 }, daily_budget: { cap_usd: 1, remaining_usd: 0.9, fits: true, refusal: null },
      next: { tool: 'build-dossier', arguments: { node_id: 'dana', dry_run: false } } });
    expect(result.request_bytes).toBeGreaterThan(1000);
    expect(result.cost.estimated_usd).toBeGreaterThan(0);
    // The guess at the answer counts a reasoning model's reasoning (first real build, 2026-11-21).
    expect(ESTIMATED_OUTPUT_TOKENS).toBeGreaterThanOrEqual(10_000);
    expect(result.cost.worst_case_usd).toBeGreaterThan(result.cost.estimated_usd);
    expect(f.calls()).toBe(0);
    expect(f.prepares.map(p => p.dry_run)).toEqual([true]);
    expect(f.prepares[0]!.bundle.transform).toMatchObject({ assembly: DOSSIER_ASSEMBLY, ...DOSSIER_TRANSFORM });
    expect(f.reconciles.map(r => [r.dry_run, r.home.title_suffix])).toEqual([[true, 'Dossier']]);
    expect(f.stages).toHaveLength(0);
  });

  it('says a rebuild keeps the page, and says when the call does not fit the cap', async () => {
    const f = setup({ budget: { remainingUsd: async () => 0.000_01 },
      evidence: evidenceFor('dana', { existing_wiki: { home_id: 'home-1', home: { id: 'home-1', version: 4 } as never } }) });
    const result = await f.call({ node_id: 'dana' });
    expect(result.page).toMatchObject({ node_id: 'home-1', action: 'rebuild' });
    expect(f.reconciles[0]!.home.expected_version).toBe(4);
    expect(result.daily_budget.fits).toBe(false);
    expect(result.daily_budget.refusal).toMatch(/^daily budget: \$1\.0000 spent or in flight of \$1\.00; this build could cost up to \$/);
    expect(result.next).toBeUndefined();
  });
});

describe('the dossier estimate learns from recent calls (#724)', () => {
  it('averages the output of recent dossier calls on the model, and stands on the fixed guess without them', async () => {
    const usageReport = vi.fn(async () => ({ data: { groups: [], totals: { events: 3, output_tokens: 43_656 } }, warnings: [] }));
    const now = new Date('2026-11-21T12:00:00Z');
    expect(await recentAnswer({ engine: { usageReport } as never }, 'home-model', now)).toEqual({ tokens: 14_552, calls: 3 });
    expect(usageReport).toHaveBeenCalledWith({ purpose: 'entity-dossier', model: 'home-model', since: '2026-10-22T12:00:00.000Z', limit: 1 });
    const none = { usageReport: async () => ({ data: { groups: [], totals: { events: 0, output_tokens: 0 } }, warnings: [] }) };
    expect(await recentAnswer({ engine: none as never }, 'home-model')).toBeNull();
    const broken = { usageReport: async () => { throw new Error('engine down'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await recentAnswer({ engine: broken as never }, 'home-model')).toBeNull();
    warn.mockRestore();
    expect(estimateNote(null)).toContain(`an answer of about ${ESTIMATED_OUTPUT_TOKENS.toLocaleString('en-US')} tokens;`);
    expect(estimateNote({ tokens: 14_552, calls: 3 })).toContain('an answer of about 14,552 tokens, the average of the last 3 dossier calls on this model;');
    expect(estimateNote({ tokens: 900, calls: 1 })).toContain('the average of the last dossier call on this model;');
  });

  it('prices the dry run with that average', async () => {
    const fixed = await setup({ budget: { remainingUsd: async () => 0.9 } }).call({ node_id: 'dana' });
    const learned = await setup({ budget: { remainingUsd: async () => 0.9 }, recentCalls: { events: 2, output_tokens: 600 } }).call({ node_id: 'dana' });
    expect(learned.cost.estimated_usd).toBeLessThan(fixed.cost.estimated_usd);
    expect(learned.cost.worst_case_usd).toBe(fixed.cost.worst_case_usd);
    expect(learned.cost.note).toContain('an answer of about 300 tokens, the average of the last 2 dossier calls on this model');
  });
});

describe('build-dossier and provider key limits (Codex, #712)', () => {
  // The home model is on openrouter in these tests; a spent key elsewhere must not refuse a dossier.
  const spentExcept = (spent: string) => ({
    remainingUsd: async () => 0.9,
    providerSpent: async (providers?: readonly string[]) =>
      (providers ?? ['openrouter', 'fireworks']).includes(spent) ? `${spent} key limit reached for today` : null,
  });

  it('asks only the home model\'s provider: a spent page or planning key does not refuse it', async () => {
    const f = setup({ budget: spentExcept('fireworks') });
    const result = await f.call({ node_id: 'dana' });
    expect(result.daily_budget).toMatchObject({ fits: true, refusal: null });
  });

  it('refuses when the home model\'s own provider is spent', async () => {
    const f = setup({ budget: spentExcept('openrouter') });
    const result = await f.call({ node_id: 'dana' });
    expect(result.daily_budget).toMatchObject({ fits: false, refusal: 'openrouter key limit reached for today' });
  });
});

describe('build-dossier live run (#554)', () => {
  it('writes a captured home with only At a glance and Log, named for a dossier, and records the run', async () => {
    const f = setup();
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, dry_run: false, status: 'written', page_title: 'Dana Whitfield Dossier', node_id: 'home-1',
      output_revision_id: 'output-1', lines: 3, dropped: 1, rule_dropped: 0 });
    expect(f.calls()).toBe(2); // the page, then its rule check (the subject has a rule)
    // The build's capture is checked by the Engine's dry run (preflight), then prepared.
    expect(f.prepares.map(p => p.dry_run)).toEqual([true, false]);
    expect(f.transitions.map(t => t.action)).toEqual(['mark-sent']);
    const staged = f.stages[0]!;
    expect(staged.contribution.map(s => [s.name, s.mode])).toEqual([['At a glance', 'replace'], ['Log', 'append']]);
    expect(staged.contribution[0]!.content).toContain('- Leads the Northwind account. · since 2026-03-04 · [[Kickoff call]] <!-- memory:1 -->');
    expect(staged.contribution[1]!.content).toMatch(/^\*\*\d{4}-\d{2}-\d{2}\*\* — Dossier built from 3 memories, 1 note and 2 meetings: 3 lines; 1 left out/);
    const writes = f.reconciles.filter(r => r.home.provenance);
    expect(writes.map(r => r.dry_run)).toEqual([true, false]);
    expect(writes[1]).toMatchObject({ project: 'Dana Whitfield', project_id: 'dana', pages: [],
      reconcile_key: 'wiki-reconcile:provenance-v1:derivation-1',
      home: { sections: staged.contribution, evidence_hash: 'evidence-1', refresh_live: true, title_suffix: 'Dossier',
        provenance: { derivation_id: 'derivation-1' } } });
    expect(f.db.prepare('SELECT project, outcome, home_written, "trigger" FROM runs').all())
      .toEqual([{ project: 'Dana Whitfield Dossier', outcome: 'written', home_written: 1, trigger: 'on-demand' }]);
  });

  it('refuses up front when the worst case does not fit the cap, and queues nothing', async () => {
    const f = setup({ budget: { remainingUsd: async () => 0.000_01 } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: false, error: { code: 'DAILY_BUDGET' } });
    expect(result.error.message).toMatch(/^daily budget: .*Nothing was queued/);
    expect(f.calls()).toBe(0);
    expect(f.prepares.some(p => !p.dry_run)).toBe(false);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });

  it('records a refusal by the daily cap at call time as skipped_budget, and writes nothing', async () => {
    // The tally is read at admission: the cap is spent by the time the build's call is admitted.
    const f = setup({ spentUsd: 5 });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'skipped_budget' });
    expect(result.detail).toMatch(/^daily budget: \$5\.0000 spent of \$1\.00/);
    expect(f.calls()).toBe(0);
    expect(f.stages).toHaveLength(0);
    expect(f.db.prepare('SELECT outcome FROM runs').all()).toEqual([{ outcome: 'skipped_budget' }]);
  });

  it('fails the capture when nothing the model wrote cites what it was shown', async () => {
    const f = setup({ output: { lines: [{ section: 'Who', text: 'Uncited.', memory_ids: [404] }] } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'error' });
    expect(result.detail).toBe('None of the model\'s 1 lines could be kept (1 cited no memory or note it was shown), so nothing was written.'
      + ' First: "Uncited." in "Who", citing m404.');
    expect(f.transitions.map(t => t.action)).toEqual(['mark-sent', 'fail']);
    expect(f.reconciles.some(r => !r.dry_run)).toBe(false);
  });

  it('says why each line was left out, and reads refs the model wrote in brackets (after a build dropped all its lines)', async () => {
    const f = setup({ output: { lines: [
      { section: 'Who', text: 'Leads the Northwind account.', memory_ids: ['[m1]'] },
      { section: 'History', text: 'Met at the kickoff.', note_ids: ['[n2]'] },
      { section: 'Role', text: 'A section the person list lacks.', memory_ids: [1] },
      { section: 'Who', text: '', memory_ids: [1] },
      { section: 'Who', text: 'Cites nothing shown.', memory_ids: [404], note_ids: ['n99'] },
    ] } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'written', lines: 2, dropped: 3 });
    expect(f.stages[0]!.contribution[1]!.content)
      .toMatch(/3 left out \(1 had no text, 1 named a section the page doesn't have, 1 cited no memory or note it was shown\)/);
  });

  it('names the reasons when every line is left out', async () => {
    const f = setup({ output: { lines: [
      { section: 'Role', text: 'Wrong section.', memory_ids: [1] },
      { section: 'Who', text: 'Cites nothing shown.', memory_ids: [404] },
    ] } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result.detail).toMatch(/^None of the model's 2 lines could be kept \(1 named a section the page doesn't have, 1 cited no memory or note it was shown\)/);
    expect(result.detail).toContain('First: "Wrong section." in "Role", citing m1.');
  });

  it('queues through background builds, replies at once and names the page to follow', async () => {
    const f = setup({ builds: true });
    const enqueue = vi.spyOn(f.deps.queue, 'enqueue');
    const first = await f.call({ node_id: 'dana', dry_run: false });
    // In the lane under its page title, as wiki builds are, so curator-status's queue.current names it (#715).
    expect(enqueue).toHaveBeenCalledWith('Dana Whitfield Dossier', expect.any(Function));
    expect(first).toMatchObject({ ok: true, status: 'queued', page: { title: 'Dana Whitfield Dossier' },
      follow: { tool: 'curator-status', arguments: { project: 'Dana Whitfield Dossier' } } });
    expect(f.builds!.get(dossierBuildKey('dana'))).toBeDefined();
    const again = await f.call({ title: 'Dana Whitfield', dry_run: false });
    expect(again).toMatchObject({ ok: true, status: 'in_progress', page: { title: 'Dana Whitfield Dossier' } });
    expect(first.detail).toMatch(/two paid calls \(the page and its rule check\)/);
    await Promise.all(f.keepAlive);
    expect(f.calls()).toBe(2);
    expect(f.db.prepare('SELECT outcome FROM runs').all()).toEqual([{ outcome: 'written' }]);
  });
});

it('is paid from the daily cap: its purpose is no run budget\'s', () => {
  expect(RUN_BUDGET_PURPOSES).not.toContain('entity-dossier');
  expect(USAGE_PURPOSES).toContain('entity-dossier');
  expect(RUN_BUDGET_PURPOSES).not.toContain('entity-dossier-rules');
  expect(USAGE_PURPOSES).toContain('entity-dossier-rules');
});

describe('scheduled dossier builds (#714, Codex on #731)', () => {
  it('awaits the outcome while tracked in background builds, and skips one no longer wanted when its turn comes', async () => {
    const f = setup({ builds: true });
    const done = await startDossier(f.deps, { node_id: 'dana' }, { wait: true, stillWanted: async () => true });
    expect(done).toMatchObject({ status: 'written' });
    expect(f.calls()).toBe(2);
    const skipped = await startDossier(f.deps, { node_id: 'dana' }, { wait: true, stillWanted: async () => false });
    expect(skipped).toMatchObject({ status: 'current' });
    expect(f.calls()).toBe(2); // no model call
    expect(f.builds!.get(dossierBuildKey('dana'))).toBeUndefined();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM dossier_builds').get()).toEqual({ n: 0 }); // a skipped build leaves no row (#722)
  });
});

describe('dossier builds cut off by a restart (#722)', () => {
  const states = (db: Database.Database) => (db.prepare('SELECT state FROM dossier_builds').all() as Array<{ state: string }>).map(r => r.state);
  /** Make every row look like a process that is gone. */
  const fromGoneProcess = (db: Database.Database) => db.prepare("UPDATE dossier_builds SET pid = 999999999, process_ref = 'gone'").run();

  it('records a build as queued, then calling just before its first call, and clears it when it ends', async () => {
    const seen: string[][] = [];
    let f!: Fixture;
    f = setup({ onCall: () => seen.push(states(f.db)) });
    await f.call({ node_id: 'dana', dry_run: false });
    expect(seen).toEqual([['calling'], ['calling']]); // the page call and the rule check; publishing comes after
    expect(states(f.db)).toEqual([]);
  });

  it('starts again a build a gone process left before its call, keeping its row until the new one is queued', async () => {
    const f = setup();
    queueDossierBuild(f.db, { runRef: 'old-run', nodeId: 'dana', pageTitle: 'Dana Whitfield Dossier' });
    fromGoneProcess(f.db);
    // While the restart's free checks run, the left row is still there: a second crash keeps it (Codex, #732).
    const during: string[][] = [];
    const inspect = f.engine.inspectProvenance.getMockImplementation()!;
    f.engine.inspectProvenance.mockImplementation(async (request: { select: string }) => {
      if (request.select === 'status') during.push((f.db.prepare('SELECT run_ref FROM dossier_builds').all() as Array<{ run_ref: string }>).map(r => r.run_ref));
      return inspect(request as never);
    });
    const lines: string[] = [];
    expect(await recoverDossierBuilds(f.deps, line => lines.push(line))).toEqual({ restarted: 1, reported: 0 });
    expect(during[0]).toEqual(['old-run']);
    expect(f.calls()).toBe(2);
    expect(f.db.prepare('SELECT outcome FROM runs').all()).toEqual([{ outcome: 'written' }]);
    expect(states(f.db)).toEqual([]);
    expect(lines[0]).toMatch(/started again \(written\)/);
  });

  it('reports a build stopped while its call was out, and charges no second call', async () => {
    const stopped = setup({ hang: true });
    void stopped.call({ node_id: 'dana', dry_run: false }); // the process "stops" here, its call out
    await vi.waitFor(() => expect(states(stopped.db)).toEqual(['calling']));
    fromGoneProcess(stopped.db);
    // After the restart: the same database, a new process.
    const restarted = setup();
    const db = stopped.db;
    const result = await recoverDossierBuilds({ ...restarted.deps, db }, () => {});
    expect(result).toEqual({ restarted: 0, reported: 1 });
    expect(restarted.calls()).toBe(0);
    expect(db.prepare('SELECT outcome, error AS detail FROM runs').all()).toEqual([
      { outcome: 'error', detail: expect.stringMatching(/after its model call went out: the call may have been paid, and nothing was written\. It was not run again/) }]);
    expect(states(db)).toEqual([]);
    expect(await recoverDossierBuilds({ ...restarted.deps, db }, () => {})).toEqual({ restarted: 0, reported: 0 }); // once only
  });

  it('restarts a scheduled rebuild only while its note still asks for it (Codex, #732)', async () => {
    const f = setup();
    await f.call({ node_id: 'dana', dry_run: false }); // recorded; the note says manual
    const calls = f.calls();
    queueDossierBuild(f.db, { runRef: 'nightly', nodeId: 'dana', pageTitle: 'Dana Whitfield Dossier', scheduled: true });
    fromGoneProcess(f.db);
    expect(await recoverDossierBuilds(f.deps, () => {})).toEqual({ restarted: 1, reported: 0 });
    expect(f.calls()).toBe(calls); // not rebuilt: no longer on-change
    expect(states(f.db)).toEqual([]);
  });

  it('asks the Engine whether a page cut off while publishing went out (Codex, #732)', async () => {
    const node = (committedAt: string) => async (request: { select: string }) => request.select === 'node'
      ? { select: 'node', outputs: [{ receipt: { output_revision_id: 'out-9', committed_at: committedAt } }], current_provenance: 'captured', next_cursor: null }
      : { select: 'status', capability_version: 1, vault_namespace: 'vault', limits: LIMITS, actual_bytes: 0, reserved_bytes: 0, purge_restore_verification: 'unverified' };
    const publishing = (f: Fixture) => {
      queueDossierBuild(f.db, { runRef: 'pub', nodeId: 'dana', pageTitle: 'Dana Whitfield Dossier' });
      f.db.prepare("UPDATE dossier_builds SET state = 'publishing', updated_at = '2026-11-21T10:00:00.000Z'").run();
      fromGoneProcess(f.db);
    };
    const run = (f: Fixture) => f.db.prepare('SELECT outcome, error FROM runs').get() as { outcome: string; error: string | null };

    const written = setup({ homeOf: { dana: 'home-1' } });
    publishing(written);
    written.engine.inspectProvenance.mockImplementation(node('2026-11-21T10:00:05.000Z') as never);
    await recoverDossierBuilds(written.deps, () => {});
    expect(run(written)).toMatchObject({ outcome: 'written' });
    expect(getDossier(written.db, 'dana')).toMatchObject({ outputRevisionId: 'out-9', homeId: 'home-1' });

    const notWritten = setup({ homeOf: { dana: 'home-1' } });
    publishing(notWritten);
    notWritten.engine.inspectProvenance.mockImplementation(node('2026-11-20T09:00:00.000Z') as never);
    await recoverDossierBuilds(notWritten.deps, () => {});
    expect(run(notWritten).error).toMatch(/may have been paid, and nothing was written/);

    const unknown = setup({ homeOf: { dana: 'home-1' } });
    publishing(unknown);
    unknown.engine.inspectProvenance.mockImplementation(async () => { throw new Error('engine down'); });
    await recoverDossierBuilds(unknown.deps, () => {});
    expect(run(unknown).error).toMatch(/whether it was written could not be read\. Look at the page/);
    expect(states(unknown.db)).toEqual([]);
    expect(unknown.calls()).toBe(0);
  });

  it('leaves builds that are still running: this process\'s, and a live process\'s', () => {
    const f = setup();
    queueDossierBuild(f.db, { runRef: 'mine', nodeId: 'dana', pageTitle: 'Mine' });
    queueDossierBuild(f.db, { runRef: 'cli', nodeId: 'lee', pageTitle: 'CLI' });
    f.db.prepare("UPDATE dossier_builds SET pid = ?, process_ref = 'cli-process' WHERE run_ref = 'cli'").run(process.ppid);
    queueDossierBuild(f.db, { runRef: 'elsewhere', nodeId: 'sam', pageTitle: 'Other host' });
    f.db.prepare("UPDATE dossier_builds SET host = 'another-host', pid = 999999999, process_ref = 'x' WHERE run_ref = 'elsewhere'").run();
    expect(leftDossierBuilds(f.db, pid => pid === process.ppid || pid === process.pid)).toEqual([]);
    // A pid this process now holds, from a process that is gone, is left.
    f.db.prepare("UPDATE dossier_builds SET process_ref = 'before-restart' WHERE run_ref = 'mine'").run();
    expect(leftDossierBuilds(f.db, () => true).map(row => row.runRef)).toEqual(['mine']);
  });
});

describe('remove-dossier (#723)', () => {
  const remover = (f: Fixture) => {
    const handler = makeRemoveDossierHandler(f.deps);
    return async (args: Record<string, unknown>) => JSON.parse((await handler({ dry_run: true, ...args } as never,
      { authInfo: { scopes: ['curate:trigger'] } })).content[0]!.text) as Record<string, any>;
  };

  it('previews, then deletes the page as one undo operation and forgets the record, by the note or by the page', async () => {
    const f = setup();
    await f.call({ node_id: 'dana', dry_run: false });
    const remove = remover(f);
    const preview = await remove({ node_id: 'dana' });
    expect(preview).toMatchObject({ ok: true, dry_run: true, page: { node_id: 'home-1', title: 'Dana Whitfield Dossier' },
      next: { tool: 'remove-dossier', arguments: { node_id: 'dana', dry_run: false } } });
    expect(f.engine.deleteNode).not.toHaveBeenCalled();
    const done = await remove({ node_id: 'home-1', dry_run: false }); // the page itself names it too
    expect(done).toMatchObject({ ok: true, removed: true, operation_id: 'op-delete',
      undo: { tool: 'undo-operations', arguments: { operation_ids: ['op-delete'], dry_run: false } } });
    expect(f.engine.deleteNode).toHaveBeenCalledWith('home-1', 'Dana Whitfield Dossier');
    expect(getDossier(f.db, 'dana')).toBeNull();
  });

  it('finds a dossier built before the record by its home\'s name, and refuses any other wiki', async () => {
    const old = setup({ homeOf: { dana: 'home-old' } });
    expect(await remover(old)({ node_id: 'dana' })).toMatchObject({ ok: true, page: { node_id: 'home-old', title: 'Dana Whitfield Dossier' } });
    const project = setup({ homeOf: { dana: 'home-wiki' }, homeTitles: { 'home-wiki': 'Pilot Wiki' } });
    expect(await remover(project)({ node_id: 'dana', dry_run: false })).toMatchObject({ ok: false, error: { code: 'NOT_A_DOSSIER' } });
    expect(await remover(project)({ node_id: 'home-wiki' })).toMatchObject({ ok: false, error: { code: 'NOT_A_DOSSIER' } });
    expect(project.engine.deleteNode).not.toHaveBeenCalled();
  });

  it('removes in the build lane (Codex, #733)', async () => {
    const f = setup();
    await f.call({ node_id: 'dana', dry_run: false });
    const enqueue = vi.spyOn(f.deps.queue, 'enqueue');
    expect(await remover(f)({ node_id: 'dana', dry_run: false })).toMatchObject({ ok: true });
    expect(enqueue.mock.calls.map(([label]) => label)).toEqual(['remove dossier']);
    expect(f.engine.deleteNode).toHaveBeenCalledTimes(1);
  });

  it('refuses a recorded dossier whose note has a registered wiki now (Codex, #733)', async () => {
    const f = setup();
    await f.call({ node_id: 'dana', dry_run: false });
    registerWikiRoot(f.db, { root_title: 'Dana Whitfield', root_node_id: 'dana', kind: 'project', source: 'vault', cadence: null, brief: null, created_at: 'x', created_by: 'test' });
    expect(await remover(f)({ node_id: 'dana', dry_run: false })).toMatchObject({ ok: false, error: { code: 'NOT_A_DOSSIER' } });
    expect(f.engine.deleteNode).not.toHaveBeenCalled();
  });

  it('refuses a removal while this process builds it, without queueing behind that build (Codex, #733)', async () => {
    const f = setup({ builds: true });
    await f.call({ node_id: 'dana', dry_run: false });
    await Promise.all(f.keepAlive);
    expect(await f.call({ node_id: 'dana', dry_run: false })).toMatchObject({ ok: true, status: 'queued' });
    const enqueue = vi.spyOn(f.deps.queue, 'enqueue');
    expect(await remover(f)({ node_id: 'dana', dry_run: false })).toMatchObject({ ok: false, error: { code: 'IN_PROGRESS' } });
    expect(enqueue.mock.calls.map(([label]) => label)).not.toContain('remove dossier');
    await Promise.all(f.keepAlive);
    expect(f.engine.deleteNode).not.toHaveBeenCalled();
  });

  it('refuses while a build of it is queued or running, in any process', async () => {
    const f = setup();
    await f.call({ node_id: 'dana', dry_run: false });
    queueDossierBuild(f.db, { runRef: 'other', nodeId: 'dana', pageTitle: 'Dana Whitfield Dossier' });
    expect(await remover(f)({ node_id: 'dana', dry_run: false })).toMatchObject({ ok: false, error: { code: 'IN_PROGRESS' } });
    expect(f.engine.deleteNode).not.toHaveBeenCalled();
  });
});

describe('dossier records and the rebuild mode (#714)', () => {
  it('records a written build, current, with what the behind check compares', async () => {
    const f = setup();
    await f.call({ node_id: 'dana', dry_run: false });
    expect(getDossier(f.db, 'dana')).toMatchObject({ pageTitle: 'Dana Whitfield Dossier', homeId: 'home-1', outputRevisionId: 'output-1',
      memoryTotal: 3, status: 'current' });
  });

  it('records nothing when the build writes nothing', async () => {
    const f = setup({ output: { lines: [{ section: 'Who', text: 'Uncited.', memory_ids: [404] }] } });
    await f.call({ node_id: 'dana', dry_run: false });
    expect(getDossier(f.db, 'dana')).toBeNull();
  });

  it('says the mode in the dry run, and what rebuild would set, writing nothing', async () => {
    const f = setup({ budget: { remainingUsd: async () => 0.9 } });
    const preview = await f.call({ node_id: 'dana', rebuild: 'on-change' });
    expect(preview.rebuild).toMatchObject({ current: 'manual', would_set: 'on-change' });
    expect(preview.next.arguments).toEqual({ node_id: 'dana', dry_run: false, rebuild: 'on-change' });
    expect(f.engine.updateNodeFields).not.toHaveBeenCalled();
  });

  it('sets "dossier: on-change" on the note with a live build, and removes it for manual', async () => {
    const f = setup();
    await f.call({ node_id: 'dana', dry_run: false, rebuild: 'on-change' });
    expect(f.engine.updateNodeFields).toHaveBeenCalledWith('dana', { dossier: 'on-change' }, 'Dana Whitfield');
    expect((await f.call({ node_id: 'dana' })).rebuild.current).toBe('on-change');
    await f.call({ node_id: 'dana', dry_run: false, rebuild: 'on-change' }); // already set: no second write
    expect(f.engine.updateNodeFields).toHaveBeenCalledTimes(1);
    await f.call({ node_id: 'dana', dry_run: false, rebuild: 'manual' });
    expect(f.engine.updateNodeFields).toHaveBeenLastCalledWith('dana', { dossier: null }, 'Dana Whitfield');
  });
});

describe('the dossier rule check (#721; owner: "drop the breaking lines")', () => {
  const NONE = { owner: [], preferences: [], total: 1, newest: [memory(1, 'Dana Whitfield leads the Northwind account.')] };

  it('leaves out a line that breaks a rule, counts it in the Log, and writes the rest', async () => {
    const f = setup({ ruleCheck: { broken: [{ line: 1, rule: 1, words: 'Northwind account' }] } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'written', lines: 2, dropped: 1, rule_dropped: 1 });
    expect(result.detail).toMatch(/; 1 left out for breaking a rule on what to say\.$/);
    const glance = f.stages[0]!.contribution[0]!.content;
    expect(glance).not.toContain('Leads the Northwind account.');
    expect(glance).toContain('Prefers short agendas.');
    expect(f.stages[0]!.contribution[1]!.content).toMatch(/; 1 left out for breaking a rule on what to say\./);
    // The check reads the rules and every line the model wrote, numbered, on the page model.
    const check = f.requests[1] as { model: string; messages: Array<{ role: string; content: string }> };
    expect(check.model).toBe((f.requests[0] as { model: string }).model);
    const user = JSON.parse(check.messages.find(m => m.role === 'user')!.content) as { rules: string[]; lines: string[] };
    expect(user.rules).toEqual(['1. Never share Northwind pricing with Dana Whitfield.']);
    // Each line as the page writes it, the day and sources code adds included, so a rule against
    // giving a date or naming a source is checked too (Codex, #729); no hidden markers, and the
    // line that cites nothing (never published) isn't sent.
    expect(user.lines[0]).toBe('1. [Who] Leads the Northwind account. · since 2026-03-04 · [[Kickoff call]]');
    expect(user.lines.join('\n')).not.toContain('<!--');
    // ...and code's own "Last contact" line, last (Codex, #729).
    expect(user.lines).toEqual([expect.any(String), expect.any(String), expect.any(String), '4. [Last contact] [[Kickoff call]] · 2026-03-04']);
  });

  it('maps a broken line back to the model line it came from when an earlier line was never published', async () => {
    // The model's first line cites nothing, so the check's line 1 is the model's second.
    const f = setup({ output: { lines: [
      { section: 'Who', text: 'Cites nothing known.', memory_ids: [404] },
      { section: 'Who', text: 'Leads the Northwind account.', memory_ids: [1] },
      { section: 'Preferences', text: 'Prefers short agendas.', memory_ids: ['m2'] },
    ] }, ruleCheck: { broken: [{ line: 1, rule: 1 }] } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ status: 'written', lines: 1, dropped: 1, rule_dropped: 1 });
    expect(f.stages[0]!.contribution[0]!.content).toContain('Prefers short agendas.');
    expect(f.stages[0]!.contribution[0]!.content).not.toContain('Leads the Northwind account.');
  });

  it('leaves the Last contact section out when its line breaks a rule (Codex, #729)', async () => {
    const f = setup({ ruleCheck: { broken: [{ line: 4, rule: 1, words: 'Kickoff call' }] } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ status: 'written', lines: 3, rule_dropped: 0 });
    expect(result.detail).toMatch(/; the last contact left out for breaking a rule on what to say\.$/);
    const glance = f.stages[0]!.contribution[0]!.content;
    expect(glance).not.toContain('## Last contact');
    expect(glance).not.toContain('No past meeting'); // withheld, not "none on record"
  });

  it('makes no check when the subject has no rules', async () => {
    const f = setup({ memories: { ...NONE, rules: [] } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'written', rule_dropped: 0 });
    expect(f.calls()).toBe(1);
  });

  it('lets every line stand when the check gives no ruling, and says so', async () => {
    const f = setup({ ruleCheck: { verdict: 'unclear' } });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'written', lines: 3, rule_dropped: 0 });
    expect(result.detail).toMatch(/rules not checked \(the check gave no ruling\)/);
  });

  it('writes nothing when the check call fails, as when the page call fails, and counts both calls\' cost', async () => {
    const f = setup({ ruleCheck: Object.assign(new Error('upstream 500'), { status: 500 }) });
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'error' });
    expect(f.transitions.map(t => t.action)).toEqual(['mark-sent', 'fail']);
    expect(f.reconciles.some(r => !r.dry_run)).toBe(false);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('says the dry run makes two calls when the subject has rules, and holds both in the worst case', async () => {
    const withRule = await setup({ budget: { remainingUsd: async () => 0.9 } }).call({ node_id: 'dana' });
    const without = await setup({ budget: { remainingUsd: async () => 0.9 }, memories: { ...NONE, rules: [] } }).call({ node_id: 'dana' });
    expect(withRule.cost.calls).toBe(2);
    expect(without.cost.calls).toBe(1);
    expect(withRule.cost.note).toMatch(/^Two calls: the page, then a check of its lines against the subject's rule/);
    expect(without.cost.note).toMatch(/^One call\./);
    expect(withRule.cost.worst_case_usd).toBeGreaterThan(without.cost.worst_case_usd * 1.5);
    expect(withRule.cost.estimated_usd).toBeGreaterThan(without.cost.estimated_usd);
    expect(withRule.next.purpose).toMatch(/two paid calls/);
  });

  it('reads the check\'s own recent answers for its estimate', async () => {
    const f = setup({ budget: { remainingUsd: async () => 0.9 }, recentCalls: { events: 2, output_tokens: 3_000 } });
    const result = await f.call({ node_id: 'dana' });
    const purposes = (f.engine.usageReport.mock.calls as unknown as Array<[{ purpose: string }]>).map(([args]) => args.purpose);
    expect(purposes).toEqual(['entity-dossier', 'entity-dossier-rules']);
    expect(result.cost.note).toMatch(/a check of about 1,500, its recent average/);
  });

  it('maps the check\'s answer to lines, ignoring numbers it was not shown', async () => {
    const rules = [memory(3, 'Never share pricing.', { category: 'rule' }), memory(4, 'Say "partner", not "vendor".', { category: 'rule' })];
    const lines = [{ section: 'Who', text: 'A vendor.' }, { section: 'Who', text: 'Fine.' }];
    const llm = { structuredCall: async () => ({ output: { broken: [{ line: 1, rule: 2, words: 'vendor' }, { line: 1, rule: 2 }, { line: 9, rule: 1 },
      { line: 2, rule: 7 }] }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }) };
    const checked = await checkDossierRules(llm as never, buildDossierRuleCheckRequest({ model: 'm', maxTokens: 10, lines, rules }), { lines, rules });
    expect(checked.ruled).toBe(true);
    expect([...checked.broken.entries()].map(([index, breaks]) => [index, breaks.map(b => [b.rule.id, b.words])])).toEqual([[0, [[4, 'vendor']]]]);
  });
});

describe('past facts in History (#717)', () => {
  const at = (day: string) => `${day}T00:00:00.000Z`;
  // A contradicted memory, with the one that replaced it (the Curator's reconcile sets no invalid_at).
  const replaced = (id: number, content: string, from: string, by: number, extra: Partial<Memory> = {}) => memory(id, content,
    { valid_at: at(from), expired_at: at('2026-11-06'), expire_reason: 'contradicted', superseded_by: by, ...extra });
  const now = memory(1, 'Dana Whitfield works at Contoso.', { valid_at: at('2026-03-04') });
  const live = { rules: [], preferences: [], owner: [], total: 1, newest: [now] };

  it('shows each past fact over what replaced it, and writes it in History only, with the days it was true', async () => {
    const f = setup({ memories: { ...live, past: [replaced(7, 'Dana Whitfield works at Northwind.', '2026-01-10', 1)], replacements: [now] },
      output: { lines: [
        { section: 'Who', text: 'Works at Contoso.', memory_ids: [1] },
        { section: 'History', text: 'Worked at Northwind.', memory_ids: [7] },
        { section: 'Who', text: 'Works at Northwind.', memory_ids: [7] },
        { section: 'Relationships', text: 'Moved from Northwind to Contoso.', memory_ids: [1, 7] },
      ] } });
    const preview = await f.call({ node_id: 'dana' });
    expect(preview.reads.memories).toMatchObject({ past: 1 });
    expect(f.listed).toContainEqual(expect.objectContaining({ subject_of: 'dana', expire_reasons: ['contradicted'], limit: 10 }));
    expect(f.listed).toContainEqual(expect.objectContaining({ ids: [1], include_superseded: true }));
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'written', lines: 2, dropped: 2 });
    const sent = JSON.stringify(f.requests.find(r => !JSON.stringify(r).includes('emit_dossier_rule_check')));
    expect(sent).toContain('## PAST FACTS ABOUT DANA WHITFIELD');
    expect(sent).toContain('Dana Whitfield works at Northwind. (true from 2026-01-10 until 2026-03-04)');
    expect(sent).toContain('replaced by [m1]');
    expect(sent).toContain('13. Each PAST FACT was contradicted by the newer memory shown under it');
    expect(sent).toContain('Leave it out when the newer memory says the older one was wrong');
    const page = f.stages[0]!.contribution[0]!.content;
    expect(page).toMatch(/## History\n\n- Worked at Northwind\. · 2026-01-10 to 2026-03-04 · .*<!-- memory:7 -->/);
    expect(page).not.toContain('Works at Northwind.');
    expect(page).not.toContain('Moved from Northwind');
    expect(page).toContain('- Works at Contoso. · since 2026-03-04');
    // Recorded as inputs: the past fact and what replaced it.
    expect(JSON.stringify(f.prepares.at(-1))).toContain('dossier-past-memory:v1');
    expect(JSON.stringify(f.prepares.at(-1))).toContain('dossier-past-replacement:v1');
  });

  it('says only the days a memory knows: no start the vault only recorded (owner, #717)', async () => {
    const recorded = { valid_at: '2026-11-04T04:24:29.079Z', created_at: '2026-11-04T04:24:29.079Z' };
    const f = setup({ memories: { ...live,
      past: [
        replaced(12, 'Dana Whitfield worked at Northwind.', '2026-11-04', 1, recorded),
        replaced(14, 'Replacement gone.', '2026-02-01', 99),
      ],
      replacements: [now] },
      output: { lines: [{ section: 'History', text: 'Worked at Northwind.', memory_ids: [12] }, { section: 'Who', text: 'Works at Contoso.', memory_ids: [1] }] } });
    const preview = await f.call({ node_id: 'dana' });
    // One whose replacement can't be read is left out: nothing to judge it by.
    expect(preview.reads.memories).toMatchObject({ past: 1 });
    await f.call({ node_id: 'dana', dry_run: false });
    const sent = JSON.stringify(f.requests[0]);
    expect(sent).toContain('[m12] from');
    expect(sent).toContain('Dana Whitfield worked at Northwind. (until 2026-03-04)');
    expect(sent).not.toContain('Replacement gone.');
    expect(f.stages[0]!.contribution[0]!.content).toContain('- Worked at Northwind. · until 2026-03-04');
  });

  it('takes as past only what the Engine marks contradicted: never an update, a hand edit or a duplicate', async () => {
    const f = setup({ memories: { ...live, replacements: [now], past: [
      memory(8, 'A live one an older Engine sent back.'),
      replaced(9, 'A duplicate.', '2026-01-01', 1, { expire_reason: 'duplicate-of:1' }),
      // An update (or an edit by hand) leaves the older fact true in the newer one (owner, 2026-11-21).
      replaced(10, 'Leads the account.', '2026-01-01', 1, { expire_reason: 'superseded-by-update' }),
    ] } });
    const preview = await f.call({ node_id: 'dana' });
    expect(preview.reads.memories).toMatchObject({ past: 0 });
    await f.call({ node_id: 'dana', dry_run: false });
    expect(JSON.stringify(f.requests[0])).not.toContain('PAST FACTS');
  });

  it('asks for past facts in History, and leaves them out of a list with no History', () => {
    expect(dossierSystemPrompt(builtInDossierShape('person'), null)).toContain('Write one only in History, as what used to be');
    const noHistory = { noun: 'vendor', sections: [{ name: 'Offering', guide: 'what they sell.' }] };
    expect(dossierSystemPrompt(noHistory, null)).toContain('13. Leave out the PAST FACTS');
  });
});

describe('dossier sections per kind (#716)', () => {
  const vault = defaultsFor('vault') as unknown as VaultSettings;
  const withVendors = { ...vault, entityTypes: ['person', 'company', 'vendor'] };
  const VENDOR = 'vendor:\n- Offering: what they sell.\n- Terms: prices and contracts agreed with them.';

  it('reads the built-in lists cleanly: today\'s person and company sections, and a plain list for other kinds', () => {
    const parsed = parseDossierSections(BUILT_IN_DOSSIER_SECTIONS);
    expect(parsed.issues).toEqual([]);
    expect(Object.fromEntries([...parsed.lists].map(([key, list]) => [key, list.sections.map(s => s.name)]))).toEqual({
      person: ['Who', 'Relationships', 'Preferences', 'History', 'Open items'],
      company: ['What it is', 'People', 'Relationships', 'Preferences & terms', 'History', 'Open items'],
      other: ['What it is', 'Relationships', 'History', 'Open items'],
    });
  });

  it('says what in the setting it could not use, and uses the rest', () => {
    const parsed = parseDossierSections([
      '- Stray: before any kind.',
      'person:',
      '- Who: who they are.',
      '- Last contact: when we last met.',
      '- No guide',
      '- who: again.',
      'just words',
      'pet:',
      '- Rules on what to say: never this.',
      'person:',
      '- Role: ignored, the first person list is used.',
    ].join('\n'));
    expect(Object.fromEntries([...parsed.lists].map(([key, list]) => [key, list.sections.map(s => s.name)]))).toEqual({ person: ['Who'] });
    expect(parsed.issues).toHaveLength(8);
    expect(parsed.issues.join(' ')).toMatch(/"Rules on what to say" \(line 9\) is written by code/);
    expect(parsed.issues.join(' ')).toMatch(/line 1 comes before any "kind:" line/);
    expect(parsed.issues.join(' ')).toMatch(/"Last contact" \(line 4\) is written by code/);
    expect(parsed.issues.join(' ')).toMatch(/line 5 needs a name and what goes in it/);
    expect(parsed.issues.join(' ')).toMatch(/"who" is in "person" twice/);
    expect(parsed.issues.join(' ')).toMatch(/line 7 is neither/);
    expect(parsed.issues.join(' ')).toMatch(/"pet" lists no section it can use/);
    expect(parsed.issues.join(' ')).toMatch(/"person" is listed twice \(line 10\)/);
  });

  it('looks for the note\'s own kind, then person or company, then other; the setting before the built-in at each', () => {
    const pick = (setting: string | undefined, types: string[], v: VaultSettings = withVendors) => {
      const chosen = dossierSectionsFor(setting, v, types);
      return [chosen.list, chosen.from, chosen.noun, chosen.sections.map(s => s.name).join(', ')];
    };
    expect(pick(undefined, ['person'], vault)).toEqual(['person', 'built-in', 'person', 'Who, Relationships, Preferences, History, Open items']);
    expect(pick('', ['vendor'])).toEqual(['other', 'built-in', 'vendor', 'What it is, Relationships, History, Open items']);
    expect(pick(VENDOR, ['vendor'])).toEqual(['vendor', 'setting', 'vendor', 'Offering, Terms']);
    expect(pick(VENDOR, ['person'])[1]).toBe('built-in');
    // A company's own list comes before the setting's general one.
    expect(pick('other:\n- Notes: anything else.', ['company'])[0]).toBe('company');
    expect(pick('other:\n- Notes: anything else.', ['vendor'])).toEqual(['other', 'setting', 'vendor', 'Notes']);
    // The vault map's person kind under another name takes the person list, unless it has its own.
    const contacts = { ...vault, personType: 'contact' };
    expect(pick(undefined, ['contact'], contacts)).toEqual(['person', 'built-in', 'person', 'Who, Relationships, Preferences, History, Open items']);
    expect(pick('Contact:\n- Role: what they do.', ['contact'], contacts)).toEqual(['Contact', 'setting', 'person', 'Role']);
  });

  it('a kind given its own sections in the setting changes its next dossier, with no code change', async () => {
    const f = setup({ types: ['vendor'], title: 'Dana Whitfield', vault: { entityTypes: ['person', 'company', 'vendor'] }, dossierSections: VENDOR,
      output: { lines: [
        { section: 'Terms', text: 'Pays in 30 days.', memory_ids: [1] },
        { section: 'offering', text: 'Sells field sensors.', memory_ids: [1] },
        { section: 'Who', text: 'Not a section of this list.', memory_ids: [1] },
      ] } });
    const preview = await f.call({ node_id: 'dana' });
    expect(preview.sections).toMatchObject({ list: 'vendor', from: 'setting', names: ['Offering', 'Terms'] });
    expect(preview.sections).not.toHaveProperty('setting_issues');
    const result = await f.call({ node_id: 'dana', dry_run: false });
    expect(result).toMatchObject({ ok: true, status: 'written', lines: 2, dropped: 1 });
    const sent = JSON.stringify(f.requests.find(r => !JSON.stringify(r).includes('emit_dossier_rule_check')));
    expect(sent).toContain('about one vendor');
    expect(sent).toContain('- Offering: what they sell.');
    expect(sent).not.toContain('- Who:');
    const page = f.stages[0]!.contribution[0]!.content;
    expect(page.indexOf('## Offering')).toBeGreaterThan(-1);
    expect(page.indexOf('## Offering')).toBeLessThan(page.indexOf('## Terms'));
    expect(page.indexOf('## Terms')).toBeLessThan(page.indexOf('## Last contact'));
    expect(page).not.toContain('Not a section of this list.');
  });

  it('says in the dry run what in the setting it could not use', async () => {
    const f = setup({ dossierSections: 'person:\n- Last contact: when we last met.\n- Who: who they are.' });
    const preview = await f.call({ node_id: 'dana' });
    expect(preview.sections).toMatchObject({ list: 'person', from: 'setting', names: ['Who'] });
    expect(preview.sections.setting_issues).toEqual([expect.stringMatching(/"Last contact" \(line 2\) is written by code/)]);
  });
});

it('a dossier section list ends where the page adds its own', () => {
  expect(PERSON_SECTIONS.at(-1)).toBe('Open items');
  expect(builtInDossierSections('company')[0]!.name).toBe('What it is');
});
