import type {
  DossierApi, DossierCheck, DossierStart,
  TopicProposal, TopicProposalCheck, TopicWikiApi, TopicWikiArgs, TopicWikiMatch, TopicWikiStart,
  WikiControlApi, WikiCreateApi, WikiCreateCheck, WikiCreateRefusal, WikiCreateStart,
  WikiRebuildApi, WikiRebuildCheck, WikiRebuildRun, WikiRebuildStart, WikiRebuildStatus,
} from '@vault/query-core';
import { connectEngine, EngineTransportError, type EngineConnection } from '../engine/transport.js';

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const nullableNumber = (v: unknown): boolean => v === null || typeof v === 'number';

function run(v: unknown): v is WikiRebuildRun {
  return object(v) && typeof v.id === 'number' && typeof v.ts === 'string' && typeof v.outcome === 'string'
    && (v.error === null || typeof v.error === 'string') && nullableNumber(v.cost_usd);
}
function queue(v: unknown): boolean {
  return v === undefined || (object(v) && typeof v.running === 'boolean' && typeof v.depth === 'number'
    && (v.current === undefined || typeof v.current === 'string'));
}
function statusData(v: unknown): WikiRebuildStatus {
  if (!object(v) || typeof v.project !== 'string' || typeof v.paused !== 'boolean'
    || (v.in_progress !== null && !(object(v.in_progress) && typeof v.in_progress.since === 'string'))
    || !object(v.models) || !['planning', 'page', 'home'].every(k => typeof (v.models as Record<string, unknown>)[k] === 'string')
    || (v.latest_run !== null && !run(v.latest_run)) || (v.last_written !== null && !run(v.last_written))
    || !object(v.daily_budget) || !nullableNumber(v.daily_budget.cap_usd) || !nullableNumber(v.daily_budget.remaining_usd)
    || !queue(v.queue))
    throw Error('Update Curator to rebuild a whole wiki from here.');
  return v as unknown as WikiRebuildStatus;
}
/** The one result for the project named, from a curate-project-wiki report. */
function onlyResult(v: unknown): Record<string, unknown> {
  const result = object(v) && Array.isArray(v.results) ? v.results[0] : null;
  if (!object(result) || typeof result.outcome !== 'string') throw Error('Invalid rebuild response');
  return result;
}
function checkData(v: unknown): WikiRebuildCheck {
  if (object(v) && v.status === 'in_progress') return { in_progress: true };
  const result = onlyResult(v);
  return { in_progress: false, outcome: result.outcome as string, detail: typeof result.detail === 'string' ? result.detail : null,
    evidence_unchanged: result.evidence_unchanged === true };
}
function startData(v: unknown): WikiRebuildStart {
  if (object(v) && (v.status === 'queued' || v.status === 'in_progress')) return { status: v.status };
  const result = onlyResult(v);
  return { status: 'refused', detail: typeof result.detail === 'string' ? result.detail : `It can't be rebuilt (${String(result.outcome)}).` };
}

/** A Curator refusal: `{ ok: false, error: { code, message } }`. */
function createRefusal(v: unknown): WikiCreateRefusal | null {
  if (!object(v) || v.ok !== false || !object(v.error) || typeof v.error.code !== 'string') return null;
  return { status: 'refused', code: v.error.code, message: typeof v.error.message === 'string' ? v.error.message : '' };
}
/** A create-project-wiki reply. `first_build` is "queued" or "in_progress" for a build behind the
 *  reply, null when none is needed (and on dry runs), or the build's result when the Curator
 *  answered it at once (a paused wiki). */
function createReply(v: unknown): { project: string; project_id: string | null; created: boolean; home_created: boolean; first_build: unknown } {
  if (!object(v) || v.ok !== true || typeof v.project !== 'string' || (v.project_id !== null && typeof v.project_id !== 'string')
    || typeof v.created !== 'boolean' || typeof v.home_created !== 'boolean'
    || !(v.first_build === null || v.first_build === 'queued' || v.first_build === 'in_progress'
      || (object(v.first_build) && typeof v.first_build.outcome === 'string')))
    throw Error('Invalid create response');
  return { project: v.project, project_id: v.project_id, created: v.created, home_created: v.home_created, first_build: v.first_build };
}
type ProjectWikiEntry = { project: string; root_node_id: string | null };
/** A dry run's answer. A registration it found but didn't create is either current, or held under
 *  the old title of a renamed project, which only the live call moves; the project wikis say which. */
