import { PAGE_TEMPLATES } from './page-templates.js';
import { targetKey } from './stage-checkpoints.js';
import { WIKI_REWRITE_RULES, WIKI_WRITING_RULES } from './prompts/writing-rules.js';
import { withWikiCallContext } from './wiki-output-policy.js';
import type { WikiCallContext } from './llm/types.js';
import { topicCoverageNote, withTopicCoverage } from './topic-evidence-diagnostics.js';
import { fallbackTopicPageSourceIds } from './topic-evidence-selection.js';
import { callWithTopicBudget, type TopicRequestBudget, type TopicRequestBudgetContext } from './topic-request-budget.js';
import { currentDateLine, localDate, stampLog } from './date-line.js';
import { buildHomeRequest } from './home-request.js';
import { renderHomeSections } from './home-items.js';
import { assertPageMarkdown, assertSectionMarkdown, pageNarrativeContext, unescapeWikilinkQuotes } from './page-markdown.js';
import { peopleBlocks, truncate, type PeopleBlockContacts } from './evidence.js';
import { renderConflicts, type MemoryConflict } from './wiki-memories.js';
import { spanDigest } from './provenance-evidence.js';
import { hasPageObservation, pageEvidence, pageEvidenceWithMemories, pageContextNode, recordPageContext, type PageSourceSelection } from './provenance-page-evidence.js';
import type { PageCapture } from './provenance-page.js';
import { StructuredCallFailure, type LlmClient, type StructuredCallFailureReason, type StructuredCallRequest } from './llm/types.js';
import { addUsage, estimateCostByModel, estimateCostUsd, ZERO_USAGE, type PricingLookup } from './pricing.js';
import { budgetRefusalDetail, isBudgetRefusal } from './budget.js';
import { carriedRulesSection, checkPageRules, pageRules, PageRuleError, ruleBreakFeedback, rulesInSection, withoutRulesSection, withRulesSection } from './page-rules.js';
import { CURATOR_PAGE_REWRITE_SYSTEM_PROMPT, CURATOR_PAGE_SYSTEM_PROMPT, HOME_SECTIONS_SCHEMA, PAGE_SYNTHESIS_SCHEMA, PAGE_SYNTHESIS_TOOL } from './prompts/page.js';
import type { EngineNode, ExistingWiki, Memory, MemoryProposal, ProjectEvidence, NodeRef, PageSynthesisRequest, PageSynthesisResult, ThemedPageKind, TokenUsage, TopologyAction, TopologyPlan, TopologyPlanUsage, WikiCatalogPage, WikiScopeV1, WikiSections } from './types.js';

const DEFAULT_MAX_TOKENS = 4_000;

export type PageNodeReader = {
  readonly getNode: (nodeId: string, options?: { includeProvenance?: boolean }) => Promise<EngineNode>;
};

export type AcceptedPageIndexEntry = {
  readonly target: NodeRef;
  readonly title: string;
  readonly scope: WikiScopeV1;
  readonly action: TopologyAction['op'];
};

export type PageCaptureFactory = (target: NodeRef, request: Readonly<StructuredCallRequest>, selection: PageSourceSelection) =>
  Pick<PageCapture, 'onPrepared' | 'stage' | 'fail'> | Promise<Pick<PageCapture, 'onPrepared' | 'stage' | 'fail'>>;

