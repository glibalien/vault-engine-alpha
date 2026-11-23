import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthConfig, ServerFactory } from './transport/http.js';
import type { CoreDeps } from './core.js';
import { ServerLifecycle } from './server-lifecycle.js';
import { vaultOf } from './config.js';
import type { ScopedExtra, ToolHandler } from './auth/with-scope.js';
import { curateProjectWikiInput, makeCurateProjectWikiHandler } from './tools/curate-project-wiki.js';
import { curatorStatusInput, makeCuratorStatusHandler } from './tools/curator-status.js';
import { curatorCostReportInput, makeCuratorCostReportHandler } from './tools/curator-cost-report.js';
import { requestWikiPageInput, makeRequestWikiPageHandler } from './tools/request-wiki-page.js';
import {
  setWikiPausedInput, makeSetWikiPausedHandler,
  addWikiCorrectionInput, makeAddWikiCorrectionHandler,
  resolveWikiCorrectionInput, makeResolveWikiCorrectionHandler,
} from './tools/wiki-control.js';
import { createOrUpdateWikiInput, makeCreateOrUpdateWikiHandler } from './tools/create-or-update-wiki.js';
import { proposeTopicWikiInput, makeProposeTopicWikiHandler } from './tools/propose-topic-wiki.js';
import { removeWikiInput, makeRemoveWikiHandler } from './tools/remove-wiki.js';
import { createProjectWikiInput, makeCreateProjectWikiHandler } from './tools/create-project-wiki.js';
import { FILL_FIELDS_DESCRIPTION, FILL_FIELDS_TOOL, fillFieldsInput, makeFillFieldsHandler } from './tools/fill-fields.js';
import { TYPE_NOTES_DESCRIPTION, TYPE_NOTES_TOOL, typeNotesInput, makeTypeNotesHandler } from './tools/type-notes.js';
import {
  GUESS_MEMORY_SUBJECTS_DESCRIPTION, GUESS_MEMORY_SUBJECTS_TOOL, guessMemorySubjectsInput, makeGuessMemorySubjectsHandler,
} from './tools/guess-memory-subjects.js';
import {
  EXTRACT_MEMORIES_DESCRIPTION, EXTRACT_MEMORIES_TOOL, extractMemoriesInput, makeExtractMemoriesHandler,
} from './tools/extract-memories.js';
import { reconcileWikiPagesInput, makeReconcileWikiPagesHandler } from './tools/reconcile-wiki-pages.js';
import { BUILD_DOSSIER_DESCRIPTION, BUILD_DOSSIER_TOOL, buildDossierInput, makeBuildDossierHandler } from './tools/build-dossier.js';
import { REMOVE_DOSSIER_DESCRIPTION, REMOVE_DOSSIER_TOOL, makeRemoveDossierHandler, removeDossierInput } from './tools/remove-dossier.js';
import { previewHomeRefreshInput, refreshProjectHomeInput, homeRefreshStatusInput,
  makePreviewHomeRefreshHandler, makeRefreshProjectHomeHandler, makeHomeRefreshStatusHandler } from './tools/home-refresh.js';

/**
 * Assembles the transport's AuthConfig from an open curator DB and the
 * validated OAuth env. Boot order before calling this: openCuratorDb →
 * createAuthSchema → runMigrations.
 */
export function buildAuthConfig(
  db: Database.Database,
  ownerPassword: string,
  issuerUrl: URL,
): AuthConfig {
  return { db, ownerPassword, issuerUrl };
}

/**
 * A stub MCP server with one trivial `ping` tool, for transport tests: it exercises the
 * OAuth + bearer + /mcp path without the real curator tools. Production uses the real
 * factory below.
 */
export function stubServerFactory(): ServerFactory {
  return () => {
    const server = new McpServer({ name: 'vault-curator', version: '0.1.0' });
    server.registerTool(
      'ping',
      {
        description: 'Stub tool for transport tests: returns "pong".',
        inputSchema: {},
      },
      async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
    );
    return server;
  };
}

/**
 * The real curator MCP server: registers curate-project-wiki (curate:trigger).
 * Replaces stubServerFactory as the production factory; the transport is unchanged.
 *
 * `depsProvider` is invoked fresh for every tool call (spec: behavioral settings
 * are fetched before every on-demand run) — handler factories are cheap closures,
 * and `depsProvider` never throws (its settings client falls back to last-known
 * on an engine hiccup), so this wrapper never rejects on a settings-fetch failure.
 */
/**
 * create-project-wiki's description. It names the vault map's wiki request field (`wikiFlagField`)
 * and, with that field none, says nothing about asking from the note.
 */
