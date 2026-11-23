import { randomUUID } from 'node:crypto';
import { estimateCostUsdWith } from '@vault/pricing';
import type { ModelProvider } from '@vault/settings-registry';
import { projectBuildKey } from '../background-builds.js';
import { budgetRefusalDetail, isBudgetRefusal, isShutdownRefusal, worstCaseCallUsd } from '../budget.js';
import { vaultOf } from '../config.js';
import type { CoreDeps } from '../core.js';
import { localDate, stampLog } from '../date-line.js';
import { curateResultToRunRow, recordRun } from '../db/runs.js';
import { EngineError, type WikiReconcileInput } from '../engine.js';
import { StructuredCallFailure, type LlmClient, type PreparedCapture, type StructuredCallRequest } from '../llm/types.js';
import { ownerName } from '../memory-extract.js';
import { roundUsd } from '../on-demand/cost.js';
import { catalogPricing, estimateCostByModel } from '../pricing.js';
import { buildDossierRequest, parseDossierLines } from '../prompts/dossier.js';
import { measureBundle, readCaptureLimits, type CaptureLimits } from '../provenance-budget.js';
import { canonical, capturedBundle, type CaptureTransformLabels } from '../provenance-evidence.js';
import { HomeCapture, closedCaptureReason } from '../provenance-home.js';
import type { Contribution, Json, OutputReceipt } from '../provenance-types.js';
import type { CurateResult, TokenUsage } from '../types.js';
import { bindWikiStageClient, resolveConfiguredWikiStage, type ResolvedWikiStagePolicy } from '../wiki-output-policy.js';
import { memoryDay } from '../wiki-memories.js';
import {
  DossierError, gatherDossierEvidence, memoryCountPhrase, resolveDossierSubject, sourcesPhrase,
  type DossierEvidence, type DossierSubject, type DossierTarget,
} from './evidence.js';
import { recordDossierBuild } from '../db/dossiers.js';
import { finishDossierBuild, leftDossierBuilds, markDossierCalling, markDossierPublishing, queueDossierBuild, type DossierBuildRow } from '../db/dossier-builds.js';
import { processAlive } from '../on-demand/run.js';
import { fieldValue } from '../evidence.js';
import { DOSSIER_FIELD, rebuildOf, scheduledRebuildWanted, type DossierRebuild } from './freshness.js';
import { droppedPhrase, renderDossierPage } from './page.js';
import { dossierSectionsFor, type DossierSections } from './sections.js';
import { applyDossierRuleCheck, buildDossierRuleCheckRequest } from './rules.js';

/**
 * Dossiers (#554, slice 3): one wiki home per person or company note, built on request. Owner's
 * decisions (2026-11-20): live facts only, dated; every line cites its source and the page's
 * capture records its inputs; no privacy filter; named "<Name> Dossier"; paid from the daily cap
 * after a free dry run. Path "c": the page is a captured wiki home whose root is the entity note,
 * written through `wiki-reconcile` like a project home, with only At a glance and Log. It is not
 * registered in `wiki_roots`, so no sweep keeps it current, and the Engine's behind check skips it.
 */

export const DOSSIER_ASSEMBLY = 'entity-dossier-evidence-v1';
export const DOSSIER_TRANSFORM: CaptureTransformLabels = {
  prompt: 'entity-dossier-v1', schema: 'entity-dossier-lines-v1', output: 'managed-dossier-contribution-v1',
};
/**
 * The estimate's guess at the answer, reasoning included, when no dossier call on the model is in
 * the ledger yet. The first real build (2026-11-21, the production home model, a reasoning model)
 * wrote 41 lines in 10,829 output tokens, most of them reasoning; the guess of 2,500 put the
 * estimate at a third of the cost. The worst case uses the cap.
 */
export const ESTIMATED_OUTPUT_TOKENS = 11_000;
/** The estimate's guess at a rule check's answer (#721), reasoning included, before any is in the
 *  ledger: the check reads the lines and the rules and names few or none. */
export const ESTIMATED_CHECK_OUTPUT_TOKENS = 4_000;
/** The estimate's guess at the lines the check reads, in bytes: the first real build wrote 41 lines. */
const ESTIMATED_LINES_BYTES = 8_000;
/** The worst case for the lines the check reads, in bytes per token of the page call's cap: lines are
 *  at most the page call's output, and a token is rarely more than 4 bytes of text. */
const WORST_BYTES_PER_OUTPUT_TOKEN = 4;
/** How far back the estimate looks for dossier calls on the same model (#724). */
export const RECENT_ANSWER_DAYS = 30;
/** The estimate's guess at input tokens per byte of request. The worst case counts one per byte. */
const BYTES_PER_TOKEN = 4;

/** The in-flight key for a note's dossier, beside the page title's, which curator-status reads. */
export const dossierBuildKey = (nodeId: string): string => `dossier:${nodeId}`;

interface PreparedDossier {
  readonly subject: DossierSubject;
  readonly gathered: DossierEvidence;
  readonly policy: ResolvedWikiStagePolicy;
  readonly llm: LlmClient;
  readonly request: StructuredCallRequest;
  readonly preview: PreparedCapture;
  readonly limits: CaptureLimits;
  /** The page as the Engine's dry run names it: a new "<Name> Dossier", or the existing home. */
  readonly page: { readonly title: string; readonly file_path: string; readonly node_id: string | null; readonly created: boolean };
  readonly homeVersion: number | undefined;
  /** The note's section list (#716): from the `dossierSections` setting, else built in. */
  readonly sections: DossierSections;
}