export type AcceptedPagesSynthesisInput = {
  readonly wikiContext?: Omit<WikiCallContext, 'stage' | 'target' | 'attempt'>;
  readonly topicEvidence?: TopicRequestBudgetContext;
  readonly generatedAt?: Date;
  /** The zone the pages' dates are written in (`Config.curatorTz`); the host's when absent (#459). */
  readonly timeZone?: string;
  /** Called once per attempt at a page: a rule-driven retry calls it again for the new draft. */
  readonly captureFactory?: PageCaptureFactory;
  readonly model: string;
  readonly plan: TopologyPlan;
  readonly existingWiki: ExistingWiki;
  readonly evidenceNodes: readonly EngineNode[];
  /** The build's memories, appended to each page's evidence (#297). */
  readonly memories?: readonly Memory[];
  /** A project's people and companies with notes, and the people named without one, shown to each page (#474 idea 4). */
  readonly contacts?: ProjectEvidence['contacts'] | PeopleBlockContacts;
  /** Memory pairs nothing has settled, shown to each page (#474 idea 4). */
  readonly conflicts?: readonly MemoryConflict[];
  /** What the memory heading calls the wiki's subject; a topic's requested page says "topic" (#313). */
  readonly memorySubject?: 'project' | 'topic';
  /** Keyed by `targetKey` (`node:<id>` or `plan:<plan_key>`). */
  readonly evidenceIdsByTarget?: Readonly<Record<string, readonly string[]>>;
  /** The memories the planner marked as each page's rules on what to say, keyed like
   *  evidenceIdsByTarget (`targetKey`, #474 idea 4). A project page also keeps the rules already on it. */
  readonly ruleIdsByTarget?: Readonly<Record<string, readonly number[]>>;
  /** Check each page with rules after writing, with one retry (#474 idea 4). Full builds,
   *  single-page rebuilds and requested pages (#631) do. */
  readonly checkRules?: boolean;
  /** The client for one call at a page: a draft (`page`) or the rule check after it (`rules`), by
   *  attempt. A requested page's durable execution keys each one apart (#631). Absent: `llm`. */
  readonly callClient?: (target: NodeRef, attempt: number, call: 'page' | 'rules') => LlmClient;
  /** With checkRules: a page still breaking a rule after its retry is held (left out, and
   *  listed in `held`) instead of failing the call. A full build keeps that page as it was and
   *  writes the rest; a single-page rebuild leaves this off, so its request fails. */
  readonly holdRuleBreaks?: boolean;
  /** Reads the live memories among these ids. A rule already on a page stays while its memory is
   *  live, even when it isn't among the build's memories (a busy project's newer memories can push
   *  it out). Absent, such a rule drops; if the read fails, the page's rules section is carried as is. */
  readonly loadRuleMemories?: (ids: readonly number[]) => Promise<readonly Memory[]>;
  readonly bodyCharCap?: number | null;
  readonly maxTokens?: number;
  readonly system?: string;
  /** A checkpointed result for this target, used instead of a model call. */
  readonly reuse?: (target: NodeRef) => PageSynthesisResult | undefined;
  /** Receives each newly synthesized page once it is complete (and staged, with capture). */
  readonly onPage?: (result: PageSynthesisResult) => void;
  /** Give a page whose model output was malformed one more attempt before failing it. */
  readonly retryMalformed?: boolean;
  /** What each existing sub-page was last built from (#352). A project page the plan refreshes,
   *  with a record and notes changed since, is rewritten from its current text plus only those
   *  notes; every other page is synthesized as before. */
  readonly pageNoteStates?: ReadonlyMap<string, PageNoteBaseline>;
};

/** The notes a page was last built from: note id → content hash, and when (#352). */
export type PageNoteBaseline = { readonly builtAt: string; readonly notes: Readonly<Record<string, string>> };

/** A page left unwritten because both drafts broke a rule on what to say (#474 idea 4). */
export type HeldPage = { readonly target: NodeRef; readonly title: string; readonly detail: string };

export type AcceptedPagesSynthesisResult = {
  readonly pages: readonly PageSynthesisResult[];
  /** Pages held for breaking a rule, with holdRuleBreaks; absent when none were. */
  readonly held?: readonly HeldPage[];
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
};

export type HomeOverviewInput = {
  readonly wikiContext?: Omit<WikiCallContext, 'stage' | 'target' | 'attempt'>;
  readonly requestBudget?: TopicRequestBudget;
  readonly onPrepared?: StructuredCallRequest['onPrepared'];
  readonly generatedAt?: Date;
  /** The zone the date line and Log stamp are written in (`Config.curatorTz`); the host's when absent (#459). */
  readonly timeZone?: string;
  readonly model: string;
  readonly evidence: string;
  readonly pageIndex: readonly AcceptedPageIndexEntry[];
  readonly maxTokens?: number;
  readonly system?: string;
  /** Render Focus items as next-action checkboxes (default); a topic home has no tasks. */
  readonly focusTasks?: boolean;
};

export type HomeOverviewResult = {
  readonly usageKnown?: boolean;
  readonly validatedSections: WikiSections;
  readonly sections: WikiSections;
  readonly memories: readonly MemoryProposal[];
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
};

type SynthesisState = {
  readonly pages: ReadonlyMap<string, WikiCatalogPage>;
  readonly creates: ReadonlyMap<string, Extract<TopologyAction, { op: 'create' }>>;
  readonly mergeTargets: ReadonlySet<string>;
  readonly evidenceIds?: Readonly<Record<string, readonly string[]>>;
  readonly engine: PageNodeReader;
  readonly bodyCharCap: number | null;
};