async function createCheckData(v: unknown, projectWikis: () => Promise<ProjectWikiEntry[]>): Promise<WikiCreateCheck> {
  const reply = createReply(v);
  if (reply.first_build === 'in_progress') return { status: 'in_progress' };
  if (reply.created) return { status: 'ready', home_missing: reply.home_created };
  const wikis = await projectWikis();
  if (wikis.some(w => w.project === reply.project)) return { status: 'exists' };
  const old = reply.project_id === null ? undefined : wikis.find(w => w.root_node_id === reply.project_id);
  return old ? { status: 'renamed', from: old.project } : { status: 'exists' };
}
function createStartData(v: unknown): WikiCreateStart {
  const { created, first_build: first } = createReply(v);
  if (first === 'queued' || first === 'in_progress') return { status: first };
  if (first === null) return created ? { status: 'registered' } : { status: 'exists' };
  const result = first as Record<string, unknown>;
  return { status: 'not_started', outcome: result.outcome as string, detail: typeof result.detail === 'string' ? result.detail : null };
}
/** The project wikis the Curator keeps, from its full status. */
function projectWikiEntries(v: unknown): ProjectWikiEntry[] {
  if (!object(v) || !Array.isArray(v.project_wikis) || !v.project_wikis.every(w => object(w) && typeof w.project === 'string'))
    throw Error('Update Curator to create a project wiki from here.');
  return v.project_wikis.map(w => {
    const entry = w as Record<string, unknown>;
    return { project: entry.project as string, root_node_id: typeof entry.root_node_id === 'string' ? entry.root_node_id : null };
  });
}

const OLD_CURATOR = 'Update Curator to make a topic wiki from a note.';
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** Ready create-or-update-wiki arguments from a proposal, passed on as the Curator gave them. */
function topicArgs(v: unknown): TopicWikiArgs | undefined {
  if (v === undefined) return undefined;
  if (!object(v) || !nonBlank(v.topic)) throw Error(OLD_CURATOR);
  return v as TopicWikiArgs;
}
function topicMatch(v: unknown): TopicWikiMatch | null {
  if (v === null) return null;
  if (!object(v) || !nonBlank(v.title) || (v.kind !== 'topic' && v.kind !== 'project')
    || (v.matched_by !== 'title' && v.matched_by !== 'model') || typeof v.paused !== 'boolean') throw Error(OLD_CURATOR);
  return { title: v.title, kind: v.kind, matched_by: v.matched_by, paused: v.paused,
    ...(typeof v.note_is_source === 'boolean' ? { note_is_source: v.note_is_source } : {}) };
}
/** A propose-topic-wiki reply: its dry run's model, or the proposal. */
function topicCheckData(v: unknown): TopicProposalCheck {
  if (!object(v) || v.ok !== true || v.dry_run !== true || !nonBlank(v.model)) throw Error(OLD_CURATOR);
  return { status: 'ready', model: v.model };
}
function topicProposalData(v: unknown): TopicProposal {
  if (!object(v) || v.ok !== true || v.dry_run !== false || !nonBlank(v.topic) || typeof v.brief !== 'string'
    || !['high', 'medium', 'low'].includes(v.confidence as string) || !Array.isArray(v.alternatives) || !object(v.next))
    throw Error(OLD_CURATOR);
  const create = topicArgs(v.next.create), addSource = topicArgs(v.next.add_source);
  return {
    status: 'proposed', topic: v.topic, brief: v.brief, confidence: v.confidence as TopicProposal['confidence'],
    alternatives: v.alternatives.filter((a): a is Record<string, unknown> => object(a) && nonBlank(a.topic))
      .map(a => ({ topic: a.topic as string, brief: typeof a.brief === 'string' ? a.brief : '' })),
    existing_wiki: topicMatch(v.existing_wiki),
    next: { ...(create ? { create } : {}), ...(addSource ? { add_source: addSource } : {}) },
  };
}
/** A create-or-update-wiki reply. The server queues a build ("queued", or "in_progress" when one of the
 *  wiki is already queued); any other outcome was answered at once. */
