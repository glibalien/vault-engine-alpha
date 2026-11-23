import { useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type {
  ProvenanceInspectRequest,
  ProvenanceInspectData,
  ProvenanceInputMetadata,
  Issue,
  Envelope,
} from '@vault/query-core';
import { useVizClient } from './viz-client-context.js';
import {
  emptyRead,
  type InspectorTarget,
  type InspectionPage,
  type ReadState,
} from './provenance-inspector.js';

/** The build a selected build replaced, loaded only to say what changed between them. */
export type PreviousBuild = {
  outputId: string;
  inputs: ProvenanceInputMetadata[];
  /** False when the previous build has more inputs than the bounded read loads. */
  complete: boolean;
};
/** A short retained excerpt (a memory line or one evidence block) shown inline. */
export type Snippet = {
  loading: boolean;
  text: string | null;
  more: boolean;
  error: string | null;
};
type State = {
  capability: 'loading' | 'ready' | 'unsupported' | 'error';
  capabilityError: string | null;
  namespace: string | null;
  history: ReadState<InspectionPage<'node'>>[];
  outputPages: ReadState<InspectionPage<'output'>>[];
  text: ReadState<InspectionPage<'input_text'>>;
  previous: ReadState<PreviousBuild>;
  snippets: Record<string, Snippet>;
  rebuildEligible: boolean;
  /** The wiki this build belongs to, which can be rebuilt as a whole. */
  rebuildProject: string | null;
  /** The registered wiki the note belongs to, as a page of it or as its root note (#545). */
  wiki: PageWiki | null;
  /** Whether the note names a wiki root in `wiki_for`; null until get-node answers, or when it can't. */
  wikiPage: boolean | null;
  /** Whether the wiki lookup has finished, found or not. */
  wikiChecked: boolean;
  /** The host's FindWiki failed (Curator unreachable, say), so whether the note has a wiki is unknown. */
  wikiLookupFailed: boolean;
  /** The dossier the note is, or the one its person or company has (#554), when no wiki is registered for it. */
  dossier: PageDossier | null;
  /** Writing the subject note's `dossier` field from the panel's switch. */
  dossierRebuildBusy: boolean;
  dossierRebuildError: string | null;
  selectedOutputId: string | null;
  selectedInputId: string | null;
};
const initial = (): State => ({
  capability: 'loading',
  capabilityError: null,
  namespace: null,
  history: [],
  outputPages: [],
  text: emptyRead(),
  previous: emptyRead(),
  snippets: {},
  rebuildEligible: false,
  rebuildProject: null,
  wiki: null,
  wikiPage: null,
  wikiChecked: false,
  wikiLookupFailed: false,
  dossier: null,
  dossierRebuildBusy: false,
  dossierRebuildError: null,
  selectedOutputId: null,
  selectedInputId: null,
});
/** The wiki roots a page names in `wiki_for`, from get-node's resolved relationships. */
function wikiRoots(node: unknown): string[] {
  const owners = (node as { relationships?: { outgoing?: Record<string, unknown> } } | null)?.relationships?.outgoing?.wiki_for;
  if (!Array.isArray(owners)) return [];
  return [...new Set(owners.map((o) => (o as { target_id?: unknown } | null)?.target_id)
    .filter((id): id is string => typeof id === 'string' && id !== ''))];
}
/** A registered wiki, by its name: a project or topic wiki. */
export type RecordlessWiki = { name: string; kind: 'topic' | 'project' };
/** Which registered wiki has this root note, or null. */
export type FindWiki = (root: { title: string; nodeId: string }) => Promise<RecordlessWiki | null>;
/** The states a wiki home's `wiki_status` takes (#547). */
export const WIKI_HOME_STATUSES = ['current', 'behind', 'paused', 'paused-behind', 'building', 'failed'] as const;
export type WikiHomeStatus = typeof WIKI_HOME_STATUSES[number];
/** The wiki a note belongs to (#545), found with get-node and the host's FindWiki. */
export type PageWiki = RecordlessWiki & {
  /** The wiki's root note: its project or topic note. */
  rootId: string;
  /** The wiki's home page: the page whose `wiki_for` names the root and which has no `wiki_parent`.
   *  Null when there is none yet. */
  homeId: string | null;
  /** The home's `wiki_status`, which the Engine and the Curator write; null when it has none. */
  homeStatus: WikiHomeStatus | null;
  /** What the note is to the wiki: its home, another of its pages, or its root note. */
  role: 'home' | 'page' | 'root';
};
/** What kind of note a person's or company's note is, for its dossier (#554): the host reads the vault
 *  map. `label` names the kind as the panel shows it ("Person", "Vendor"). */
export type NoteKind = { kind: 'person' | 'company' | 'other'; label: string };
/** The note's kind when it can have a dossier: one of the vault map's entity kinds but its project kind,
 *  and not a wiki page. Null for any other note. */
export type DossierKind = (types: readonly string[]) => NoteKind | null;
/** How a dossier is kept: the subject note's own `dossier` field (#714). */
export type DossierRebuild = 'manual' | 'on-change';
/** A dossier (#554): one page about a person or a company, a wiki home whose root is their note and
 *  which no wiki is registered for. Found with get-node, as a wiki is. */
export type PageDossier = {
  /** The note shown is the dossier page itself, or the person's or company's own note. */
  role: 'page' | 'subject';
  subjectId: string;
  subjectTitle: string;
  kind: NoteKind;
  /** The dossier page; null when the note has none yet. */
  pageId: string | null;
  pageTitle: string | null;
  /** The page's `wiki_status`, which the Curator writes as it checks the dossier (current or behind). */
  homeStatus: WikiHomeStatus | null;
  rebuild: DossierRebuild;
};
/** `on-change` (any case, spaces around it) asks for nightly rebuilds; anything else is manual, as the Curator reads it. */
export function dossierRebuildOf(field: unknown): DossierRebuild {
  const raw = fieldValue(field);
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'on-change' ? 'on-change' : 'manual';
}
function typesOf(node: unknown): string[] {
  const types = (node as { types?: unknown } | null)?.types;
  return Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string') : [];
}
/** A wiki sub-page names its parent page in `wiki_parent`; a home names none. */
function hasWikiParent(node: unknown): boolean {
  const n = node as { fields?: Record<string, unknown>; relationships?: { outgoing?: Record<string, unknown> } } | null;
  const parents = n?.relationships?.outgoing?.wiki_parent;
  return (Array.isArray(parents) && parents.length > 0) || fieldValue(n?.fields?.wiki_parent) != null;
}
/** A get-node field's value: `{ value, type, source }`, or the bare value. */
function fieldValue(field: unknown): unknown {
  return field !== null && typeof field === 'object' && 'value' in field ? (field as { value: unknown }).value : field;
}
/** The pages whose `wiki_for` names this root note, from its incoming relationships. */
function wikiPagesOf(root: unknown): Array<{ id: string; title: string | null }> {
  const pages = (root as { relationships?: { incoming?: Record<string, unknown> } } | null)?.relationships?.incoming?.wiki_for;
  if (!Array.isArray(pages)) return [];
  const seen = new Set<string>();
  return pages.flatMap((p) => {
    const { source_id: id, source_title: title } = (p ?? {}) as { source_id?: unknown; source_title?: unknown };
    if (typeof id !== 'string' || !id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title: typeof title === 'string' ? title : null }];
  });
}
/** At most this many of a root's wiki pages are read to find its home. */
const HOME_CANDIDATE_READS = 25;
function homeStatusOf(node: unknown): WikiHomeStatus | null {
  const value = fieldValue((node as { fields?: Record<string, unknown> } | null)?.fields?.wiki_status);
  return (WIKI_HOME_STATUSES as readonly unknown[]).includes(value) ? value as WikiHomeStatus : null;
}
/** Input pages are read 100 at a time; at most this many load without a click. */
export const INPUT_PAGE_SIZE = 100;
export const AUTO_INPUT_PAGES = 5;
const SNIPPET_BYTES = 4096;
const SNIPPET_CONCURRENCY = 4;
class InspectionReadError extends Error {
  constructor(readonly error: Extract<Envelope<unknown>, { ok: false }>['error']) {
    super(error.message);
  }
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Inspection read failed';
const erased = (error: unknown) =>
  /PROVENANCE_(REVOKED|UNAVAILABLE)/.test(message(error));

export function useProvenanceInspector({
  target,
  connectionKey,
  hasInspectionTool,
  expectedNamespace,
  preferredOutputId,
  checkRebuild = false,
  findWiki,
  dossierKind,
}: {
  target: InspectorTarget | null;
  connectionKey: number;
  hasInspectionTool: boolean;
  expectedNamespace?: string;
  preferredOutputId?: string;
  /** Ask Engine whether the selected build can be rebuilt on demand. */
  checkRebuild?: boolean;
  /** For a page with no build records, ask which registered wiki it belongs to (#425, #544). */
  findWiki?: FindWiki;
  /** Which notes can have a dossier, by their kinds (#554). Without it, no dossier is looked for. */
  dossierKind?: DossierKind;
}) {
  const client = useVizClient();
  // Read when needed, so a new function on each render doesn't restart the inspection.
  const wikiLookup = useRef(findWiki);
  wikiLookup.current = findWiki;
  const kindLookup = useRef(dossierKind);
  kindLookup.current = dossierKind;
  const [, render] = useReducer((n) => n + 1, 0);
  const session = useMemo(
    () => ({
      state: initial(),
      alive: false,
      namespaceRejected: false,
      epoch: 0,
      outputEpoch: 0,
      textEpoch: 0,
      previousEpoch: 0,
      snippetEpoch: 0,
      rebuildEpoch: 0,
      wikiEpoch: 0,
      cursors: [] as (string | undefined)[],
      textIndex: 0,
    }),
    [
      client,
      target,
      connectionKey,
      hasInspectionTool,
      expectedNamespace,
      preferredOutputId,
      checkRebuild,
      !!findWiki,
    ],
  );
  const notify = () => {
    if (session.alive) render();
  };
  const valid = (epoch: number) => session.alive && session.epoch === epoch;
  const clearText = () => {
    session.textEpoch++;
    session.cursors = [];
    session.textIndex = 0;
    session.state.text = emptyRead();
    session.state.selectedInputId = null;
  };
  /** Forget everything derived from the selected build besides its input pages. */
  const clearDerived = () => {
    session.previousEpoch++;
    session.snippetEpoch++;
    session.rebuildEpoch++;
    session.state.previous = emptyRead();
    session.state.snippets = {};
    session.state.rebuildEligible = false;
  };
  async function read<S extends ProvenanceInspectData['select']>(
    request: ProvenanceInspectRequest & { select: S },
  ): Promise<{ data: InspectionPage<S>; warnings: Issue[] }> {
    const env = await client.inspectProvenance(request);
    if (!env.ok) throw new InspectionReadError(env.error);
    const data = env.data;
    if (!data || data.select !== request.select)
      throw Error('Invalid inspection response');
    if (
      data.select === 'node' &&
      (!Array.isArray(data.outputs) ||
        data.outputs.some((o) => o.receipt?.output_node_id !== target?.nodeId))
    )
      throw Error('Invalid node history');
    if (
      data.select === 'output' &&
      'output_revision_id' in request &&
      (data.output?.receipt?.output_revision_id !==
        request.output_revision_id ||
        data.output.receipt.output_node_id !== target?.nodeId ||
        !Array.isArray(data.inputs))
    )
      throw Error('Invalid output response');
    if (
      data.select === 'input_text' &&
      request.select === 'input_text' &&
      'input_id' in request &&
      (data.output_revision_id !== request.output_revision_id ||
        data.input_id !== request.input_id ||
        !Array.isArray(data.segments))
    )
      throw Error('Invalid input response');
    return { data: data as InspectionPage<S>, warnings: env.warnings ?? [] };
  }
  const success = <T>(data: T, warnings: Issue[]): ReadState<T> => ({
    data,
    warnings,
    loading: false,
    error: null,
    stale: false,
    readAt: new Date().toISOString(),
  });
  async function loadOutput(id: string, append = false) {
    const epoch = session.epoch;
    const old = session.state.outputPages;
    const cursor = append ? old.at(-1)?.data?.next_cursor : undefined;
    if (append && (!cursor || old.some((p) => p.loading))) return;
    const outputEpoch = ++session.outputEpoch;
    const index = append ? old.length : 0;
    const page: ReadState<InspectionPage<'output'>> = {
      ...emptyRead(),
      loading: true,
    };
    session.state.outputPages = append
      ? [...old.map((p) => ({ ...p, error: null })), page]
      : [page];
    notify();
    try {
      const result = await read({
        select: 'output',
        output_revision_id: id,
        include_comparisons: true,
        limit: INPUT_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (
        !valid(epoch) ||
        outputEpoch !== session.outputEpoch ||
        session.state.selectedOutputId !== id
      )
        return;
      if (result.data.output.availability !== 'retained') {
        clearText();
        clearDerived();
        session.state.outputPages = [success(result.data, result.warnings)];
      } else {
        session.state.outputPages[index] = success(
          result.data,
          result.warnings,
        );
        if (!append) {
          void loadPrevious(
            id,
            result.data.output.receipt.replaces_output_revision_id ?? null,
          );
          if (checkRebuild) void loadRebuildEligibility(id);
        }
        // Read the whole input list (bounded) so counts and "nothing changed"
        // describe the build rather than whichever page happened to load.
        if (result.data.next_cursor && index + 1 < AUTO_INPUT_PAGES) {
          notify();
          void loadOutput(id, true);
          return;
        }
      }
    } catch (error) {
      if (
        !valid(epoch) ||
        outputEpoch !== session.outputEpoch ||
        session.state.selectedOutputId !== id
      )
        return;
      clearText();
      if (erased(error)) clearDerived();
      if (append && !erased(error)) {
        // Keep the last successful page's cursor available for a bounded retry.
        session.state.outputPages = old.map((p, i) =>
          i === old.length - 1 ? { ...p, error: message(error) } : p,
        );
      } else
        session.state.outputPages[index] = {
          ...page,
          loading: false,
          error: message(error),
          ...(erased(error)
            ? {}
            : {
                data: old[index]?.data ?? null,
                readAt: old[index]?.readAt ?? null,
                stale: !!old[index]?.data,
              }),
        };
    }
    notify();
  }
  async function loadHistory(append = false, preserve = false) {
    if (!target || session.state.capability !== 'ready') return;
    const epoch = session.epoch,
      old = session.state.history;
    const cursor = append ? old.at(-1)?.data?.next_cursor : undefined;
    if (append && (!cursor || old.some((p) => p.loading))) return;
    const index = append ? old.length : 0;
    const page: ReadState<InspectionPage<'node'>> = {
      ...emptyRead(),
      loading: true,
    };
    session.state.history = append
      ? [...old.map((p) => ({ ...p, error: null })), page]
      : [page];
    notify();
    try {
      const result = await read({
        select: 'node',
        node_id: target.nodeId,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      if (!valid(epoch)) return;
      session.state.history[index] = success(result.data, result.warnings);
      const selectedErased = result.data.outputs.find(
        (output) =>
          output.receipt.output_revision_id ===
            session.state.selectedOutputId &&
          output.availability !== 'retained',
      );
      if (selectedErased) {
        clearText();
        clearDerived();
        session.outputEpoch++;
        session.state.outputPages = [];
        if (append) void loadOutput(selectedErased.receipt.output_revision_id);
      }
      if (!append) {
        session.wikiEpoch++;
        if (!preserve) {
          session.state.wiki = null;
          session.state.dossier = null;
          session.state.wikiPage = null;
          session.state.wikiChecked = false;
        }
        void loadWiki();
        const selected = preserve ? session.state.selectedOutputId : null;
        session.state.selectedOutputId =
          selected ??
          preferredOutputId ??
          result.data.outputs[0]?.receipt.output_revision_id ??
          null;
        if (session.state.selectedOutputId)
          void loadOutput(session.state.selectedOutputId);
        else session.state.outputPages = [];
      }
    } catch (error) {
      if (!valid(epoch)) return;
      clearText();
      if (
        append &&
        cursor &&
        error instanceof InspectionReadError &&
        error.error.code === 'INVALID_PARAMS' &&
        error.error.details?.reason === 'PROVENANCE_LIMIT'
      ) {
        // This fixed-size node request previously succeeded without a cursor.
        // Discard the rejected continuation and restart once. A cursorless
        // failure takes the normal error path; other reads keep their retries.
        refresh();
        return;
      }
      if (append) {
        session.state.history = old.map((p, i) =>
          i === old.length - 1 ? { ...p, error: message(error) } : p,
        );
      } else
        session.state.history[index] = {
          ...page,
          data: old[index]?.data ?? null,
          readAt: old[index]?.readAt ?? null,
          stale: !!old[index]?.data,
          loading: false,
          error: message(error),
        };
    }
    notify();
  }
  async function discover(preserve = false) {
    if (session.namespaceRejected) return;
    const epoch = session.epoch;
    if (!hasInspectionTool) {
      session.state.capability = 'unsupported';
      notify();
      return;
    }
    try {
      const { data } = await read({ select: 'status' });
      if (!valid(epoch)) return;
      if (typeof data.vault_namespace !== 'string' || !data.vault_namespace)
        throw Error('Invalid vault identity');
      if (
        (expectedNamespace && expectedNamespace !== data.vault_namespace) ||
        (session.state.namespace &&
          session.state.namespace !== data.vault_namespace)
      ) {
        clearText();
        clearDerived();
        session.state = initial();
        session.namespaceRejected = true;
        session.state.capability = 'error';
        session.state.capabilityError =
          'Engine vault changed. Inspect the current note again.';
        notify();
        return;
      }
      session.state.namespace = data.vault_namespace;
      session.state.capability = [
        'output_input_comparisons_v1',
        'input_text_v1',
      ].every((f) => data.inspection_features?.includes(f))
        ? 'ready'
        : 'unsupported';
      session.state.capabilityError = null;
      notify();
      if (session.state.capability === 'ready')
        await loadHistory(false, preserve);
    } catch (error) {
      if (!valid(epoch)) return;
      clearText();
      clearDerived();
      session.state.capability = 'error';
      session.state.capabilityError = message(error);
      notify();
    }
  }
  async function loadText(cursor: string | undefined, index: number) {
    const output = session.state.selectedOutputId,
      input = session.state.selectedInputId;
    if (!output || !input) return;
    const epoch = session.epoch,
      textEpoch = ++session.textEpoch;
    session.state.text = { ...emptyRead(), loading: true };
    notify();
    try {
      const result = await read({
        select: 'input_text',
        output_revision_id: output,
        input_id: input,
        max_bytes: 16384,
        ...(cursor ? { cursor } : {}),
      });
      if (!valid(epoch) || textEpoch !== session.textEpoch) return;
      if (result.data.availability !== 'retained') {
        clearText();
        session.state.text = success(result.data, result.warnings);
        void loadOutput(output);
      } else {
        session.state.text = success(result.data, result.warnings);
        session.textIndex = index;
        session.cursors[index] = cursor;
      }
    } catch (error) {
      if (!valid(epoch) || textEpoch !== session.textEpoch) return;
      session.cursors = [];
      session.textIndex = 0;
      session.state.text = { ...emptyRead(), error: message(error) };
      if (erased(error)) {
        session.textEpoch++;
        void loadOutput(output);
      }
    }
    notify();
  }
  async function loadPrevious(currentId: string, previousId: string | null) {
    const epoch = session.epoch,
      previousEpoch = ++session.previousEpoch;
    const current = () =>
      valid(epoch) &&
      previousEpoch === session.previousEpoch &&
      session.state.selectedOutputId === currentId;
    if (!previousId) {
      session.state.previous = emptyRead();
      return;
    }
    session.state.previous = { ...emptyRead(), loading: true };
    notify();
    const inputs: ProvenanceInputMetadata[] = [];
    let cursor: string | undefined;
    let complete = false;
    try {
      for (let page = 0; page < AUTO_INPUT_PAGES; page++) {
        const result = await read({
          select: 'output',
          output_revision_id: previousId,
          limit: INPUT_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        if (!current()) return;
        inputs.push(...result.data.inputs);
        cursor = result.data.next_cursor ?? undefined;
        if (!cursor) {
          complete = true;
          break;
        }
      }
      session.state.previous = success(
        { outputId: previousId, inputs, complete },
        [],
      );
    } catch (error) {
      if (!current()) return;
      session.state.previous = { ...emptyRead(), error: message(error) };
    }
    notify();
  }
  async function loadRebuildEligibility(id: string) {
    const epoch = session.epoch,
      rebuildEpoch = ++session.rebuildEpoch;
    session.state.rebuildEligible = false;
    session.state.rebuildProject = null;
    try {
      const { data } = await read({
        select: 'refresh_target',
        output_revision_id: id,
      });
      if (!valid(epoch) || rebuildEpoch !== session.rebuildEpoch) return;
      session.state.rebuildEligible =
        data.output_revision_id === id && data.eligible === true;
      session.state.rebuildProject = data.output_revision_id === id ? data.project_title : null;
    } catch {
      // An Engine without on-demand rebuild simply never offers it.
      return;
    }
    notify();
  }
  /** The home a root note has: a page naming it in `wiki_for` with no `wiki_parent`, as Engine finds it,
   *  whatever its title. The usual title is read first, so a home kept under it costs one read. */
  async function findHome(root: unknown & { id: string }, usual: string, current: () => boolean): Promise<unknown | null | undefined> {
    const candidates = wikiPagesOf(root)
      .filter((c) => c.id !== target?.nodeId)
      .sort((a, b) => Number(b.title === usual) - Number(a.title === usual))
      .slice(0, HOME_CANDIDATE_READS);
    for (const candidate of candidates) {
      const found = await client.getNode({ node_id: candidate.id, include_embeds: false }).catch(() => null);
      if (!current()) return undefined;
      if (found?.ok && wikiRoots(found.data).includes(root.id) && !hasWikiParent(found.data)) return found.data;
    }
    return null;
  }
  /** Which wiki the note belongs to (#545): the one its `wiki_for` names, for a page of a wiki, or the one
   *  registered with the note itself as root. The host's FindWiki asks Curator, by the root's title, and
   *  the home's status is read from the home page, `<name> Wiki`. Build records aren't needed: a topic
   *  wiki's pages keep none (#425), and a project wiki's home has none before its first build (#544).
   *  With no wiki registered for it, a home whose root is a person's or company's note is that note's
   *  dossier (#554), as the Curator's remove-dossier tells one: the note is the dossier's subject. */
  async function loadWiki() {
    if (!target) return;
    const find = wikiLookup.current;
    const epoch = session.epoch,
      wikiEpoch = session.wikiEpoch;
    const current = () => valid(epoch) && wikiEpoch === session.wikiEpoch;
    let wikiPage: boolean | null = null;
    let wiki: PageWiki | null = null;
    let dossier: PageDossier | null = null;
    let lookupFailed = false;
    try {
      const page = await client.getNode({ node_id: target.nodeId, include_embeds: false });
      if (!current() || !page.ok) return;
      const roots = wikiRoots(page.data);
      wikiPage = roots.length > 0;
      if (!find) return;
      let root: { id: string; title: string | null };
      let role: PageWiki['role'];
      if (roots.length === 1) {
        const found = await client.getNode({ node_id: roots[0]!, include_embeds: false });
        if (!current() || !found.ok) return;
        root = found.data;
        role = hasWikiParent(page.data) ? 'page' : 'home';
      } else if (roots.length === 0) {
        root = page.data;
        role = 'root';
      } else return;
      if (!root.title) return;
      let registered: RecordlessWiki | null;
      try {
        registered = await find({ title: root.title, nodeId: root.id });
      } catch {
        lookupFailed = true;
        return;
      }
      if (!current()) return;
      if (!registered) {
        const kind = role === 'page' ? null : kindLookup.current?.(typesOf(root)) ?? null;
        if (!kind) return;
        const home = role === 'home' ? page.data : await findHome(root, `${root.title} Dossier`, current);
        if (home === undefined) return;
        const h = home as { id: string; title: string | null } | null;
        dossier = {
          role: role === 'home' ? 'page' : 'subject',
          subjectId: root.id,
          subjectTitle: root.title,
          kind,
          pageId: h?.id ?? null,
          pageTitle: h ? (h.title ?? null) : null,
          homeStatus: h ? homeStatusOf(h) : null,
          rebuild: dossierRebuildOf((root as { fields?: Record<string, unknown> }).fields?.dossier),
        };
        return;
      }
      const home = role === 'home' ? page.data : await findHome(root, `${registered.name} Wiki`, current);
      if (home === undefined) return;
      wiki = {
        ...registered,
        rootId: root.id,
        homeId: home ? (home as { id: string }).id : null,
        homeStatus: home ? homeStatusOf(home) : null,
        role,
      };
    } catch {
      // No Curator, an older one, or an Engine that can't say: nothing to offer.
    } finally {
      if (current()) {
        session.state.wiki = wiki;
        session.state.dossier = dossier;
        session.state.wikiPage = wikiPage;
        session.state.wikiLookupFailed = lookupFailed;
        session.state.wikiChecked = true;
        notify();
      }
    }
  }
  /** Turn nightly rebuilds on or off with the subject note's own `dossier` field (#714), through Engine's
   *  update-node: its dry run first, then the write. The note changes, so the dossier reads as behind on
   *  it until its next build, and the panel reads it all again to say so; the rebuild dialog sets the
   *  field as part of a build instead. */
  async function setDossierRebuild(on: boolean) {
    const dossier = session.state.dossier;
    if (!dossier || session.state.dossierRebuildBusy) return;
    const epoch = session.epoch;
    const set_fields = { dossier: on ? 'on-change' : null };
    session.state.dossierRebuildBusy = true;
    session.state.dossierRebuildError = null;
    notify();
    try {
      const preview = await client.updateNode({ node_id: dossier.subjectId, set_fields, dry_run: true });
      if (!preview.ok) throw Error(preview.error.message);
      if (!valid(epoch)) return;
      const written = await client.updateNode({ node_id: dossier.subjectId, set_fields, dry_run: false });
      if (!written.ok) throw Error(written.error.message);
      if (!valid(epoch) || session.state.dossier?.subjectId !== dossier.subjectId) return;
      session.state.dossier = { ...session.state.dossier, rebuild: on ? 'on-change' : 'manual' };
      session.state.dossierRebuildBusy = false;
      // The note is one of the dossier's sources: read its build's comparisons again, as Check again does.
      refresh();
    } catch (error) {
      if (valid(epoch)) session.state.dossierRebuildError = `Couldn’t change it: ${message(error).replace(/\.$/, '')}.`;
    } finally {
      if (valid(epoch)) {
        session.state.dossierRebuildBusy = false;
        notify();
      }
    }
  }
  async function loadSnippets(ids: readonly string[]) {
    const output = session.state.selectedOutputId;
    if (!output) return;
    const epoch = session.epoch,
      snippetEpoch = session.snippetEpoch;
    const current = () =>
      valid(epoch) &&
      snippetEpoch === session.snippetEpoch &&
      session.state.selectedOutputId === output;
    const todo = ids.filter((id) => {
      const known = session.state.snippets[id];
      return !known || (!known.loading && known.error);
    });
    if (todo.length === 0) return;
    const pending: Snippet = { loading: true, text: null, more: false, error: null };
    session.state.snippets = {
      ...session.state.snippets,
      ...Object.fromEntries(todo.map((id) => [id, pending])),
    };
    notify();
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++]!;
        let snippet: Snippet;
        try {
          const { data } = await read({
            select: 'input_text',
            output_revision_id: output,
            input_id: id,
            max_bytes: SNIPPET_BYTES,
          });
          snippet =
            data.availability === 'retained'
              ? {
                  loading: false,
                  text: data.segments.map((s) => s.text).join('\n'),
                  more: !!data.next_cursor,
                  error: null,
                }
              : {
                  loading: false,
                  text: null,
                  more: false,
                  error: `Saved text is ${data.availability}.`,
                };
        } catch (error) {
          if (!current()) return;
          if (erased(error)) {
            // The capture was erased mid-read: drop every excerpt and reload
            // the build so its availability is shown instead of stale text.
            clearDerived();
            void loadOutput(output);
            notify();
            return;
          }
          snippet = { loading: false, text: null, more: false, error: message(error) };
        }
        if (!current()) return;
        session.state.snippets = { ...session.state.snippets, [id]: snippet };
        notify();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SNIPPET_CONCURRENCY, todo.length) }, worker),
    );
  }
  useLayoutEffect(() => {
    session.alive = true;
    void discover();
    return () => {
      session.alive = false;
      session.epoch++;
      session.textEpoch++;
      clearDerived();
      session.state = initial();
      session.cursors = [];
    };
  }, [session]);
  const selectOutput = (id: string) => {
    clearText();
    clearDerived();
    session.state.selectedOutputId = id;
    session.state.outputPages = [];
    void loadOutput(id);
    notify();
  };
  function refresh() {
    if (session.namespaceRejected) return;
    session.epoch++;
    clearText();
    clearDerived();
    // A switch write still in flight belongs to the epoch this replaces: its finally won't clear busy.
    session.state.dossierRebuildBusy = false;
    session.state.dossierRebuildError = null;
    session.state.capability = 'loading';
    session.state.capabilityError = null;
    session.state.history = [];
    session.state.outputPages = [];
    notify();
    void discover(true);
  }
  return {
    ...session.state,
    refresh,
    loadOlder: () => {
      void loadHistory(true);
    },
    selectOutput,
    selectLatest: () => {
      const id =
        session.state.history[0]?.data?.outputs[0]?.receipt.output_revision_id;
      if (id) selectOutput(id);
    },
    loadMoreInputs: () => {
      if (session.state.selectedOutputId)
        void loadOutput(session.state.selectedOutputId, true);
    },
    selectInput: (id: string | null) => {
      clearText();
      session.state.selectedInputId = id;
      notify();
      if (id) void loadText(undefined, 0);
    },
    nextText: () => {
      const cursor = session.state.text.data?.next_cursor;
      if (cursor && !session.state.text.loading)
        void loadText(cursor, session.textIndex + 1);
    },
    previousText: () => {
      if (session.textIndex > 0 && !session.state.text.loading)
        void loadText(
          session.cursors[session.textIndex - 1],
          session.textIndex - 1,
        );
    },
    canPreviousText: session.textIndex > 0,
    loadSnippets: (ids: readonly string[]) => {
      void loadSnippets(ids);
    },
    setDossierRebuild: (on: boolean) => {
      void setDossierRebuild(on);
    },
    /** Read the wiki and its home's status again, keeping what is shown until the answer comes. */
    reloadWiki: () => {
      session.wikiEpoch++;
      void loadWiki();
    },
  };
}