export class PageSynthesisError extends Error {
  override readonly name = 'PageSynthesisError';

  constructor(readonly target: NodeRef, readonly detail: string, options?: ErrorOptions, readonly usage: TokenUsage = ZERO_USAGE,
    readonly usageKnown?: boolean, readonly invalidResult = false) {
    super(`Page synthesis failed for ${targetLabel(target)}: ${detail}`, options);
  }
}

export function buildPageEvidenceBlock(homeReads: readonly EngineNode[], evidenceIds: readonly string[], bodyCharCap: number | null, wikiNodeIds: ReadonlySet<string> = new Set()): string {
  return pageEvidence(homeReads, evidenceIds, bodyCharCap, wikiNodeIds);
}

export async function synthesizeAcceptedPages(
  llm: LlmClient,
  engine: PageNodeReader,
  input: AcceptedPagesSynthesisInput,
): Promise<AcceptedPagesSynthesisResult> {
  const generatedAt = new Date(input.generatedAt ?? new Date());
  const pages = new Map(input.existingWiki.subpages.map(page => [page.id, page]));
  const wikiNodeIds = new Set(pages.keys());
  if (input.existingWiki.home_id) wikiNodeIds.add(input.existingWiki.home_id);
  const creates = new Map(input.plan.actions.flatMap(action => action.op === 'create' ? [[action.plan_key, action] as const] : []));
  const mergeTargets = new Set(input.plan.actions.flatMap(action => action.op === 'merge' && 'plan_key' in action.target ? [action.target.plan_key] : []));
  const state: SynthesisState = {
    pages, creates, mergeTargets, engine, bodyCharCap: input.topicEvidence ? null : input.bodyCharCap ?? null,
    ...(input.evidenceIdsByTarget === undefined ? {} : { evidenceIds: input.evidenceIdsByTarget }),
  };
  const siblings = siblingScopes(input.plan, input.existingWiki);
  const results: PageSynthesisResult[] = [];
  const held: HeldPage[] = [];
  let totalUsage = ZERO_USAGE;

  for (const action of input.plan.actions) {
    const request = requestForAction(action, state);
    if (request === null) continue;
    const reused = input.reuse?.(request.target);
    // A checkpointed page whose rules rest on memories looked up outside the build's set isn't
    // reused: the stage fingerprint covers only that set, so one of them may have changed or
    // expired since (#474 idea 4). The page is written again instead.
    if (reused && !rulesOutsideSet(reused.body, input.memories ?? [])) {
      results.push(reused);
      continue;
    }
    // A page that breaks one of its rules gets one more attempt, told which and where (#474 idea 4).
    let ruleFeedback: string | undefined;
    // With retryMalformed, malformed output gets one more attempt at the page; any other failure ends it.
    for (let attempt = 0; ; attempt++) {
      let capture: Awaited<ReturnType<PageCaptureFactory>> | undefined;
      try {
        if (input.captureFactory && !llm.supportsPreparedCapture) throw new Error('PROVENANCE_CAPTURE_UNSUPPORTED');
        const selection: PageSourceSelection | undefined = input.captureFactory ? { generatedAt: new Date(generatedAt), items: [], omissions: [] } : undefined;
        const { context, current, mergeSources } = await actionContext(action, state, selection);
        // Every project page keeps its rules, a single-page rebuild's too; only a full build's planner marks new ones.
        const { rules, carried } = input.topicEvidence ? { rules: [], carried: null }
          : await pageRulesFor(ownIds(input.ruleIdsByTarget, targetKey(request.target)), current, mergeSources, input.memories ?? [],
            input.loadRuleMemories);
        const evidenceNodes = selection ? await observedPageEvidence(engine, input.evidenceNodes, request.evidence_ids) : input.evidenceNodes;
        const rewrite = action.op === 'refresh' && input.topicEvidence === undefined && current
          ? rewritePlan(current, input.pageNoteStates?.get(action.node_id), evidenceNodes, request.evidence_ids, wikiNodeIds, state.bodyCharCap, input.timeZone)
          : null;
        if (rewrite && selection) selection.items.push(currentPageItem(rewrite.pageBlock));
        const buildRequest = (topicEvidence?: string) => freezePageRequest({
          model: input.model,
          maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
          // A rewrite has its own prompt: under the page prompt a rewrite dropped whole sections the
          // new evidence didn't mention (#392). A page prompt override applies to full syntheses.
          system: (rewrite
            ? `${CURATOR_PAGE_REWRITE_SYSTEM_PROMPT}\n\n${WIKI_REWRITE_RULES}\n\n${currentDateLine(generatedAt, input.timeZone)}`
            : `${input.system ?? CURATOR_PAGE_SYSTEM_PROMPT}\n\n${WIKI_WRITING_RULES}\n\n${currentDateLine(generatedAt, input.timeZone)}`)
            + (ruleFeedback ? `\n\n${ruleFeedback}` : ''),
          user: JSON.stringify({
            action: action.op,
            title: request.title,
            kind: request.kind,
            template: { headings: PAGE_TEMPLATES[request.kind].headings, guidance: PAGE_TEMPLATES[request.kind].guidance },
            scope: request.scope,
            synthesis_brief: request.synthesis_brief,
            evidence: topicEvidence === undefined
              ? pageEvidenceWithMemories(evidenceNodes, rewrite ? rewrite.changedIds : request.evidence_ids, input.bodyCharCap ?? null,
                wikiNodeIds, input.memories ?? [], selection, input.memorySubject, rewrite?.prefix, rules, peopleBlocks(input.contacts),
                renderConflicts(input.conflicts ?? []))
              : (input.topicEvidence?.mandatoryEvidence ?? '') + '\n\n' + topicEvidence,
            sibling_scopes: siblings,
            ...context,
          }),
          toolName: PAGE_SYNTHESIS_TOOL.name,
          toolDescription: PAGE_SYNTHESIS_TOOL.description,
          schema: PAGE_SYNTHESIS_TOOL.schema,
          // Raw Markdown avoids escaping long narrative inside JSON strings.
          // Native Anthropic retains tool output; both paths validate below.
          openAiResponseFormat: 'page-markdown',
          malformedOutputPolicy: 'fail-closed-redacted',
        });
        const finalRequest = input.topicEvidence ? undefined : buildRequest();
        if (input.captureFactory && selection) {
          if (!finalRequest) throw new Error('TOPIC_PROVENANCE_POLICY_CONFLICT');
          capture = await input.captureFactory(request.target, finalRequest, selection);
        }
        let coverage: string | null = null;
        const pageQuery = request.scope.facet + ' ' + request.synthesis_brief;
        const selectedIds = 'evidence_ids' in action ? action.evidence_ids : undefined;
        const topicBudget: TopicRequestBudget | undefined = input.topicEvidence ? {
          context: input.topicEvidence, selectedIds: selectedIds ?? fallbackTopicPageSourceIds(input.topicEvidence.sources, pageQuery),
          query: pageQuery,
          onSelection: selection => { coverage = topicCoverageNote(selection); },
          maxBytes: input.topicEvidence.topicPageRequestMaxBytes, stage: 'page',
          target: 'node_id' in request.target ? request.target.node_id : request.target.plan_key,
          selectionFallback: !('evidence_ids' in action) || action.evidence_ids === undefined,
        } : undefined;
        const pageLlm = input.callClient?.(request.target, attempt, 'page') ?? llm;
        const { output, usage } = await callWithTopicBudget(input.wikiContext ? withWikiCallContext(pageLlm, { ...input.wikiContext, stage: 'page', attempt, target: targetLabel(request.target) }) : pageLlm, topicBudget, evidence =>
          Object.freeze({ ...(finalRequest ?? buildRequest(evidence)), ...(capture ? { onPrepared: capture.onPrepared } : {}) }));
        totalUsage = addUsage(totalUsage, usage);
        const parsed = PAGE_SYNTHESIS_SCHEMA.safeParse(output);
        if (!parsed.success) throw new PageSynthesisError(request.target, 'invalid or empty body', undefined, usage, undefined, true);
        const body = unescapeWikilinkQuotes(parsed.data.body);
        const logNote = parsed.data.log_note === undefined ? undefined : unescapeWikilinkQuotes(parsed.data.log_note);
        try { assertPageMarkdown(body, logNote); }
        catch (error) {
          throw new PageSynthesisError(request.target, error instanceof Error ? error.message : 'invalid page Markdown',
            { cause: error }, usage, undefined, true);
        }
        if (input.checkRules && rules.length > 0) {
          const checkLlm = input.callClient?.(request.target, attempt, 'rules') ?? llm;
          const check = await checkPageRules(input.wikiContext
            ? withWikiCallContext(checkLlm, { ...input.wikiContext, stage: 'page', attempt, target: `${targetLabel(request.target)}:rules` }) : checkLlm,
          // The page call's own cap, which any reasoning budget it carries already fits.
          { model: input.model, maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS, body, rules, ...(logNote ? { logNote } : {}) });
          totalUsage = addUsage(totalUsage, check.usage);
          if (check.broken.length > 0) throw new PageRuleError(check.broken);
        }
        const result: PageSynthesisResult = {
          target: request.target,
          ...(rewrite ? { rewrite: true as const } : {}),
          body: withTopicCoverage(input.topicEvidence ? body
            : carried === null ? withRulesSection(body, rules) : `${withoutRulesSection(body)}\n\n${carried}`, coverage),
          ...(logNote === undefined || logNote === '' ? {} : { log_note: logNote }),
          usage,
        };
        const binding = await capture?.stage(result);
        if (binding) result.provenance = binding;
        results.push(result);
        input.onPage?.(result);
        break;
      } catch (error) {
        await capture?.fail();
        // Provider failures may include billed usage even without a usable result.
        if (error instanceof StructuredCallFailure && error.usage !== undefined) {
          totalUsage = addUsage(totalUsage, error.usage);
        }
        // A budget refusal carries only spend figures, so it survives capture redaction.
        if (isBudgetRefusal(error)) {
          throw new PageSynthesisError(request.target, budgetRefusalDetail(error), { cause: error }, totalUsage);
        }
        if (error instanceof PageRuleError) {
          if (ruleFeedback === undefined) { ruleFeedback = ruleBreakFeedback(error.broken); continue; }
          if (input.holdRuleBreaks) { held.push({ target: request.target, title: request.title, detail: error.message }); break; }
          // Still broken, and not held: the call fails (a single-page rebuild ends failed, the page unchanged).
          throw new PageSynthesisError(request.target, error.message, { cause: error }, totalUsage, undefined, true);
        }
        if (input.retryMalformed && attempt < PAGE_MALFORMED_RETRIES && malformedPageOutput(error)) continue;
        if (input.captureFactory) {
          const detail = error instanceof StructuredCallFailure ? `structured call failed (reason=${error.reason ?? 'provider_call_failed'})`
            : error instanceof Error && error.message === 'PROVENANCE_CAPTURE_UNSUPPORTED' ? error.message : 'PROVENANCE_PAGE_FAILED';
          throw new PageSynthesisError(request.target, detail, undefined, totalUsage, undefined, error instanceof PageSynthesisError && error.invalidResult);
        }
        if (error instanceof PageSynthesisError) {
          throw new PageSynthesisError(error.target, error.detail, { cause: error }, totalUsage, error.usageKnown, error.invalidResult);
        }
        const detail = error instanceof Error ? error.message : 'unknown structured-call failure';
        throw new PageSynthesisError(request.target, detail, { cause: error }, totalUsage);
      }
    }
  }

  return { pages: results, ...(held.length > 0 ? { held } : {}), usage: totalUsage, costUsd: estimateCostUsd(input.model, totalUsage) };
}