function topicStartData(v: unknown): TopicWikiStart {
  if (!object(v) || v.ok !== true || typeof v.created !== 'boolean' || typeof v.outcome !== 'string')
    throw Error('Invalid create response');
  if (v.outcome === 'queued' || v.outcome === 'in_progress') return { status: v.outcome, created: v.created };
  return { status: 'answered', created: v.created, outcome: v.outcome, detail: typeof v.detail === 'string' ? v.detail : null };
}

const numberOrNull = (v: unknown): number | null => typeof v === 'number' ? v : null;

/** A build-dossier dry run (#715): what would be read, the page, the cost and today's cap. */
function dossierCheckData(v: unknown): DossierCheck {
  if (!object(v) || v.ok !== true || v.dry_run !== true || !object(v.page) || typeof v.page.title !== 'string'
    || !object(v.reads) || !object(v.reads.memories) || !object(v.cost) || !object(v.daily_budget) || !object(v.model) || !object(v.subject))
    throw Error('Update Curator to build a dossier from here.');
  const { page, reads, cost, daily_budget: budget, model, subject } = v;
  const memories = reads.memories as Record<string, unknown>;
  return {
    status: 'ready', page_title: page.title as string, action: page.action === 'rebuild' ? 'rebuild' : 'create',
    subject_kind: subject.kind === 'company' ? 'company' : 'person',
    reads: { memories: numberOrNull(memories.about), memories_shown: numberOrNull(memories.shown) ?? 0,
      past: numberOrNull(memories.past) ?? 0, rules: numberOrNull(memories.rules) ?? 0,
      notes: numberOrNull(reads.notes) ?? 0, meetings: numberOrNull(reads.meetings) ?? 0, read_in_full: numberOrNull(reads.read_in_full) ?? 0 },
    // A Curator before #716 names no sections: the dialog then leaves the list out.
    sections: object(v.sections) && Array.isArray(v.sections.names) ? v.sections.names.filter((n): n is string => typeof n === 'string') : [],
    model: typeof model.ref === 'string' ? model.ref : 'the home model',
    calls: numberOrNull(cost.calls) ?? 1, estimated_usd: numberOrNull(cost.estimated_usd), worst_case_usd: numberOrNull(cost.worst_case_usd),
    fits: budget.fits === true, refusal: typeof budget.refusal === 'string' ? budget.refusal : null,
    remaining_usd: numberOrNull(budget.remaining_usd), cap_usd: numberOrNull(budget.cap_usd),
    rebuild: object(v.rebuild) && v.rebuild.current === 'on-change' ? 'on-change' : 'manual',
  };
}
/** A live build-dossier reply: queued (or already in flight), or answered at once with its outcome. */
function dossierStartData(v: unknown): DossierStart {
  if (!object(v) || v.ok !== true || v.dry_run !== false || typeof v.status !== 'string') throw Error('Invalid dossier response');
  const title = object(v.page) && typeof v.page.title === 'string' ? v.page.title : typeof v.page_title === 'string' ? v.page_title : '';
  if (v.status === 'queued' || v.status === 'in_progress') return { status: v.status, page_title: title };
  return { status: 'answered', page_title: title, outcome: v.status, detail: typeof v.detail === 'string' ? v.detail : '' };
}

/** A set-wiki-paused reply: `{ ok: true, project, paused, … }`. */
function pausedData(v: unknown): { paused: boolean } {
  if (!object(v) || v.ok !== true || typeof v.paused !== 'boolean') throw Error('Update Curator to pause a wiki from here.');
  return { paused: v.paused };
}

/** Lazy Curator-only transport for whole-wiki builds, rebuilding one, creating one, and pausing or
 *  resuming one, on the tools an AI caller also has. */