export function createProjectWikiDescription(field: string | null): string {
  const fromNote = field === null ? '' : `A person can ask for the same thing by setting ${field}: true on the project note, and so can an AI caller with the Engine's update-node: the Curator checks for that field every 15 minutes and registers the wiki through this same path (refusals go in the Curator journal). Removing the field does nothing. `;
  return 'Start keeping a wiki for a project note. Project wikis exist only when requested: this registers the project (scheduled sweeps maintain registered wikis only while curator-status reports wiki_reconciliation_mode "live") and creates an empty home page with live task sections when none exists (free). It then queues the first curation and replies at once with first_build "queued": the wiki usually fills in within a few minutes, within the daily budget. If the budget is spent, or the wiki was already paused (answered at once as skipped), the first build does not run and the empty home stays: build it later with curate-project-wiki and force, which leaves a paused wiki paused. curator-status shows the outcome. Do not call again to check; a repeat call while that build is queued or running replies first_build "in_progress" and starts nothing. Idempotent: re-calling for an existing wiki just confirms it. Use dry_run to see what would happen. '
    + `${fromNote}To stop maintaining a project wiki use remove-wiki; to pause it use set-wiki-paused. Requires the curate:trigger scope.`;
}

/** remove-wiki's description: it names the wiki request field it clears, or none when there is none. */
export function removeWikiDescription(field: string | null): string {
  const clears = field === null ? '' : `On a project wiki it also removes ${field}: true from the project note (best-effort; wiki_field says whether it did), so the Curator doesn't register the wiki again. `;
  return 'Stop curating a topic or project wiki — deregister it so the nightly sweep skips it for good. Also clears that wiki\'s pause flag, standing corrections, and page requests. Use this, not set-wiki-paused, when a wiki was created by mistake or is finished for good; pausing leaves the registration in place. Takes the topic or project title exactly as listed in curator-status — not the "<title> Wiki" page title. Does NOT delete the wiki pages from the vault; the response names the pages left behind so they can be deleted deliberately. '
    + `${clears}Requires the curate:trigger scope.`;
}

/**
 * The MCP server factory. Each session gets a fresh server, so a description that names a vault
 * map field reads it as last known (`wikiFlagField`, from the last settings fetch).
 */