/** Two calls' token counts added together. */
function plusUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An Engine from before the dossier title option refuses `home.title_suffix` as an unknown key. */
function olderEngine(error: unknown): boolean {
  return error instanceof Error && /title_suffix|unrecognized key/i.test(error.message);
}

/** The free part of a build: resolve the note, read its evidence, build the request and preview it,
 *  measure it against the capture limits, and ask the Engine what page it would write. */
async function prepareDossier(deps: CoreDeps, target: DossierTarget, generatedAt: Date, runRef: string,
  known?: DossierSubject): Promise<PreparedDossier> {
  const subject = known ?? await resolveDossierSubject(deps, target);
  const status = await deps.engine.inspectProvenance({ select: 'status' });
  if (status.select !== 'status' || status.capability_version !== 1) {
    throw new DossierError('UPGRADE_REQUIRED', 'This Engine cannot record what a page was built from; update it to build dossiers.');
  }
  let limits: CaptureLimits;
  try { limits = readCaptureLimits(status.limits); }
  catch { throw new DossierError('UPGRADE_REQUIRED', 'This Engine reports capture limits the Curator cannot read; update the Engine.'); }
  let policy: ResolvedWikiStagePolicy;
  let llm: LlmClient;
  try {
    policy = resolveConfiguredWikiStage(deps.config, deps.llm, 'home');
    llm = bindWikiStageClient(deps.llm, policy);
  } catch (error) {
    throw new DossierError('MODEL_UNAVAILABLE', `The wiki home model (wikiHomeModel, else model) can't be used: ${message(error)}`);
  }
  if (!llm.supportsPreparedCapture || !llm.previewStructuredCall) {
    throw new DossierError('CAPTURE_UNAVAILABLE', 'The home model\'s client cannot record its request, so a dossier\'s inputs could not be captured.');
  }
  const gathered = await gatherDossierEvidence(deps, subject, generatedAt);
  const sections = dossierSectionsFor(deps.config.dossierSections, vaultOf(deps.config), subject.types);
  if (sections.issues.length > 0) console.warn(`[dossier] dossierSections: ${sections.issues.join(' ')}`);
  const request = buildDossierRequest({ shape: sections, owner: ownerName(vaultOf(deps.config).ownerNote), evidence: gathered.text,
    model: policy.model, maxTokens: policy.maxTokens, generatedAt, timeZone: deps.config.curatorTz });
  const preview = await llm.previewStructuredCall(request);
  const issue = measureBundle(capturedBundle(preview, gathered.collector, DOSSIER_ASSEMBLY, DOSSIER_TRANSFORM), limits);
  if (issue) {
    throw new DossierError('EVIDENCE_TOO_LARGE', `What this dossier would read is over the Engine's capture limits (${issue.dimension}: `
      + `${issue.measured} of ${issue.allowed}). Shorten the note itself, or raise the capture limits.`);
  }
  const homeVersion = gathered.evidence.existing_wiki.home?.version;
  let page: PreparedDossier['page'];
  try {
    const { data } = await deps.engine.wikiReconcile({ project: subject.title, project_id: subject.id,
      reconcile_key: `dossier-preview:${runRef}`, pages: [], dry_run: true,
      home: { ...(homeVersion === undefined ? {} : { expected_version: homeVersion }),
        sections: [{ name: 'At a glance', mode: 'replace', content: 'Dossier preview.' }],
        evidence_hash: gathered.evidence.evidence_hash, curated_at: generatedAt.toISOString(), refresh_live: true, title_suffix: 'Dossier' } });
    page = { title: data.home.title, file_path: data.home.file_path, node_id: data.home.node_id, created: data.home.created };
  } catch (error) {
    if (olderEngine(error)) throw new DossierError('UPGRADE_REQUIRED', 'This Engine cannot name a page "<Name> Dossier"; deploy the Engine with this Curator.');
    throw error;
  }
  return { subject, gathered, policy, llm, request, preview, limits, page, homeVersion, sections };
}

interface CostEstimate { readonly priced: boolean; readonly estimated_usd: number | null; readonly worst_case_usd: number | null }

/** The average answer of recent dossier calls on one model, reasoning included. */
export interface RecentAnswer { readonly tokens: number; readonly calls: number }

/**
 * What recent dossier calls on this model answered with, on average, from the ledger (#724): real
 * builds on the production home model used 10,829 and 16,827 output tokens, and one ran past its
 * 16,000 cap, against a fixed guess of 11,000. A call that failed counts: it was paid. Best effort:
 * null when there are none or the ledger can't be read, and the fixed guess stands.
 */
export async function recentAnswer(deps: Pick<CoreDeps, 'engine'>, model: string, now = new Date(),
  purpose: 'entity-dossier' | 'entity-dossier-rules' = 'entity-dossier'): Promise<RecentAnswer | null> {
  try {
    const since = new Date(now.getTime() - RECENT_ANSWER_DAYS * 86_400_000).toISOString();
    const { data } = await deps.engine.usageReport({ purpose, model, since, limit: 1 });
    const calls = Number(data.totals['events'] ?? 0);
    const output = Number(data.totals['output_tokens'] ?? Number.NaN);
    if (!(calls > 0) || !Number.isFinite(output) || output <= 0) return null;
    return { tokens: Math.ceil(output / calls), calls };
  } catch (error) {
    console.warn(`[curator] dossier: recent calls unreadable, the estimate takes its fixed guess: ${message(error)}`);
    return null;
  }
}

