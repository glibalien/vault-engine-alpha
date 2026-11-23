import { randomUUID } from 'node:crypto';
import { EngineError } from './engine.js';
import { MAX_EXPLICIT_SOURCE_NODE_IDS, TOPIC_WIKIS_OFF, TOPIC_WIKIS_OFF_MESSAGE, wikiPageTitleOwner, type CoreDeps } from './core.js';
import { vaultOf } from './config.js';
import { projectWikiRoots, topicWikiRoots } from './db/wiki-roots.js';
import { isPaused } from './db/control.js';
import { explicitTopicRefreshSources } from './db/topic-refresh.js';
import { StructuredCallFailure } from './llm/types.js';
import type { EngineNode } from './types.js';
import {
  bindWikiStageClient, resolveConfiguredWikiStage, type ResolvedWikiStagePolicy,
} from './wiki-output-policy.js';
import {
  buildTopicInferenceRequest, sanitizeTopicInference, wikiTitleKey, type TopicCandidate, type TopicConfidence,
} from './prompts/topic-inference.js';

/** Below this much note text (whitespace collapsed) there is too little to infer a topic from. */
export const MIN_NOTE_TEXT_CHARS = 80;

export interface ProposeTopicWikiArgs {
  nodeId: string;
  dryRun: boolean;
}

/** An existing wiki the proposed topic names. */
export interface ExistingWikiMatch {
  title: string;
  kind: 'topic' | 'project';
  /** 'title': the proposed topic and this title are the same name, loosely compared (then no create is offered);
   *  'model': the model judged them the same subject under different names. */
  matched_by: 'title' | 'model';
  paused: boolean;
  /** Topic wikis only: their source mode and current explicit sources. */
  source?: 'vault' | 'vault+web';
  source_node_ids?: string[];
  note_is_source?: boolean;
}

/** create-or-update-wiki arguments, ready to send once the user agrees. */
export interface CreateOrUpdateWikiCall {
  topic: string;
  brief?: string;
  source?: 'vault+web';
  source_node_ids?: string[];
  add_source_node_ids?: string[];
  paused?: true;
}

type Failure = { ok: false; error: { code: string; message: string } };
export type ProposeTopicWikiResponse =
  | { ok: true; dry_run: true; node: { id: string; title: string }; model: string; detail: string }
  | {
    ok: true;
    dry_run: false;
    node: { id: string; title: string };
    topic: string;
    brief: string;
    confidence: TopicConfidence;
    alternatives: TopicCandidate[];
    existing_wiki: ExistingWikiMatch | null;
    /** create: a new paused topic wiki from this note; add_source: this note added to the matched topic wiki. */
    next: { create?: CreateOrUpdateWikiCall; add_source?: CreateOrUpdateWikiCall };
    model: string;
    detail: string;
  }
  | Failure;

function fail(code: string, message: string): Failure {
  return { ok: false, error: { code, message } };
}

function fieldValue(node: EngineNode, key: string): unknown {
  const raw = node.fields?.[key];
  return raw !== null && typeof raw === 'object' && 'value' in raw ? (raw as { value: unknown }).value : raw;
}

interface RegisteredWiki { title: string; kind: 'topic' | 'project'; source: string }

/** Every registered wiki, topics first. */
function registeredWikis(deps: CoreDeps): RegisteredWiki[] {
  const db = deps.db!;
  return [
    ...topicWikiRoots(db).map(r => ({ title: r.root_title, kind: 'topic' as const, source: r.source })),
    ...projectWikiRoots(db).map(r => ({ title: r.root_title, kind: 'project' as const, source: r.source })),
  ];
}

/** The registered wiki a title names: the same title first, else the same name loosely compared (wikiTitleKey). */
function findWiki(wikis: readonly RegisteredWiki[], title: string): RegisteredWiki | undefined {
  const key = wikiTitleKey(title);
  if (!key) return undefined;
  return wikis.find(w => w.title === title) ?? wikis.find(w => wikiTitleKey(w.title) === key);
}

function describeMatch(deps: CoreDeps, wiki: RegisteredWiki, matchedBy: 'title' | 'model', nodeId: string): ExistingWikiMatch {
  const db = deps.db!;
  const base = { title: wiki.title, kind: wiki.kind, matched_by: matchedBy, paused: isPaused(db, wiki.title) };
  if (wiki.kind === 'project') return base;
  const sourceNodeIds = explicitTopicRefreshSources(db, wiki.title).map(row => row.node_id);
  return { ...base, source: wiki.source === 'vault+web' ? 'vault+web' : 'vault', source_node_ids: sourceNodeIds,
    note_is_source: sourceNodeIds.includes(nodeId) };
}