export function makeWikiRebuildClient(input: { endpoint: string; token: string; connect?: typeof connectEngine }):
{ api: WikiRebuildApi; create: WikiCreateApi; topic: Omit<TopicWikiApi, 'note'>; control: WikiControlApi; dossier: DossierApi;
  projectWikis(): Promise<string[]>; close(): Promise<void> } {
  let connection: EngineConnection | null = null;
  let connecting: Promise<EngineConnection> | null = null;
  let closed = false;
  const connect = async (): Promise<EngineConnection> => {
    if (closed) throw Error('Rebuild connection closed');
    if (!input.token?.trim()) throw Error('Configure a Curator token with curate:read and curate:trigger.');
    if (connection) return connection;
    connecting ??= (input.connect ?? connectEngine)(input.endpoint, input.token)
      .then(conn => { connection = conn; return conn; })
      .finally(() => { connecting = null; });
    return connecting;
  };
  /** The tool's parsed reply, and whether the Curator marked it an error. */
  const reply = async (name: string, args: Record<string, unknown>): Promise<{ body: unknown; isError: boolean }> => {
    const conn = await connect();
    let result: Awaited<ReturnType<EngineConnection['call']>>;
    try {
      result = await conn.call({ name, arguments: args });
    } catch (error) {
      if (error instanceof EngineTransportError && connection === conn) {
        connection = null;
        void conn.close().catch(() => {});
      }
      throw error;
    }
    const block = result.content.find(c => c.type === 'text');
    let body: unknown;
    try { body = block?.type === 'text' ? JSON.parse(block.text) : null; } catch { throw Error('Invalid rebuild response'); }
    return { body, isError: result.isError === true };
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { body, isError } = await reply(name, args);
    if (isError) throw Error('Curator refused the request');
    return body;
  };
  /** A tool whose refusals are answers to show, not failures. */
  const refusable = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { body, isError } = await reply(name, args);
    const refused = createRefusal(body);
    if (refused) return refused;
    if (isError) throw Error('Curator refused the request');
    return body;
  };
  const isRefusal = (v: unknown): v is WikiCreateRefusal => object(v) && v.status === 'refused';
  const status = async (project: string) => statusData(await call('curator-status', { project }));
  const projectWikis = async () => projectWikiEntries(await call('curator-status', { limit: 1, window_hours: 1 }));
  return {
    api: {
      status,
      check: async project => checkData(await call('curate-project-wiki', { project, dry_run: true, force: true })),
      start: async project => startData(await call('curate-project-wiki', { project, force: true })),
    },
    create: {
      status,
      check: async ref => { const v = await refusable('create-project-wiki', { project: ref, dry_run: true }); return isRefusal(v) ? v : createCheckData(v, projectWikis); },
      start: async ref => { const v = await refusable('create-project-wiki', { project: ref }); return isRefusal(v) ? v : createStartData(v); },
    },
    topic: {
      status,
      check: async nodeId => { const v = await refusable('propose-topic-wiki', { node_id: nodeId, dry_run: true }); return isRefusal(v) ? v : topicCheckData(v); },
      propose: async nodeId => { const v = await refusable('propose-topic-wiki', { node_id: nodeId }); return isRefusal(v) ? v : topicProposalData(v); },
      start: async args => { const v = await refusable('create-or-update-wiki', args); return isRefusal(v) ? v : topicStartData(v); },
    },
    dossier: {
      status,
      check: async nodeId => { const v = await refusable('build-dossier', { node_id: nodeId, dry_run: true }); return isRefusal(v) ? v : dossierCheckData(v); },
      start: async (nodeId, rebuild) => { const v = await refusable('build-dossier', { node_id: nodeId, dry_run: false, ...(rebuild ? { rebuild } : {}) }); return isRefusal(v) ? v : dossierStartData(v); },
    },
    control: {
      status,
      setPaused: async (project, paused) => pausedData(await call('set-wiki-paused', { project, paused })),
    },
    projectWikis: async () => (await projectWikis()).map(w => w.project),
    close: async () => { closed = true; const conn = connection; connection = null; await conn?.close().catch(() => {}); },
  };
}