const requestBytes = (request: StructuredCallRequest): number =>
  [request.system, request.user, request.toolName, request.toolDescription, JSON.stringify(request.schema)]
    .reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);

/** The rule check a build will make (#721): none when the subject has no rules. */
interface CheckPlan { readonly rules: DossierEvidence['memories']['rules']; readonly answer: RecentAnswer | null }

/**
 * What the build's calls should cost and the most they can: the page call, then the rule check when
 * the subject has rules (#721). The worst case is what the daily cap holds for each: the check's
 * lines are not known before the page call, so it counts them at their largest.
 */
function costOf(deps: CoreDeps, request: StructuredCallRequest, answer: RecentAnswer | null = null, check: CheckPlan | null = null): CostEstimate {
  const pricing = catalogPricing(deps.config)(request.model);
  if (!pricing) return { priced: false, estimated_usd: null, worst_case_usd: null };
  let estimated = estimateCostUsdWith(pricing, { input: Math.ceil(requestBytes(request) / BYTES_PER_TOKEN),
    output: Math.min(request.maxTokens, answer?.tokens ?? ESTIMATED_OUTPUT_TOKENS), cacheRead: 0, cacheWrite: 0 });
  let worst = worstCaseCallUsd(request, pricing);
  if (check !== null && check.rules.length > 0) {
    const empty = buildDossierRuleCheckRequest({ model: request.model, maxTokens: request.maxTokens, lines: [], rules: check.rules });
    estimated += estimateCostUsdWith(pricing, { input: Math.ceil((requestBytes(empty) + ESTIMATED_LINES_BYTES) / BYTES_PER_TOKEN),
      output: Math.min(request.maxTokens, check.answer?.tokens ?? ESTIMATED_CHECK_OUTPUT_TOKENS), cacheRead: 0, cacheWrite: 0 });
    const largest = buildDossierRuleCheckRequest({ model: request.model, maxTokens: request.maxTokens,
      lines: [{ section: 'Who', text: 'x'.repeat(WORST_BYTES_PER_OUTPUT_TOKEN * request.maxTokens) }], rules: check.rules });
    worst += worstCaseCallUsd(largest, pricing);
  }
  return { priced: true, estimated_usd: roundUsd(estimated), worst_case_usd: roundUsd(worst) };
}

/** How the dry run words its estimate. */
export function estimateNote(answer: RecentAnswer | null, check: CheckPlan | null = null): string {
  const tokens = (answer?.tokens ?? ESTIMATED_OUTPUT_TOKENS).toLocaleString('en-US');
  const basis = answer === null ? ''
    : `, the average of the last ${answer.calls === 1 ? 'dossier call' : `${answer.calls} dossier calls`} on this model`;
  if (check === null || check.rules.length === 0) {
    return `One call. The estimate takes about ${BYTES_PER_TOKEN} bytes a token and an answer of about ${tokens} tokens${basis}; the worst case is what today's cap holds for it.`;
  }
  const checkTokens = (check.answer?.tokens ?? ESTIMATED_CHECK_OUTPUT_TOKENS).toLocaleString('en-US');
  return `Two calls: the page, then a check of its lines against ${check.rules.length === 1 ? 'the subject\'s rule' : `the subject's ${check.rules.length} rules`} `
    + `on what may be said, which leaves out any line that breaks one. The estimate takes about ${BYTES_PER_TOKEN} bytes a token, an answer of about ${tokens} tokens${basis}, `
    + `and a check of about ${checkTokens}${check.answer === null ? '' : ', its recent average'}; the worst case is what today's cap holds for both.`;
}

interface DailyCap { readonly cap_usd: number | null; readonly remaining_usd: number | null; readonly fits: boolean; readonly refusal: string | null }

/** Whether the call fits today's cap and the home provider's key limit, worded as the budget words a
 *  refusal. Only the home model's provider is asked: a dossier makes no planning or page call, so a
 *  spent key there must not refuse it (Codex, #712). */
async function dailyCapFor(deps: CoreDeps, model: string, provider: ModelProvider, cost: CostEstimate): Promise<DailyCap> {
  const capUsd = typeof deps.config.dailyBudgetCents === 'number' ? deps.config.dailyBudgetCents / 100 : null;
  const remaining = deps.budget ? await deps.budget.remainingUsd() : null;
  const providerSpent = await deps.budget?.providerSpent?.([provider]) ?? null;
  let refusal: string | null = null;
  if (providerSpent) refusal = providerSpent;
  else if (capUsd !== null && !cost.priced) {
    refusal = `daily budget: no pricing for model ${model}; add pricing to its Settings/Models note or clear dailyBudgetCents`;
  } else if (capUsd !== null && remaining !== null && cost.worst_case_usd !== null && cost.worst_case_usd > remaining) {
    refusal = `daily budget: $${Math.max(0, capUsd - remaining).toFixed(4)} spent or in flight of $${capUsd.toFixed(2)}; `
      + `this build could cost up to $${cost.worst_case_usd.toFixed(4)}`;
  }
  return { cap_usd: capUsd, remaining_usd: remaining === null ? null : roundUsd(Math.max(0, remaining)), fits: refusal === null, refusal };
}

