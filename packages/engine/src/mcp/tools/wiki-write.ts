import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WikiSectionError } from '../../wiki/section-integrity.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail, adaptIssue, type Issue } from './errors.js';
import { memoryNoteEditRefusal } from './resolve-identity.js';
import { toolCaller } from '../../auth/client-label.js';
import {
  assertToolMutationFilePresent,
  assertMutationPreviewGuards,
  ContentHashMismatchError,
  StaleNodeError,
  executeMutation,
  repairInboundLinks,
} from '../../pipeline/execute.js';
import { canonicalizeBodyLinks } from '../../pipeline/canonical-links.js';
import { LinkCanonicalizer } from '../../resolver/file-link.js';
import { PipelineError } from '../../pipeline/types.js';
import { titleFromFilename } from '../../parser/parse.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { createOperation, discardOperation, finalizeOperation } from '../../undo/operation.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';
import { buildContentHashMismatchEnvelope } from './content-hash-helpers.js';
import { getWikiConfig, wikiWriteConfig, WIKIS_OFF_MESSAGE } from '../../wiki/config.js';
import { ensureWikiSchema, getWikiBootstrapPlan } from '../../wiki/bootstrap.js';
import { buildProjectDigest, fetchExistingWiki, resolveProject, type DigestProject } from '../../wiki/digest.js';
import { loadStoredWikiNode } from '../../wiki/reconcile-model.js';
import { mergeManagedSections, type ManagedSectionInput } from '../../wiki/sections.js';
import {
  buildWikiFilePath,
  buildWikiPageTitle,
  buildWikiTargetFields,
  findWikiTarget,
  renderWikiLiveSections,
  resolveWikiParent,
} from '../../wiki/write-helpers.js';

const sectionShape = z.object({
  name: z.string(),
  mode: z.enum(['replace', 'append']).default('replace'),
  content: z.string(),
});