/** A closed, caller-safe description of a failed model call. */
function callFailure(error: unknown): Failure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^(DAILY_BUDGET_[A-Z_]+|PROVIDER_SPEND_LIMIT|CURATOR_SHUTTING_DOWN)$/.test(code)) {
    return fail(code, `${error instanceof Error ? error.message : code}. No topic was proposed and nothing was created.`);
  }
  // A projected provider failure says only its closed reason; anything else (a missing provider key) is the Curator's own message.
  const reason = error instanceof StructuredCallFailure ? (error.reason ? ` (${error.reason})` : '')
    : error instanceof Error && error.message ? `: ${error.message.slice(0, 300)}` : '';
  return fail('INFERENCE_FAILED', `The model call failed${reason}. No topic was proposed and nothing was created.`);
}

function guidance(existing: ExistingWikiMatch | null, next: { create?: unknown; add_source?: unknown },
  nodeId: string, topicIsNoteTitle: boolean): string {
  const confirm = 'Show the topic and brief to the user to accept or edit before anything is created.';
  const create = next.create
    ? ' To create it, call create-or-update-wiki with next.create, using the agreed topic and brief: it builds once now, then stays paused and changes only on request.'
    : '';
  const sameName = topicIsNoteTitle
    ? ' The topic is this note\'s own title, and a topic wiki gets a note of its own, so a new wiki needs another name: offer an alternative or agree a fuller name with the user.'
      + ` Then call create-or-update-wiki with that topic, the brief, source "vault+web", source_node_ids ["${nodeId}"] and paused:true.`
    : existing?.matched_by === 'title'
      ? ` A new wiki can't share the name of "${existing.title}"; to create one anyway, agree a different topic with the user.` : '';
  if (!existing) return `${confirm}${create}${sameName}`;
  if (existing.kind === 'project') {
    return `${confirm} The topic matches the project wiki "${existing.title}", which is built from its project's own notes and takes no listed sources.`
      + (create ? `${create} Creating it makes a separate topic wiki beside that project wiki.` : sameName);
  }
  const add = existing.note_is_source ? ` This note is already a source of the topic wiki "${existing.title}".`
    : next.add_source
      ? ` Offer adding this note as a source of the topic wiki "${existing.title}" instead: create-or-update-wiki with next.add_source, which keeps its current sources and rebuilds it once (paid).`
      : ` The topic wiki "${existing.title}" already has the maximum ${MAX_EXPLICIT_SOURCE_NODE_IDS} sources, so this note can't be added without removing one.`;
  return `${confirm}${add}${create ? `${create} A new wiki would sit beside "${existing.title}".` : sameName}`;
}

/**
 * Propose a topic wiki from one note: the subject it implies, a brief, a confidence, alternatives,
 * and any registered wiki it matches. One model call on the wiki planning model (none with dry_run),
 * recorded under the topic-inference purpose and admitted by the daily budget. Writes nothing:
 * the caller confirms with the user, then creates through create-or-update-wiki.
 * Runs outside the curation queue, so it never waits behind a sweep; its usage is scoped to this call.
 */