function readsOf(gathered: DossierEvidence) {
  const m = gathered.memories;
  return {
    memories: { about: m.total, shown: m.rules.length + m.facts.length, past: m.past.length, left_out: m.omitted, rules: m.rules.length,
      preferences: m.facts.filter(memory => memory.category === 'preference').length, owner: m.owner.length },
    notes: gathered.counts.notes, meetings: gathered.counts.meetings, read_in_full: gathered.counts.bodies, tasks: gathered.counts.tasks,
    people: gathered.counts.people, companies: gathered.counts.companies,
    last_contact: gathered.lastContact,
    ...(gathered.contactSearched !== null ? { last_contact_searched: gathered.contactSearched } : {}),
  };
}

function subjectOf(subject: DossierSubject) {
  return { node_id: subject.id, title: subject.title, kind: subject.kind };
}

/** The free dry run: what would be read, the page, the model, the request's size, the Engine's own
 *  dry run of the capture, the cost and today's cap. No model call, no reservation, no write. */
/** The page's sections (#716): which list, from where, and what in the setting could not be used. */
function sectionsView(sections: DossierSections) {
  return { list: sections.list, from: sections.from, names: sections.sections.map(section => section.name),
    ...(sections.issues.length > 0 ? { setting_issues: sections.issues } : {}),
    note: sections.from === 'setting'
      ? `The "${sections.list}" list of the dossierSections setting (Settings/Curator/Wikis.md).`
      : `The built-in "${sections.list}" list. The dossierSections setting (Settings/Curator/Wikis.md) can give this kind its own.` };
}

/** The note's `dossier` field as a rebuild mode (#714), and what a live build with `rebuild` would set. */
function rebuildView(subject: DossierSubject, requested: DossierRebuild | undefined) {
  const current = rebuildOf(subject.node.fields?.[DOSSIER_FIELD]);
  return { current, ...(requested !== undefined && requested !== current ? { would_set: requested } : {}),
    note: current === 'on-change'
      ? 'The nightly sweep rebuilds this dossier when it is behind (a memory about its subject, or a note it read, changed), at most 5 a night, from the daily cap.'
      : `Built only when asked. ${requested === 'on-change' ? 'This build would' : 'rebuild "on-change" would'} set "${DOSSIER_FIELD}: on-change" on the note, so the nightly sweep rebuilds it when it is behind.` };
}

export async function previewDossier(deps: CoreDeps, target: DossierTarget, opts: { readonly rebuild?: DossierRebuild } = {}) {
  const generatedAt = new Date();
  const runRef = randomUUID();
  const prepared = await prepareDossier(deps, target, generatedAt, runRef);
  let capture: { item_count: number; payload_bytes: number };
  try {
    const result = await deps.engine.prepareProvenance({ attempt_key: randomUUID(), run_ref: runRef, project_id: prepared.subject.id,
      bundle: capturedBundle(prepared.preview, prepared.gathered.collector, DOSSIER_ASSEMBLY, DOSSIER_TRANSFORM), dry_run: true });
    if (!('dry_run' in result) || !result.dry_run) throw new Error('PROVENANCE_PREVIEW_INVALID');
    capture = { item_count: result.item_count, payload_bytes: result.payload_bytes };
  } catch (error) {
    throw new DossierError('CAPTURE_REFUSED', `The Engine would not record this build's inputs (${closedCaptureReason(error)}). Try the dry run again; `
      + 'a note or memory may have changed while it was read.');
  }
  const answer = await recentAnswer(deps, prepared.request.model);
  const rules = prepared.gathered.memories.rules;
  const check: CheckPlan | null = rules.length > 0
    ? { rules, answer: await recentAnswer(deps, prepared.request.model, new Date(), 'entity-dossier-rules') } : null;
  const cost = costOf(deps, prepared.request, answer, check);
  let cap: DailyCap;
  try {
    cap = await dailyCapFor(deps, prepared.request.model, prepared.preview.provider, cost);
  } catch (error) {
    cap = { cap_usd: null, remaining_usd: null, fits: false, refusal: budgetRefusalDetail(error) };
  }
  const reads = readsOf(prepared.gathered);
  return {
    dry_run: true as const,
    subject: subjectOf(prepared.subject),
    page: { title: prepared.page.title, path: prepared.page.file_path, node_id: prepared.page.node_id,
      action: prepared.page.created ? 'create' as const : 'rebuild' as const },
    reads,
    sections: sectionsView(prepared.sections),
    rebuild: rebuildView(prepared.subject, opts.rebuild),
    ...(reads.memories.left_out > 0 ? { memories_note: `The page will say it was built from ${memoryCountPhrase(prepared.gathered.memories)}.` } : {}),
    model: { ref: prepared.policy.model, provider: prepared.preview.provider, max_output_tokens: prepared.policy.maxTokens },
    request_bytes: Buffer.byteLength(canonical(prepared.preview.payload as Json), 'utf8'),
    capture,
    cost: { ...cost, calls: check === null ? 1 : 2, note: cost.priced ? estimateNote(answer, check) : 'The model has no pricing, so the cost is not known.' },
    daily_budget: cap,
    ...(cap.fits ? { next: { tool: 'build-dossier', arguments: { node_id: prepared.subject.id, dry_run: false, ...(opts.rebuild ? { rebuild: opts.rebuild } : {}) },
      purpose: `Write "${prepared.page.title}" with ${check === null ? 'one paid call' : 'two paid calls (the page and its rule check)'} on ${prepared.policy.model}, from today's cap.` } } : {}),
  };
}