export function curatorServerFactory(depsProvider: () => Promise<CoreDeps>, startedAt: Date,
  homeRefreshDeps: () => Promise<CoreDeps> = depsProvider,
  lifecycle = new ServerLifecycle(),
  wikiFlagField: () => string | null = () => vaultOf({}).wikiFlagField): ServerFactory {
  const fresh = <A>(make: (d: CoreDeps) => ToolHandler<A>, provider = depsProvider): ToolHandler<A> =>
    (args: A, extra: ScopedExtra) => lifecycle.run(async () => make(await provider())(args, extra))
      ?? { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false,
        error: { code: 'SHUTTING_DOWN', message: 'Curator is shutting down. Retry after it restarts.' } }) }] };

  return () => {
    const server = new McpServer({ name: 'vault-curator', version: '0.1.0' });

    server.registerTool('preview-wiki-refresh', { description: 'Free check before rebuilding one page of a project wiki: its home or a sub-page. Takes the output_revision_id of the page\'s latest build, which inspect-provenance with select:"node" returns. Says what would be rewritten, with which model, or why it can\'t run, and returns the guard refresh-wiki-page needs. A paused wiki can be rebuilt this way. No model call or capture reservation. Requires curate:read.',
      inputSchema: previewHomeRefreshInput }, fresh(makePreviewHomeRefreshHandler, homeRefreshDeps));
    server.registerTool('refresh-wiki-page', { description: 'Queue one paid rebuild of the page preview-wiki-refresh checked: one model call. A sub-page with rules on what to say also gets a check of them after each draft, and one more draft if the first breaks a rule, so at most four calls. A sub-page rebuild changes only that page, and a home rebuild changes only the home. For the whole wiki use curate-project-wiki with force:true. Requires the preview guard, a new request UUID, confirm_paid:true and curate:trigger. Retry a lost reply with the same UUID.',
      inputSchema: refreshProjectHomeInput }, fresh(makeRefreshProjectHomeHandler, homeRefreshDeps));
    server.registerTool('wiki-refresh-status', { description: 'Read a page rebuild\'s status and its new build\'s receipt by request UUID. Polling never generates. Requires curate:read.',
      inputSchema: homeRefreshStatusInput }, fresh(makeHomeRefreshStatusHandler, homeRefreshDeps));

    server.registerTool(
      'curate-project-wiki',
      {
        description: 'Curate (or preview) project wikis, or one topic wiki. Name a project to curate just it, or omit project to sweep all active projects. A live run is queued and the call replies at once with status "queued": a project usually finishes within a few minutes (not if today\'s spend cap is reached; a scheduled sweep then retries an active, unpaused project only while curator-status shows wiki_reconciliation_mode "live", so otherwise rebuild it later with force: true), and curator-status shows the outcome. Do not call again to check; a repeat call while that build is queued or running replies "in_progress" and starts nothing. A project with no wiki is answered at once with its outcome, and so is a paused one unless force is set. To rebuild one wiki on request, even if it is paused or unchanged, name it with force: true, and follow it with curator-status and project. A paused wiki stays paused, so sweeps still skip it. project also takes a registered topic wiki\'s name: the same rules apply, and the run is that topic\'s full curation, with web research for a vault+web topic. A topic wiki can only be rebuilt whole, this way; refresh-wiki-page is for project wikis. To find the wiki a page belongs to, read the page with get-node: relationships.outgoing.wiki_for gives its root note\'s id, and that note\'s title is the wiki\'s name. dry_run returns per-project outcomes (evidence_hash, would-curate/skipped/error, evidence_unchanged when forced) plus a summary without model calls; with preview it runs the paid generation and returns the result, which can take minutes. Use limit to bound a sweep. Requires the curate:trigger scope.',
        inputSchema: curateProjectWikiInput,
      },
      fresh(makeCurateProjectWikiHandler),
    );

    server.registerTool(
      'reconcile-wiki-pages',
      {
        description: 'Audit or reconcile one exact active project or registered topic through the canonical topology pipeline. Defaults to dry-run and returns bounded catalog, action, adjudication, validation, preview, usage, cost, mapping, warning, hash, and undo metadata. Requires the curate:trigger scope.',
        inputSchema: reconcileWikiPagesInput,
      },
      fresh(makeReconcileWikiPagesHandler),
    );

    server.registerTool(
      'curator-status',
      {
        description: 'Read-only curator run history, queue state, and health. Pass project (a project title or a topic wiki\'s name) to get just that wiki: whether it is a project or topic wiki, whether a build is running, its latest run and last written build, its models and today\'s budget. Requires the curate:read scope.',
        inputSchema: curatorStatusInput,
      },
      fresh((d) => makeCuratorStatusHandler(d, startedAt)),
    );

    server.registerTool('curator-cost-report', {
      description: 'Read-only Curator costs by sweep, project, run, stage, requested/reported model and call outcome, with actual/estimated/unknown coverage and separately recorded wiki publication outcomes. Defaults to the last 24 hours. No model calls. Requires curate:read.',
      inputSchema: curatorCostReportInput,
    }, fresh(makeCuratorCostReportHandler));

    server.registerTool(
      'request-wiki-page',
      {
        description: 'Request a named sub-page on a project wiki (synthesized from vault evidence, pinned against auto-retirement). Requires the curate:trigger scope.',
        inputSchema: requestWikiPageInput,
      },
      fresh(makeRequestWikiPageHandler),
    );

    server.registerTool(
      'set-wiki-paused',
      {
        description: 'Pause or resume scheduled curation of a project wiki or a topic wiki (by its name). A paused wiki is skipped by the daily sweep and by curate-project-wiki without force. You can still rebuild it on request: curate-project-wiki with force (project or topic wiki), or refresh-wiki-page (one page of a project wiki). The wiki home\'s wiki_status field shows it: paused, or paused-behind once its notes change; resuming makes it current or behind. Requires the curate:trigger scope.',
        inputSchema: setWikiPausedInput,
      },
      fresh(makeSetWikiPausedHandler),
    );

    server.registerTool(
      'add-wiki-correction',
      {
        description: 'Attach a standing correction note to a project wiki — steering the curator cannot infer (e.g. "stop surfacing X; it is done"). Injected into every run until resolved. Requires the curate:trigger scope.',
        inputSchema: addWikiCorrectionInput,
      },
      fresh(makeAddWikiCorrectionHandler),
    );

    server.registerTool(
      'resolve-wiki-correction',
      {
        description: 'Resolve (remove) a standing wiki correction by id — find ids under control.corrections in curator-status. Requires the curate:trigger scope.',
        inputSchema: resolveWikiCorrectionInput,
      },
      fresh(makeResolveWikiCorrectionHandler),
    );

    server.registerTool(
      'create-or-update-wiki',
      {
        description: 'Create OR update a standalone wiki on ANY topic — distinct from project wikis, and usable for subjects the vault knows nothing about yet (a person, technology, team, event, e.g. "The 2026 Metro Owls"). By default a new wiki is grounded in your vault (synthesized from matching notes); pass source="vault+web" to ALSO pull live, attributed web research (web-search + page fetch), refreshed on a cadence (default 7d) while scheduled wiki sweeps are on. Creates a topic node (in Topics/ unless the topicDir setting names another folder) + home page and registers it for scheduled refresh, which runs only while curator-status shows wiki_reconciliation_mode "live"; curate-project-wiki with the topic and force: true rebuilds it on request. Optional source_node_ids are stable input evidence anchors, distinct from wiki output pages: omit them to preserve the configured list, pass an empty list to clear it, or pass a non-empty list to replace it after trim/deduplication (maximum 20 unique IDs); add_source_node_ids instead adds to the current list, keeping the rest; changing membership forces a curation. A create, or a change to the brief, source or sources, queues that build and replies at once with outcome "queued" ("in_progress" when a build of the wiki is already queued: it builds the wiki as it is when it starts, so the change is included); a build usually finishes within a few minutes, longer with web research. Do not call again to check: curator-status with project (the topic) shows the outcome. IDEMPOTENT on the topic title: re-call with an existing topic to change its settings — omitted fields keep their current values ("" clears), so topic + cadence alone changes just the refresh cadence (cheap, no re-synthesis). This is the tool for "start/research a wiki about <web topic>" AND "change the cadence/brief/source of an existing topic wiki". CRITICAL: `topic` is the TOPIC title, never a wiki PAGE title. A wiki\'s home page is named "<topic> Wiki", so when the user says "this wiki" while looking at "Foo Wiki", the topic is "Foo" — passing "Foo Wiki" asks for a SECOND wiki and is refused. Unsure of the exact title? List them with curator-status first. To start a wiki from a note, propose-topic-wiki suggests the topic and brief; pass paused:true when creating so the wiki builds once and then changes only on request. Requires the curate:trigger scope.',
        inputSchema: createOrUpdateWikiInput,
      },
      fresh(makeCreateOrUpdateWikiHandler),
    );

    server.registerTool(
      'propose-topic-wiki',
      {
        description: 'Propose a topic wiki from one note ("make a topic wiki out of this note"). Takes the note\'s node_id and makes one small paid model call on the wiki planning model; dry_run runs only the free checks. Returns the subject the note implies (not its headline: a clipping titled "Why the Owls fired their coach" implies "The 2026 Metro Owls"), a 1-3 sentence brief, a confidence, alternatives, and any registered topic or project wiki the topic matches. It also returns ready create-or-update-wiki arguments: next.create makes a new vault+web topic wiki with this note as its source, built once and then paused; next.add_source adds the note to the matched topic wiki instead, keeping its current sources. next.create is left out when a wiki already has that name or the topic is the note\'s own title (the wiki needs a note of its own), and next.add_source when no topic wiki matches or the note is already its source. It creates nothing: show the topic and brief to the user to accept or edit, then call create-or-update-wiki with the agreed values. A wiki page, a topic wiki\'s own note, or a note with too little text is refused before any call. Requires the curate:trigger scope.',
        inputSchema: proposeTopicWikiInput,
      },
      fresh(makeProposeTopicWikiHandler),
    );

    server.registerTool(
      'create-project-wiki',
      {
        description: createProjectWikiDescription(wikiFlagField()),
        inputSchema: createProjectWikiInput,
      },
      fresh(makeCreateProjectWikiHandler),
    );

    server.registerTool(
      'remove-wiki',
      {
        description: removeWikiDescription(wikiFlagField()),
        inputSchema: removeWikiInput,
      },
      fresh(makeRemoveWikiHandler),
    );

    server.registerTool(
      FILL_FIELDS_TOOL,
      { description: FILL_FIELDS_DESCRIPTION, inputSchema: fillFieldsInput },
      fresh(makeFillFieldsHandler),
    );

    server.registerTool(
      TYPE_NOTES_TOOL,
      { description: TYPE_NOTES_DESCRIPTION, inputSchema: typeNotesInput },
      fresh(makeTypeNotesHandler),
    );

    server.registerTool(
      GUESS_MEMORY_SUBJECTS_TOOL,
      { description: GUESS_MEMORY_SUBJECTS_DESCRIPTION, inputSchema: guessMemorySubjectsInput },
      fresh(makeGuessMemorySubjectsHandler),
    );

    server.registerTool(
      EXTRACT_MEMORIES_TOOL,
      { description: EXTRACT_MEMORIES_DESCRIPTION, inputSchema: extractMemoriesInput },
      fresh(makeExtractMemoriesHandler),
    );

    server.registerTool(
      BUILD_DOSSIER_TOOL,
      { description: BUILD_DOSSIER_DESCRIPTION, inputSchema: buildDossierInput },
      fresh(makeBuildDossierHandler),
    );

    server.registerTool(
      REMOVE_DOSSIER_TOOL,
      { description: REMOVE_DOSSIER_DESCRIPTION, inputSchema: removeDossierInput },
      fresh(makeRemoveDossierHandler),
    );

    return server;
  };
}