export async function proposeTopicWiki(deps: CoreDeps, args: ProposeTopicWikiArgs): Promise<ProposeTopicWikiResponse> {
  if (!deps.db) return fail('NO_DB', 'propose-topic-wiki requires the curator DB (server mode)');
  // No topic kind (none in the vault map): no topic wiki can be made, so none is proposed.
  if (vaultOf(deps.config).topicType === null) return fail(TOPIC_WIKIS_OFF, `${TOPIC_WIKIS_OFF_MESSAGE} Nothing was called or created.`);
  const nodeId = args.nodeId.trim();
  if (!nodeId) return fail('NODE_NOT_FOUND', 'node_id is blank');

  let node: EngineNode;
  try {
    node = await deps.engine.getNode(nodeId, { includeEmbeds: false });
  } catch (error) {
    if (error instanceof EngineError && error.code === 'NOT_FOUND') return fail('NODE_NOT_FOUND', `No note has the id "${nodeId}".`);
    return fail('ENGINE_UNAVAILABLE', 'Could not read the note from the Engine; nothing was called or created.');
  }
  if (node === null || typeof node !== 'object' || node.id !== nodeId) {
    return fail('ENGINE_UNAVAILABLE', 'The Engine returned a different note; nothing was called or created.');
  }
  const title = (node.title ?? '').trim();

  // A wiki page names its wiki, not a new subject: starting from one is how "<topic> Wiki Wiki" happens.
  const wikiFor = fieldValue(node, 'wiki_for');
  let owner: string | null;
  try {
    owner = await wikiPageTitleOwner(deps, title);
  } catch {
    return fail('ENGINE_UNAVAILABLE', 'Could not check whether the note is a wiki page; nothing was called or created.');
  }
  if (owner !== null || (wikiFor !== undefined && wikiFor !== null && wikiFor !== '')) {
    return fail('NODE_IS_A_WIKI_PAGE', owner !== null
      ? `"${title}" is the wiki page of "${owner}", not a note to start a topic wiki from. To change that wiki, use create-or-update-wiki with topic "${owner}".`
      : `"${title}" is a wiki page, not a note to start a topic wiki from. Start from a note the new wiki should be about.`);
  }

  const body = (node.body ?? '').replace(/\s+/g, ' ').trim();
  if (body.length < MIN_NOTE_TEXT_CHARS) {
    return fail('TOO_LITTLE_TEXT', `"${title}" has too little text to infer a topic from (${body.length} characters; `
      + `at least ${MIN_NOTE_TEXT_CHARS} are needed). Name the topic yourself and call create-or-update-wiki.`);
  }

  let wikis: RegisteredWiki[];
  let ownTopic: string | undefined;
  try {
    wikis = registeredWikis(deps);
    ownTopic = topicWikiRoots(deps.db).find(r => r.root_node_id === nodeId)?.root_title;
  } catch {
    return fail('REGISTRY_UNAVAILABLE', 'Could not read the registered wikis; nothing was called or created.');
  }
  if (ownTopic !== undefined) {
    return fail('NODE_HAS_A_WIKI', `"${title}" is the topic note of the wiki "${ownTopic}", which already exists. `
      + `To change it, use create-or-update-wiki with topic "${ownTopic}".`);
  }

  let stage: ResolvedWikiStagePolicy;
  try {
    stage = resolveConfiguredWikiStage(deps.config, deps.llm, 'planning');
  } catch (error) {
    return fail('MODEL_UNAVAILABLE', `The wiki planning model can't be used (${error instanceof Error ? error.message : 'unknown'}); `
      + 'nothing was called or created.');
  }
  const nodeRef = { id: nodeId, title };
  if (args.dryRun) {
    return { ok: true, dry_run: true, node: nodeRef, model: stage.model,
      detail: `Would make one model call on ${stage.model} to propose a topic. No call was made.` };
  }

  let output: unknown;
  try {
    const call = async () => (await bindWikiStageClient(deps.llm, stage).structuredCall(buildTopicInferenceRequest({
      model: stage.model, maxTokens: stage.maxTokens, noteTitle: title, noteBody: node.body ?? '',
      existingWikiTitles: wikis.map(w => w.title),
    }))).output;
    const usage = { project: 'topic-inference', runRef: randomUUID(), purpose: 'topic-inference' as const };
    output = deps.usage ? await deps.usage.withContext(usage, call) : await call();
  } catch (error) {
    return callFailure(error);
  }
  const inference = sanitizeTopicInference(output);
  if (!inference) {
    return fail('INFERENCE_FAILED', 'The model named no usable topic. Nothing was created; try again or name the topic yourself.');
  }

  let existing: ExistingWikiMatch | null = null;
  try {
    // Read again: a wiki may have been registered while the model ran.
    const current = registeredWikis(deps);
    const byTitle = findWiki(current, inference.topic);
    const byModel = inference.existingWiki ? findWiki(current, inference.existingWiki) : undefined;
    if (byTitle) existing = describeMatch(deps, byTitle, 'title', nodeId);
    else if (byModel) existing = describeMatch(deps, byModel, 'model', nodeId);
  } catch {
    return fail('REGISTRY_UNAVAILABLE', 'Could not read the registered wikis after the model call; nothing was created.');
  }

  // The wiki's topic note can't take this note's title: where the two paths meet, create-or-update-wiki
  // reuses this note as the root, which can't also be its source; elsewhere it makes a second note of that name.
  const noteTitle = title.toLowerCase();
  const isNoteTitle = (topic: string): boolean => noteTitle !== '' && topic.toLowerCase() === noteTitle;
  const topicIsNoteTitle = isNoteTitle(inference.topic);
  const alternatives = inference.alternatives.filter(alternative => !isNoteTitle(alternative.topic));

  const next: { create?: CreateOrUpdateWikiCall; add_source?: CreateOrUpdateWikiCall } = {};
  // A create is offered only under a name no wiki has: create-or-update-wiki would update a wiki of the
  // same title, and a near-identical title is the near-duplicate this step exists to prevent.
  if (existing?.matched_by !== 'title' && !topicIsNoteTitle) {
    next.create = { topic: inference.topic, ...(inference.brief ? { brief: inference.brief } : {}),
      source: 'vault+web', source_node_ids: [nodeId], paused: true };
  }
  if (existing?.kind === 'topic' && !existing.note_is_source
    && (existing.source_node_ids?.length ?? 0) < MAX_EXPLICIT_SOURCE_NODE_IDS) {
    next.add_source = { topic: existing.title, add_source_node_ids: [nodeId] };
  }
  return {
    ok: true, dry_run: false, node: nodeRef,
    topic: inference.topic, brief: inference.brief, confidence: inference.confidence, alternatives,
    existing_wiki: existing, next, model: stage.model,
    detail: guidance(existing, next, nodeId, topicIsNoteTitle),
  };
}