export type DossierOutcome = {
  /** `current`: a scheduled rebuild found, when its turn came, that it was no longer behind. */
  readonly outcome: 'written' | 'skipped_budget' | 'error' | 'current';
  readonly page_title: string;
  readonly detail: string;
  readonly node_id?: string;
  readonly output_revision_id?: string;
  readonly lines?: number;
  readonly dropped?: number;
  /** Lines left out for breaking a rule on what may be said (#721). */
  readonly rule_dropped?: number;
  readonly cost_usd?: number | null;
};

/** Best effort, as every run's record is: a failed insert warns and the build stands. */
function recordDossierRun(deps: CoreDeps, result: CurateResult, ts: string, durationMs: number): void {
  if (!deps.db) return;
  try {
    recordRun(deps.db, curateResultToRunRow(result, { trigger: 'on-demand', durationMs, ts }));
  } catch (error) {
    console.warn(`[curator] dossier run not recorded for ${result.project}: ${message(error)}`);
  }
}

function failureDetail(error: unknown, capture: HomeCapture | undefined): string {
  if (error instanceof DossierError) return error.message;
  if (isShutdownRefusal(error)) return `${budgetRefusalDetail(error)}. Nothing was written; build it again after the restart.`;
  if (isBudgetRefusal(error)) return `${budgetRefusalDetail(error)}. Nothing was written; build it again once there is budget.`;
  const captureReason = capture?.failureReason
    ?? (error instanceof Error && /^PROVENANCE_[A-Z_]+$/.test(error.message) ? error.message : null);
  if (captureReason) return `The Engine refused to record this build's inputs (${captureReason}); nothing was written. A note or memory may have changed while it was read: build it again.`;
  if (error instanceof StructuredCallFailure) return `The model call failed (${error.reason ?? 'unknown reason'}); nothing was written.`;
  return message(error).slice(0, 500);
}