export function registerWikiWrite(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'wiki-write',
    'Create or update a Project Wiki home page or sub-page. For useful wiki creation, pass managed narrative sections such as Now, Focus, Open threads, and Log; live sections are deterministic appendices. Only ve:live:* and supplied ve:managed:* marker regions are rewritten; human text outside markers is preserved. dry_run previews without schema or node mutation.',
    {
      project: z.string(),
      target: z.enum(['home', 'subpage']).default('home'),
      subpage_title: z.string().optional(),
      page_kind: z.enum(['overview', 'task-board', 'contacts', 'meetings', 'notes']).optional(),
      sections: z.array(sectionShape).optional(),
      refresh_live: z.boolean().default(true),
      dry_run: z.boolean().default(false),
      expected_version: z.number().int().optional(),
      create_only: z.boolean().default(false).describe('Write only when the page does not exist yet; an existing page is returned unchanged with created: false.'),
    },
    async (params, extra) => {
      const target = params.target ?? 'home';
      const refreshLive = params.refresh_live ?? true;
      const dryRun = params.dry_run ?? false;
      const config = wikiWriteConfig(getWikiConfig(db));
      if (config === null) return fail('INVALID_PARAMS', WIKIS_OFF_MESSAGE);
      const project = resolveProject(db, params.project);
      if (!project) return fail('NOT_FOUND', 'Project not found');
      if (target === 'subpage' && !params.subpage_title) {
        return fail('INVALID_PARAMS', 'subpage_title is required when target is subpage');
      }

      const bootstrapPlan = getWikiBootstrapPlan(db, config);
      const targetTitle = buildWikiPageTitle(project.title, target, params.subpage_title);
      const targetInfo = findWikiTarget(db, {
        projectId: project.id,
        title: targetTitle,
        target,
        wikiType: config.wikiType,
      });
      const created = targetInfo.node === null;
      // An existing page keeps its own title and type memberships: a home is found by
      // wiki_for, not by title, and users may rename it or add types.
      const stored = targetInfo.node === null ? null : loadStoredWikiNode(db, targetInfo.node.id);
      const nodeTypes = stored?.types.length ? [...stored.types] : [config.wikiType];
      const currentBody = stored?.body ?? '';
      const currentFields = stored?.fields ?? {};
      const filePath = stored?.filePath ?? buildWikiFilePath(config.wikiDir, targetTitle);
      const nodeTitle = stored?.title ?? titleFromFilename(filePath);
      // A page is found by type and wiki_for, not by path, so say no here too if it is the memory note.
      const memoryNoteRefusal = memoryNoteEditRefusal(vaultPath, filePath, toolCaller(extra));
      if (memoryNoteRefusal !== null) return fail('INVALID_PARAMS', memoryNoteRefusal);
      // Checked and written in one synchronous pass, so a concurrent writer cannot slip between.
      if (params.create_only && stored !== null) {
        return ok({ node_id: stored.id, file_path: stored.filePath, title: nodeTitle, version: stored.version,
          created: false, unchanged: true, ...(dryRun ? { dry_run: true } : {}) });
      }

      let homeForSubpage: { id: string; title: string } | null = null;
      if (target === 'subpage') {
        homeForSubpage = resolveWikiParent(db, project, config);
      }
      const fields = buildWikiTargetFields({
        currentFields,
        projectTarget: project.file_path,
        target,
        ...(homeForSubpage === null ? {} : { parentTitle: homeForSubpage.title }),
      });

      const digest = buildProjectDigest(db, { project: project.id });
      const live = refreshLive
        ? renderWikiLiveSections(db, {
            config,
            projectId: project.id,
            digest,
            target,
            ...(params.page_kind === undefined ? {} : { pageKind: params.page_kind }),
          })
        : {};
      // Only the supplied sections are this call's text: their links are
      // canonicalized here, while human text outside the markers and
      // unsupplied sections stay byte-for-byte (canonicalizeLinks: false below).
      const canonicalizer = new LinkCanonicalizer(db);
      const managed = normalizeSections(params.sections)
        .map(section => ({ ...section, content: canonicalizeBodyLinks(section.content, canonicalizer) }));
      let merged: ReturnType<typeof mergeManagedSections>;
      try {
        merged = mergeManagedSections(currentBody, { live, managed });
      } catch (error) {
        if (error instanceof WikiSectionError) return fail('VALIDATION_FAILED', error.message);
        throw error;
      }
      const narrativeStatus = managed.length > 0 ? 'managed' : 'live_only';
      const warnings = buildWarnings(db, {
        project,
        target,
        title: nodeTitle,
        subpageCap: config.subpageCap,
        reused: targetInfo.reused,
        created,
        managedSectionCount: managed.length,
      });

      if (targetInfo.node !== null) {
        try {
          assertToolMutationFilePresent(db, vaultPath, {
            source: 'tool',
            node_id: targetInfo.node.id,
            file_path: filePath,
          });
        } catch (err) {
          if (err instanceof ContentHashMismatchError) {
            return buildContentHashMismatchEnvelope(db, err);
          }
          throw err;
        }
      }

      if (created && existsSync(join(vaultPath, filePath))) {
        return fail('CONFLICT', `File "${filePath}" already exists on disk`);
      }

      if (dryRun) {
        if (targetInfo.node !== null) {
          const rollbackSignal = {};
          try {
            db.transaction(() => {
              // Live writes bootstrap before rendering. Missing claims can
              // change field ordering and no-op detection, so check guards in
              // that same schema context and roll all bootstrap changes back.
              ensureWikiSchema(db, config);
              assertMutationPreviewGuards(db, writeLock, vaultPath, {
                source: 'tool',
                node_id: targetInfo.node!.id,
                file_path: filePath,
                title: nodeTitle,
                types: nodeTypes,
                fields,
                body: merged.body,
                canonicalizeLinks: false,
                expectedVersion: params.expected_version,
              });
              throw rollbackSignal;
            })();
          } catch (err) {
            if (err instanceof ContentHashMismatchError) return buildContentHashMismatchEnvelope(db, err);
            if (err instanceof StaleNodeError) return buildStaleNodeEnvelope(db, err);
            if (err instanceof PipelineError) {
              return fail('VALIDATION_FAILED', err.message, err.validation
                ? { details: { issues: err.validation.issues.map(adaptIssue) } }
                : undefined);
            }
            if (err !== rollbackSignal) throw err;
          }
        }
        return ok({
          dry_run: true,
          would_bootstrap: bootstrapPlan,
          target,
          file_path: filePath,
          title: nodeTitle,
          created,
          narrative_status: narrativeStatus,
          merged_body_preview: merged.body,
          sections_written: merged.written,
          live_sections_refreshed: Object.keys(live).map(k => `live:${k}`),
        }, warnings);
      }

      const operation_id = createOperation(db, {
        source_tool: 'wiki-write',
        description: `wiki-write: ${nodeTitle}`,
      });
      let discardEmptyOperation = false;
      const fsUndos: Array<() => void> = [];
      const fsRollback = { push: (undo: () => void) => fsUndos.push(undo) };
      let committed = false;

      try {
        let result: ReturnType<typeof executeMutation>;
        const txn = db.transaction(() => {
          ensureWikiSchema(db, config, operation_id);
          let parentTitle = homeForSubpage?.title;
          if (target === 'subpage' && homeForSubpage !== null && homeForSubpage.id === '') {
            const home = createHomeWiki(
              db,
              writeLock,
              vaultPath,
              syncLogger,
              operation_id,
              project,
              config.wikiType,
              config.wikiDir,
              fsRollback,
            );
            parentTitle = home.title;
            fields.wiki_parent = parentTitle;
          }

          result = executeMutation(db, writeLock, vaultPath, {
            source: 'tool',
            node_id: targetInfo.node?.id ?? null,
            file_path: filePath,
            title: nodeTitle,
            types: nodeTypes,
            fields,
            body: merged.body,
            canonicalizeLinks: false,
            expectedVersion: targetInfo.node ? params.expected_version : undefined,
          }, syncLogger, { operation_id }, fsRollback);
        });
        txn();
        committed = true;
        // T0.3: the wiki body changed — re-embed (tool writes skip the watcher).
        embeddingIndexer?.enqueue({ node_id: result!.node_id, source_type: 'node' });
        // Links written to a new page's name before it existed (see
        // repairInboundLinks); best-effort writes of their own, after commit.
        if (created) {
          for (const repairedId of repairInboundLinks(db, writeLock, vaultPath, result!.node_id, syncLogger, { operation_id })) {
            embeddingIndexer?.enqueue({ node_id: repairedId, source_type: 'node' });
          }
        }
        const version = getNodeVersion(db, result!.node_id);

        return ok({
          node_id: result!.node_id,
          file_path: result!.file_path,
          title: nodeTitle,
          version,
          sections_written: merged.written,
          live_sections_refreshed: Object.keys(live).map(k => `live:${k}`),
          created,
          narrative_status: narrativeStatus,
          operation_id,
          ...(warnings.length > 0 ? { warnings } : {}),
        }, [...result!.validation.issues.map(adaptIssue), ...warnings]);
      } catch (err) {
        if (!committed) {
          for (let i = fsUndos.length - 1; i >= 0; i--) {
            try {
              fsUndos[i]();
            } catch (undoErr) {
              const msg = undoErr instanceof Error ? undoErr.message : String(undoErr);
              console.error(`[wiki-write] fs rollback failed: ${msg}`);
            }
          }
        }
        if (err instanceof ContentHashMismatchError) {
          discardEmptyOperation = err.currentHash === null;
          return buildContentHashMismatchEnvelope(db, err);
        }
        if (err instanceof StaleNodeError) return buildStaleNodeEnvelope(db, err);
        if (err instanceof PipelineError && err.validation) {
          return fail('VALIDATION_FAILED', err.message, {
            details: { issues: err.validation.issues.map(adaptIssue) },
          });
        }
        if (err instanceof PipelineError) return fail('VALIDATION_FAILED', err.message);
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      } finally {
        if (discardEmptyOperation) discardOperation(db, operation_id);
        else finalizeOperation(db, operation_id);
      }
    },
  );
}