/**
 * A project page's rules (#474 idea 4): those already on it, then on the pages merged into it, then
 * the ones the planner marked, each kept while the build still sees its memory. A build that has
 * no memories at all (its memory read failed) carries the page's rules section over as it is,
 * rather than drop every rule.
 */
async function pageRulesFor(marked: readonly number[] | undefined, current: EngineNode | undefined, mergeSources: readonly EngineNode[],
  memories: readonly Memory[], load?: (ids: readonly number[]) => Promise<readonly Memory[]>,
): Promise<{ readonly rules: readonly Memory[]; readonly carried: string | null }> {
  const narrative = (node: EngineNode | undefined): string => {
    try { return pageNarrativeContext(node?.body ?? ''); } catch { return node?.body ?? ''; }
  };
  const carry = () => ({ rules: [], carried: carriedRulesSection([current, ...mergeSources].map(narrative)) });
  if (memories.length === 0) return carry();
  const onPages = [current, ...mergeSources].flatMap(node => rulesInSection(narrative(node)));
  const known = new Set(memories.map(memory => memory.id));
  const unseen = [...new Set(onPages)].filter(id => !known.has(id));
  let pool = memories;
  if (unseen.length > 0 && load) {
    // Can't tell which are still live: keep the sections as they are rather than drop a rule.
    try { pool = [...memories, ...await load(unseen)]; } catch { return carry(); }
  }
  return { rules: pageRules([...onPages, ...(marked ?? [])], undefined, pool), carried: null };
}