/** One build, in the curation lane: read afresh, capture, one paid call, stage, publish, record. Never throws. */
async function runDossier(deps: CoreDeps, target: DossierTarget, pageTitle: string, runRef: string = randomUUID()): Promise<DossierOutcome> {
  const startedMs = Date.now();
  const ts = new Date().toISOString();
  const generatedAt = new Date();
  let title = pageTitle;
  let usage: TokenUsage | undefined;
  let model: string | undefined;
  let capture: HomeCapture | undefined;
  let evidenceHash: string | undefined;
  deps.recorder?.setContext({ runRef, trigger: 'on-demand', fn: 'entity-dossier', project: title });
  const costUsd = (): number | null => usage && model ? estimateCostByModel([[model, usage]], catalogPricing(deps.config)) : null;
  try {
    const p = await prepareDossier(deps, target, generatedAt, runRef);
    title = p.page.title;
    model = p.request.model;
    evidenceHash = p.gathered.evidence.evidence_hash;
    capture = new HomeCapture(deps.engine, p.subject.id, runRef, false, p.gathered.collector, generatedAt, DOSSIER_ASSEMBLY, {},
      deps.config.curatorTz, DOSSIER_TRANSFORM);
    await capture.preflight(p.preview);
    // From here a restart can't tell whether the call was paid (#722): it is reported, not re-run.
    if (deps.db) markDossierCalling(deps.db, runRef);
    const onPrepared = capture.onPrepared;
    const call = () => p.llm.structuredCall({ ...p.request, onPrepared });
    const result = deps.usage ? await deps.usage.withContext({ project: title, runRef, purpose: 'entity-dossier' }, call) : await call();
    usage = result.usage;
    const lines = parseDossierLines(result.output);
    if (lines === null) throw new DossierError('MODEL_OUTPUT_INVALID', 'The model returned no lines; nothing was written.');
    const lineInput = { kind: p.subject.kind, sections: p.sections.sections.map(section => section.name), memories: p.gathered.memoryById, refs: p.gathered.refs,
      sourceTitles: p.gathered.sourceTitles, day: memoryDay(deps.config.curatorTz), today: localDate(generatedAt, deps.config.curatorTz) };
    // The rule check (#721): the model lines behind breaking lines are left out, and a breaking
    // "Last contact" withheld (`applyDossierRuleCheck`, shared with eval:dossier).
    const rules = p.gathered.memories.rules;
    const checked = await applyDossierRuleCheck(p.llm, { model: p.request.model, maxTokens: p.request.maxTokens, lines, lineInput, rules,
      lastContact: p.gathered.lastContact,
      call: check => deps.usage ? deps.usage.withContext({ project: title, runRef, purpose: 'entity-dossier-rules' }, check) : check() });
    if (checked.usage) usage = plusUsage(usage, checked.usage);
    const { lines: shown, ruleDropped, contactWithheld } = checked;
    const rulesUnchecked = checked.ruled === false;
    for (const entry of checked.breaks) {
      console.warn(`[curator] dossier "${title}": ${entry.what} left out, it breaks ${entry.breaks.map(b => `memory ${b.rule.id}${b.words ? ` ("${b.words.slice(0, 80)}")` : ''}`).join('; ')}`);
    }
    const sources = sourcesPhrase(p.gathered.memories, p.gathered.counts);
    const page = renderDossierPage({ ...lineInput, lines: shown, rules: p.gathered.memories.rules, lastContact: p.gathered.lastContact,
      contactSearched: p.gathered.contactSearched, contactWithheld,
      header: `_Built ${localDate(generatedAt, deps.config.curatorTz)} from ${sources}. Each line gives where it came from, and the day it became true when its source gives one._` });
    if (page.dropped > 0) {
      console.warn(`[curator] dossier "${title}": ${page.dropped} of the model's lines left out (${droppedPhrase(page.droppedWhy)}); first: `
        + JSON.stringify(page.droppedExamples.map(line => ({ why: line.reason, section: line.section, text: line.text.slice(0, 120),
          memory_ids: line.memory_ids, note_ids: line.note_ids }))));
    }
    if (page.kept === 0) {
      // The model's answer, as it came back, for the server log: nothing else keeps it.
      console.warn(`[curator] dossier "${title}": no line kept; the model's answer (first 4,000 characters): ${JSON.stringify(result.output).slice(0, 4000)}`);
      const first = page.droppedExamples[0];
      const example = first ? ` First: "${first.text.slice(0, 80)}" in "${first.section}", citing ${[...first.memory_ids.map(id => `m${id}`), ...first.note_ids].join(', ') || 'nothing'}.` : '';
      throw new DossierError('NOTHING_CITED', ruleDropped > 0
        ? `Of the model's ${lines.length} lines, ${ruleDropped} broke a rule on what may be said and the rest were left out (${droppedPhrase(page.droppedWhy)}), so nothing was written.${example}`
        : `None of the model's ${lines.length} lines could be kept (${droppedPhrase(page.droppedWhy)}), so nothing was written.${example}`);
    }
    const ruleNote = `${ruleDropped > 0 ? `; ${ruleDropped} left out for breaking a rule on what to say` : ''}`
      + `${contactWithheld ? '; the last contact left out for breaking a rule on what to say' : ''}`
      + `${rulesUnchecked ? '; rules not checked (the check gave no ruling)' : ''}`;
    const log = stampLog(`Dossier built from ${sources}: ${page.kept} lines`
      + `${page.dropped > 0 ? `; ${page.dropped} left out (${droppedPhrase(page.droppedWhy)})` : ''}${ruleNote}.`, generatedAt, deps.config.curatorTz);
    const contribution: Contribution = [
      { name: 'At a glance', mode: 'replace', content: page.content },
      // Keeps equal same-day entries apart without visible noise, as a home refresh's log does.
      { name: 'Log', mode: 'append', content: `${log}\n<!-- dossier-run:${runRef} -->` },
    ];
    const binding = await capture.stageContribution(contribution, { lines: JSON.stringify(lines) });
    if (!binding) throw new Error('PROVENANCE_UNAVAILABLE');
    const publication: WikiReconcileInput = { project: p.subject.title, project_id: p.subject.id,
      reconcile_key: `wiki-reconcile:provenance-v1:${binding.derivation_id}`, pages: [],
      home: { ...(p.homeVersion === undefined ? {} : { expected_version: p.homeVersion }), sections: contribution,
        evidence_hash: evidenceHash, curated_at: generatedAt.toISOString(), refresh_live: true, provenance: binding, title_suffix: 'Dossier' } };
    await deps.engine.wikiReconcile({ ...publication, dry_run: true });
    // From here the page may be written even if this process is stopped (#722, Codex on #732).
    if (deps.db) markDossierPublishing(deps.db, runRef);
    const { data } = await deps.engine.wikiReconcile({ ...publication, dry_run: false });
    const receipt: OutputReceipt | undefined = data.provenance_receipt;
    if (!receipt) throw new Error('The Engine wrote the page but returned no capture receipt.');
    title = data.home.title;
    // The record the behind check and the nightly rebuilds read (#714). Best effort: the page stands.
    if (deps.db) {
      try {
        recordDossierBuild(deps.db, { nodeId: p.subject.id, pageTitle: title, homeId: receipt.output_node_id,
          outputRevisionId: receipt.output_revision_id, builtAt: generatedAt.toISOString(), memoryTotal: p.gathered.memories.total });
      } catch (error) {
        console.warn(`[curator] dossier "${title}" not recorded: ${message(error)}`);
      }
    }
    const detail = `Wrote "${title}": ${page.kept} lines from ${sources}`
      + `${page.undated > 0 ? `, ${page.undated} without a day` : ''}`
      + `${page.dropped > 0 ? `; ${page.dropped} left out for citing nothing the build showed` : ''}${ruleNote}.`;
    recordDossierRun(deps, { project: title, outcome: 'written', dryRun: false, detail, ...(usage ? { usage } : {}), costUsd: costUsd(),
      evidenceHash, wikiCuratedAt: generatedAt.toISOString(), runRef }, ts, Date.now() - startedMs);
    deps.recorder?.summary('entity-dossier', detail, { page: title, lines: page.kept, dropped: page.dropped, undated: page.undated,
      rule_dropped: ruleDropped, contact_withheld: contactWithheld, rules_checked: checked.ruled === true,
      memories: p.gathered.memories.rules.length + p.gathered.memories.facts.length, memories_left_out: p.gathered.memories.omitted,
      output_revision_id: receipt.output_revision_id }, false);
    return { outcome: 'written', page_title: title, detail, node_id: receipt.output_node_id, output_revision_id: receipt.output_revision_id,
      lines: page.kept, dropped: page.dropped, rule_dropped: ruleDropped, cost_usd: costUsd() };
  } catch (error) {
    // Release what the capture reserved; an Engine that can't answer leaves it to the lease.
    await capture?.fail();
    // A failed call's usage adds to what the build's earlier call spent (the rule check follows the page).
    if (error instanceof StructuredCallFailure && error.usage !== undefined) usage = plusUsage(usage, error.usage);
    const outcome = isBudgetRefusal(error) && !isShutdownRefusal(error) ? 'skipped_budget' as const : 'error' as const;
    const detail = failureDetail(error, capture);
    recordDossierRun(deps, { project: title, outcome, dryRun: false, detail, ...(usage ? { usage } : {}), costUsd: costUsd(),
      ...(evidenceHash ? { evidenceHash } : {}), wikiCuratedAt: null, runRef }, ts, Date.now() - startedMs);
    deps.recorder?.summary('entity-dossier', `Dossier "${title}" not written: ${detail}`, { page: title, outcome }, false);
    return { outcome, page_title: title, detail, cost_usd: costUsd() };
  } finally {
    deps.recorder?.setContext(null);
    // The build ended, written or not: nothing for a restart to pick up (#722).
    if (deps.db) {
      try { finishDossierBuild(deps.db, runRef); } catch (error) { console.warn(`[curator] dossier build ${runRef} not cleared: ${message(error)}`); }
    }
  }
}