function normalizeSections(sections: Array<z.infer<typeof sectionShape>> | undefined): ManagedSectionInput[] {
  return (sections ?? []).map(section => ({
    name: section.name,
    mode: section.mode ?? 'replace',
    content: section.content,
  }));
}

function createHomeWiki(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger: SyncLogger | undefined,
  operation_id: string,
  project: DigestProject,
  wikiType: string,
  wikiDir: string,
  fsRollback: { push(undo: () => void): void },
): { id: string; title: string } {
  const title = buildWikiPageTitle(project.title, 'home');
  const body = mergeManagedSections('', { live: {}, managed: [] }).body;
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: buildWikiFilePath(wikiDir, title),
    title,
    types: [wikiType],
    fields: buildWikiTargetFields({
      currentFields: {},
      projectTarget: project.file_path,
      target: 'home',
    }),
    body,
  }, syncLogger, { operation_id }, fsRollback);
  return { id: result.node_id, title: titleFromFilename(result.file_path) };
}

function getNodeVersion(db: Database.Database, nodeId: string): number | undefined {
  return (db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined)?.version;
}

function buildWarnings(
  db: Database.Database,
  input: {
    project: DigestProject;
    target: 'home' | 'subpage';
    title: string;
    subpageCap: number;
    reused: boolean;
    created: boolean;
    managedSectionCount: number;
  },
): Issue[] {
  const warnings: Issue[] = [];
  if (input.created && input.managedSectionCount === 0) {
    warnings.push({
      code: 'WIKI_NARRATIVE_EMPTY',
      message: 'This creates only deterministic live sections. For a useful Project Wiki, synthesize managed sections such as Now, Focus, Open threads, and Log.',
      severity: 'warning',
    });
  }
  if (input.target !== 'subpage') return warnings;

  const config = getWikiConfig(db);
  const existing = fetchExistingWiki(db, input.project.id, config);
  if (existing.subpages.length >= input.subpageCap) {
    warnings.push({
      code: 'WIKI_SUBPAGE_CAP',
      message: `Project has ${existing.subpages.length} wiki sub-page(s), at or above configured cap ${input.subpageCap}`,
      severity: 'warning',
    });
  }
  if (input.reused) {
    warnings.push({
      code: 'WIKI_SUBPAGE_REUSED',
      message: `Updating existing same-titled wiki sub-page "${input.title}" instead of creating a duplicate`,
      severity: 'warning',
    });
  }
  return warnings;
}