/** Whether a page's rules section names a memory outside the build's memories. */
function rulesOutsideSet(body: string, memories: readonly Memory[]): boolean {
  const known = new Set(memories.map(memory => memory.id));
  return rulesInSection(body).some(id => !known.has(id));
}

/** Extra attempts for a page whose model output was malformed (wrong envelope, no text, invalid body). */
const PAGE_MALFORMED_RETRIES = 1;
const MALFORMED_OUTPUT_REASONS: ReadonlySet<StructuredCallFailureReason> = new Set(['invalid_page_envelope', 'invalid_content_type', 'empty_content']);

/** Output the page model can plausibly get right on a second try. Budget, truncation, refusal,
 *  content-filter and provider failures are not retried. */
function malformedPageOutput(error: unknown): boolean {
  if (error instanceof StructuredCallFailure) return error.reason !== undefined && MALFORMED_OUTPUT_REASONS.has(error.reason);
  return error instanceof PageSynthesisError && error.invalidResult;
}

function freezePageRequest(request: StructuredCallRequest): StructuredCallRequest {
  const frozen = structuredClone(request);
  function freeze(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(frozen);
  return frozen;
}

export async function synthesizeHomeOverview(
  llm: LlmClient,
  input: HomeOverviewInput,
): Promise<HomeOverviewResult> {
  const generatedAt = input.generatedAt ?? new Date();
  let coverage: string | null = null;
  const budget = input.requestBudget ? { ...input.requestBudget, onSelection: (selection: import('./topic-evidence-selection.js').TopicEvidenceSelection, bytes: number) => {
    coverage = topicCoverageNote(selection); input.requestBudget?.onSelection?.(selection, bytes);
  } } : undefined;
  const { output, usage, usageKnown } = await callWithTopicBudget(input.wikiContext ? withWikiCallContext(llm, { ...input.wikiContext, stage: 'home', attempt: 0 }) : llm, budget, evidence =>
    buildHomeRequest({ ...input, generatedAt, evidence: evidence === undefined ? input.evidence : input.evidence + '\n\n' + evidence }));
  const parsed = HOME_SECTIONS_SCHEMA.safeParse(output);
  if (!parsed.success) throw new PageSynthesisError({ plan_key: 'home' }, 'invalid home sections', undefined, usage, usageKnown, true);
  const { memories = [], ...homeOutput } = parsed.data;
  let sections: WikiSections;
  try {
    const rendered = renderHomeSections(homeOutput, input.focusTasks);
    sections = { ...rendered, ...Object.fromEntries(Object.entries(rendered).map(([name, content]) => [name, unescapeWikilinkQuotes(content)])) };
    for (const content of Object.values(sections)) {
      if (content !== undefined) assertSectionMarkdown(content);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid home Markdown';
    throw new PageSynthesisError({ plan_key: 'home' }, detail, { cause: error }, usage, usageKnown, true);
  }
  return {
    validatedSections: sections,
    ...(usageKnown === false ? { usageKnown: false } : {}),
    sections: { ...sections, now: withTopicCoverage(sections.now, coverage), log_entry: stampLog(sections.log_entry, generatedAt, input.timeZone) },
    memories: memories.map(memory => ({ content: memory.content, category: memory.category ?? 'fact' })),
    usage,
    costUsd: estimateCostUsd(input.model, usage),
  };
}

/** Each stage is priced with its own model; unknown pricing for any stage model makes the total unknown. */
export function accountTopologySynthesis(
  models: Readonly<Record<'planning' | 'page' | 'home', string>>,
  stages: TopologyPlanUsage,
  pricing?: PricingLookup,
): { readonly usage: TokenUsage; readonly costUsd: number | null } {
  const usage = addUsage(addUsage(stages.planner, stages.adjudicator), addUsage(stages.page, stages.home));
  return { usage, costUsd: estimateCostByModel([
    [models.planning, addUsage(stages.planner, stages.adjudicator)], [models.page, stages.page], [models.home, stages.home],
  ], pricing) };
}

function requestForAction(
  action: TopologyAction,
  state: SynthesisState,
): PageSynthesisRequest | null {
  switch (action.op) {
    case 'keep':
    case 'retire':
      return null;
    case 'refresh':
    case 'reactivate': {
      const page = requiredPage(state.pages, action.node_id);
      return request({ target: { node_id: action.node_id }, title: page.title, kind: page.wiki_kind ?? 'freeform', scope: action.scope, synthesis_brief: action.synthesis_brief }, ownIds(state.evidenceIds, targetKey({ node_id: action.node_id })));
    }
    case 'create':
      return state.mergeTargets.has(action.plan_key)
        ? null
        : request({ target: { plan_key: action.plan_key }, title: action.title, kind: action.kind, scope: action.scope, synthesis_brief: action.synthesis_brief }, ownIds(state.evidenceIds, targetKey({ plan_key: action.plan_key })));
    case 'merge': {
      const identity = targetIdentity(action.target, state.pages, state.creates);
      return request({ target: action.target, title: identity.title, kind: identity.kind, scope: action.scope, synthesis_brief: action.synthesis_brief }, ownIds(state.evidenceIds, targetKey(action.target)));
    }
    default:
      return assertNever(action);
  }
}

/** A target's own entry in a dictionary keyed by `targetKey`, never an inherited property. */
function ownIds<T>(byTarget: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return byTarget !== undefined && Object.hasOwn(byTarget, key) ? byTarget[key] : undefined;
}

function request(identity: Omit<PageSynthesisRequest, 'evidence_ids'>, evidenceIds?: readonly string[]): PageSynthesisRequest {
  return { ...identity, evidence_ids: [...(evidenceIds ?? [])] };
}

async function actionContext(
  action: TopologyAction,
  state: SynthesisState,
  selection?: PageSourceSelection,
): Promise<{ readonly context: Record<string, unknown>; readonly current?: EngineNode; readonly mergeSources: readonly EngineNode[] }> {
  if (action.op === 'refresh' || action.op === 'reactivate') {
    const current = await readPageNode(state.engine, action.node_id, selection !== undefined);
    recordPageContext(selection, 'current_target', [current], state.bodyCharCap);
    return { context: { current_target: pageContextNode(current, state.bodyCharCap) }, current, mergeSources: [] };
  }
  if (action.op !== 'merge') return { context: {}, mergeSources: [] };
  const currentTarget = 'node_id' in action.target
    ? await readPageNode(state.engine, action.target.node_id, selection !== undefined)
    : undefined;
  const sources = [];
  for (const sourceId of action.sources) {
    requiredPage(state.pages, sourceId);
    sources.push(await readPageNode(state.engine, sourceId, selection !== undefined));
  }
  if (currentTarget) recordPageContext(selection, 'current_target', [currentTarget], state.bodyCharCap);
  recordPageContext(selection, 'merge_sources', sources, state.bodyCharCap);
  return { context: {
    ...(currentTarget === undefined ? {} : { current_target: pageContextNode(currentTarget, state.bodyCharCap) }),
    merge_sources: sources.map(node => pageContextNode(node, state.bodyCharCap)),
    source_files_remain_historical: true,
  }, ...(currentTarget === undefined ? {} : { current: currentTarget }), mergeSources: sources };
}

/**
 * Whether a note reads as it did when the page was built: its record is the note's text hash, or
 * its content hash when recorded before text hashes (#332) or carried forward by the link sweep.
 * A note the Engine gives neither hash for counts as changed.
 */
function unchangedSince(baseline: PageNoteBaseline, node: EngineNode): boolean {
  const recorded = baseline.notes[node.id];
  if (recorded === undefined) return false;
  const { text_hash: textHash, content_hash: contentHash } = node.metadata ?? {};
  return (!!textHash && recorded === textHash) || (!!contentHash && recorded === contentHash);
}

/**
 * A bounded rewrite of an existing page (#352), or null for a full synthesis. Rewritten: a page
 * with a record of the notes it was last built from, at least one of the build's notes new or
 * changed since, and current text that reaches the writer whole (a page cut by `bodyCharCap`
 * would lose what was cut). Its evidence is the CURRENT PAGE, then only the changed notes.
 */
export function rewritePlan(current: EngineNode, baseline: PageNoteBaseline | undefined, nodes: readonly EngineNode[],
  ids: readonly string[], wikiIds: ReadonlySet<string>, cap: number | null, timeZone?: string,
): { readonly pageBlock: string; readonly prefix: string; readonly changedIds: readonly string[] } | null {
  if (!baseline) return null;
  // The rules section is code's, written again after every build (#474 idea 4).
  const page = withoutRulesSection(pageNarrativeContext(current.body ?? '')).trim();
  if (page === '' || truncate(page, cap) !== page) return null;
  const selected = ids.length > 0 ? new Set(ids) : null;
  const changedIds = nodes
    .filter(node => !wikiIds.has(node.id) && (selected === null || selected.has(node.id)))
    .filter(node => !unchangedSince(baseline, node))
    .map(node => node.id);
  if (changedIds.length === 0) return null;
  const built = Date.parse(baseline.builtAt);
  const builtOn = Number.isFinite(built) ? localDate(built, timeZone) : baseline.builtAt.slice(0, 10);
  const pageBlock = `CURRENT PAGE (as last built on ${builtOn}: the evidence for everything it already says; keep each section and entry no changed note changes)\n${page}`;
  return { pageBlock, changedIds,
    prefix: `${pageBlock}\n\nCHANGED NOTES (the project's notes that changed since then, or that the page wasn't built from: the sources for any change)\n\n` };
}

/** With capture, the CURRENT PAGE block is generated context: the page's own text, from earlier builds. */
function currentPageItem(pageBlock: string): PageSourceSelection['items'][number] {
  const end = Buffer.byteLength(pageBlock);
  const spans = [{ field: 'evidence', start: 0, end }];
  return { key: 'evidence:0', observation: null, role: 'generated_context', upstream_derivation_id: null,
    selection: 'rewrite-current-page:v1', spans, original_bytes: null, retained_bytes: end,
    input_digest: spanDigest(spans, { evidence: pageBlock }), truncated: false, origin: 'opaque' };
}

async function readPageNode(engine: PageNodeReader, id: string, tracked: boolean): Promise<EngineNode> {
  const node = tracked ? await engine.getNode(id, { includeProvenance: true }) : await engine.getNode(id);
  if (tracked && (node.id !== id || !hasPageObservation(node))) throw new Error('PROVENANCE_OBSERVATION_MISSING');
  return node;
}

async function observedPageEvidence(engine: PageNodeReader, nodes: readonly EngineNode[], ids: readonly string[]): Promise<readonly EngineNode[]> {
  const selected = new Set(ids);
  const result: EngineNode[] = [];
  for (const node of nodes) {
    if (ids.length && !selected.has(node.id)) { result.push(node); continue; }
    let current = node;
    // Re-read the complete body and token together, at most three times. An
    // older body is never paired with observations from an independent read.
    for (let attempt = 0; !hasPageObservation(current) && attempt < 3; attempt++) {
      current = await engine.getNode(node.id, { includeProvenance: true });
      if (current.id !== node.id) throw new Error('PROVENANCE_OBSERVATION_MISSING');
    }
    if (!hasPageObservation(current)) throw new Error('PROVENANCE_OBSERVATION_MISSING');
    result.push(current);
  }
  return result;
}

function siblingScopes(plan: TopologyPlan, wiki: ExistingWiki): readonly { readonly title: string; readonly scope: WikiScopeV1; readonly summary?: string }[] {
  const planned = new Map<string, WikiScopeV1>();
  for (const action of plan.actions) {
    if ('node_id' in action) planned.set(action.node_id, action.scope);
  }
  return [
    ...wiki.subpages.flatMap(page => {
      const scope = planned.get(page.id) ?? page.wiki_scope;
      return scope === undefined ? [] : [{ title: page.title, scope, ...(page.summary === undefined ? {} : { summary: page.summary }) }];
    }),
    ...plan.actions.flatMap(action => action.op === 'create' ? [{ title: action.title, scope: action.scope }] : []),
  ];
}

function targetIdentity(
  target: NodeRef,
  pages: ReadonlyMap<string, WikiCatalogPage>,
  creates: ReadonlyMap<string, Extract<TopologyAction, { op: 'create' }>>,
): { readonly title: string; readonly kind: ThemedPageKind } {
  if ('node_id' in target) {
    const page = requiredPage(pages, target.node_id);
    return { title: page.title, kind: page.wiki_kind ?? 'freeform' };
  }
  const create = creates.get(target.plan_key);
  if (create === undefined) throw new PageSynthesisError(target, 'missing accepted create target');
  return { title: create.title, kind: create.kind };
}

function requiredPage(pages: ReadonlyMap<string, WikiCatalogPage>, nodeId: string): WikiCatalogPage {
  const page = pages.get(nodeId);
  if (page === undefined) throw new PageSynthesisError({ node_id: nodeId }, 'target is absent from accepted catalog');
  return page;
}

function targetLabel(target: NodeRef): string {
  return 'node_id' in target ? target.node_id : target.plan_key;
}

function assertNever(value: never): never {
  throw new PageSynthesisError({ plan_key: 'unknown' }, `unsupported action ${JSON.stringify(value)}`);
}