export type DossierStart =
  | { readonly dry_run: false; readonly status: 'queued' | 'in_progress'; readonly subject: ReturnType<typeof subjectOf>;
    readonly page: { readonly title: string }; readonly queued_at: string; readonly detail: string;
    readonly follow: { readonly tool: 'curator-status'; readonly arguments: { readonly project: string } } }
  | ({ readonly dry_run: false; readonly status: DossierOutcome['outcome']; readonly subject: ReturnType<typeof subjectOf> } & DossierOutcome);

/**
 * A paid build. The free checks run first, so a refusal (the note, the capture limits, an older
 * Engine, the daily cap) comes back at once and nothing is queued. The server then queues the build
 * through `BackgroundBuilds` and replies; the build reads its evidence again when its turn comes.
 * Without background builds (the CLI, tests) it runs before the call returns.
 */
export async function startDossier(deps: CoreDeps, target: DossierTarget, opts: {
  readonly rebuild?: DossierRebuild;
  /** Await the build's outcome, still tracked in background builds (the nightly phase, #714). */
  readonly wait?: boolean;
  /** Asked when the build's turn in the queue comes; false skips it (a scheduled rebuild no longer behind). */
  readonly stillWanted?: () => Promise<boolean>;
} = {}): Promise<DossierStart> {
  const subject = await resolveDossierSubject(deps, target);
  const follow = (title: string) => ({ tool: 'curator-status' as const, arguments: { project: title } });
  const existing = deps.builds?.get(dossierBuildKey(subject.id));
  if (existing) {
    return { dry_run: false, status: 'in_progress', subject: subjectOf(subject), page: { title: existing.name ?? subject.title },
      queued_at: existing.since, detail: 'A build of this dossier is already queued or running, so nothing was started. Follow it with curator-status.',
      follow: follow(existing.name ?? subject.title) };
  }
  const prepared = await prepareDossier(deps, target, new Date(), randomUUID(), subject);
  const rules = prepared.gathered.memories.rules;
  const cost = costOf(deps, prepared.request, null, rules.length > 0 ? { rules, answer: null } : null);
  let cap: DailyCap;
  try {
    cap = await dailyCapFor(deps, prepared.request.model, prepared.preview.provider, cost);
  } catch (error) {
    throw new DossierError('DAILY_BUDGET', `${budgetRefusalDetail(error)}. Nothing was queued.`);
  }
  if (cap.refusal) throw new DossierError('DAILY_BUDGET', `${cap.refusal}. Nothing was queued; build it again once there is budget.`);
  // `rebuild` sets the note's own field (#714; owner, 2026-11-21), the one a person edits by hand.
  // Manual removes it. Set before the build is queued, so it holds whatever the build's outcome.
  if (opts.rebuild !== undefined && rebuildOf(subject.node.fields?.[DOSSIER_FIELD]) !== opts.rebuild
    && !(opts.rebuild === 'manual' && fieldValue(subject.node.fields?.[DOSSIER_FIELD]) === undefined)) {
    await deps.engine.updateNodeFields(subject.id, { [DOSSIER_FIELD]: opts.rebuild === 'on-change' ? 'on-change' : null }, subject.title);
  }
  const title = prepared.page.title;
  // Recorded before it is queued (#722): a restart before its call starts it again.
  const runRef = randomUUID();
  if (deps.db) queueDossierBuild(deps.db, { runRef, nodeId: subject.id, pageTitle: title, scheduled: opts.stillWanted !== undefined });
  // Labelled by the page title, as wiki builds are by theirs: curator-status's queue.current then names
  // the build its caller follows, so a panel can tell its own build running from one queued behind (#715).
  const work = () => deps.queue.enqueue(title, async (): Promise<DossierOutcome> => {
    if (opts.stillWanted && !(await opts.stillWanted())) {
      if (deps.db) finishDossierBuild(deps.db, runRef);
      return { outcome: 'current', page_title: title, detail: `"${title}" was current by the time its turn came, so it was not rebuilt.` };
    }
    return runDossier(deps, { node_id: subject.id }, title, runRef);
  });
  if (!deps.builds) {
    const outcome = await work();
    return { dry_run: false, status: outcome.outcome, subject: subjectOf(subject), ...outcome };
  }
  let running: Promise<DossierOutcome> | undefined;
  const queued = deps.builds.start([projectBuildKey(title), dossierBuildKey(subject.id)], `dossier ${title}`, subject.id,
    () => (running = work()),
    detail => recordDossierRun(deps, { project: title, outcome: 'error', dryRun: false, detail }, new Date().toISOString(), 0), title);
  if (!queued.started && deps.db) finishDossierBuild(deps.db, runRef);
  if (opts.wait && queued.started && running) {
    const outcome = await running;
    return { dry_run: false, status: outcome.outcome, subject: subjectOf(subject), ...outcome };
  }
  return { dry_run: false, status: queued.started ? 'queued' : 'in_progress', subject: subjectOf(subject), page: { title },
    queued_at: queued.build.since,
    detail: queued.started
      ? `Queued "${title}": ${rules.length > 0 ? 'two paid calls (the page and its rule check)' : 'one paid call'} on ${prepared.policy.model}, paid from today's cap. It usually finishes within a few minutes. `
        + `Follow it with curator-status and project "${title}"; do not call again to check.`
      : 'A build of this dossier is already queued or running, so nothing was started. Follow it with curator-status.',
    follow: follow(title) };
}

/** What a restart did with the dossier builds a gone process left (#722). */
export interface DossierRecovery { readonly restarted: number; readonly reported: number }

/** Whether the page went out after `row` began publishing: its newest output then, false, or null when the Engine can't tell. */
async function publishedAfter(deps: CoreDeps, row: DossierBuildRow): Promise<{ homeId: string; outputRevisionId: string } | false | null> {
  try {
    const homeId = (await deps.engine.wikiStatus(row.nodeId)).home_node_id;
    if (homeId === null) return false;
    const read = await deps.engine.inspectProvenance({ select: 'node', node_id: homeId, limit: 1 });
    if (read.select !== 'node') return null;
    const latest = read.outputs[0];
    if (!latest) return false;
    return latest.receipt.committed_at >= row.updatedAt ? { homeId, outputRevisionId: latest.receipt.output_revision_id } : false;
  } catch (error) {
    console.warn(`[curator] dossier "${row.pageTitle}": whether its page went out could not be read: ${message(error)}`);
    return null;
  }
}

/**
 * The dossier builds a gone process left (a crash, a kill, a restart that gave up waiting). One
 * that never sent its call is started again through the live path, its free checks and the daily
 * cap included, and a scheduled one only while its note still asks for it and it is behind
 * (`scheduledRebuildWanted`; Codex, #732). One whose call may have gone out is reported as an
 * error run and in the journal, never re-run, since the call may have been paid. One cut off while
 * publishing is checked with the Engine: written (recorded, with a run that says so), not written
 * (reported like a cut-off call), or unknown (reported so the owner looks at the page). A row is
 * deleted only once its replacement is queued or its outcome recorded, so a second crash during
 * recovery leaves it for the next start (Codex, #732).
 */
export async function recoverDossierBuilds(deps: CoreDeps, log: (line: string) => void): Promise<DossierRecovery> {
  if (!deps.db) return { restarted: 0, reported: 0 };
  const db = deps.db;
  let restarted = 0;
  let reported = 0;
  const report = (row: DossierBuildRow, outcome: 'error' | 'written', detail: string, stats: Record<string, unknown>): void => {
    recordDossierRun(deps, { project: row.pageTitle, outcome, dryRun: false, detail, runRef: row.runRef }, new Date().toISOString(), 0);
    deps.recorder?.summaryWithContext({ runRef: row.runRef, trigger: 'on-demand', fn: 'entity-dossier', project: row.pageTitle },
      `Dossier "${row.pageTitle}": ${detail}`, { page: row.pageTitle, ...stats }, false);
    log(`dossier "${row.pageTitle}": ${detail}`);
  };
  const cutOffCall = 'A restart cut this build off after its model call went out: the call may have been paid, and nothing was written. '
    + 'It was not run again; build it again for the page.';
  for (const row of leftDossierBuilds(db, processAlive)) {
    if (row.state === 'queued') {
      try {
        const started = await startDossier(deps, { node_id: row.nodeId },
          row.scheduled ? { stillWanted: scheduledRebuildWanted(deps, row.nodeId) } : {});
        restarted += 1;
        log(`dossier "${row.pageTitle}": a restart cut it off before its call; started again (${started.status})`);
      } catch (error) {
        report(row, 'error', `A restart cut this build off before its model call, and starting it again was refused: ${failureDetail(error, undefined)}`,
          { outcome: 'refused' });
      }
      finishDossierBuild(db, row.runRef);
      continue;
    }
    if (row.state === 'calling') {
      report(row, 'error', cutOffCall, { outcome: 'uncertain' });
      reported += 1;
      finishDossierBuild(db, row.runRef);
      continue;
    }
    const published = await publishedAfter(deps, row);
    if (published === null) {
      report(row, 'error', 'A restart cut this build off while its page was being written, and whether it was written could not be read. '
        + 'Look at the page before building it again.', { outcome: 'unknown' });
    } else if (published) {
      recordDossierBuild(db, { nodeId: row.nodeId, pageTitle: row.pageTitle, homeId: published.homeId,
        outputRevisionId: published.outputRevisionId, builtAt: row.updatedAt, memoryTotal: null });
      report(row, 'written', 'The page was written; a restart cut off only what came after.', { outcome: 'written',
        output_revision_id: published.outputRevisionId });
    } else {
      report(row, 'error', cutOffCall, { outcome: 'uncertain' });
    }
    reported += 1;
    finishDossierBuild(db, row.runRef);
  }
  return { restarted, reported };
}
