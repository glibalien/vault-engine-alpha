import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ContentHashMismatchError, StaleNodeError } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import { getWikiConfig, WIKIS_OFF_MESSAGE } from '../../wiki/config.js';
import { resolveProjectReference } from '../../wiki/digest.js';
import { findWikiHome, setWikiHomeStatus, settledWikiStatus } from '../../wiki/status.js';
import { WIKI_STATUSES } from '../../wiki/status-values.js';
import { buildContentHashMismatchEnvelope } from './content-hash-helpers.js';
import { describePipelineError, fail, ok } from './errors.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';

export const wikiStatusInputShape = {
  root: z.string().min(1).describe('The wiki\'s root note (project or topic): node id, vault path or title'),
  status: z.enum(WIKI_STATUSES).optional()
    .describe('Write this status to the wiki\'s home page. Omit to read it.'),
} as const;

export interface WikiStatusToolDeps {
  readonly db: Database.Database;
  readonly writeLock: WriteLockManager;
  readonly vaultPath: string;
  readonly syncLogger?: SyncLogger;
  readonly embeddingIndexer?: Pick<EmbeddingIndexer, 'enqueue'>;
}

/**
 * `wiki-status` (#547): read or write the `wiki_status` of a wiki's home page, found from the
 * wiki's root. The Curator calls it when a wiki is paused or resumed and when a build starts
 * or fails. Service-only plumbing: the owner pauses a wiki through the Curator's tools.
 */
export function registerWikiStatus(server: McpServer, deps: WikiStatusToolDeps): void {
  server.tool(
    'wiki-status',
    'Read or write the status on a wiki\'s home page (current, behind, paused, paused-behind, building, failed). Current or paused for a project wiki whose notes changed since its last build is written as behind or paused-behind. Writes only when it changes, leaves the page\'s links as written, and refuses while the page has an edit the Engine has not read yet.',
    wikiStatusInputShape,
    async (params) => {
      const config = getWikiConfig(deps.db);
      if (config.wikiType === null) return fail('INVALID_PARAMS', WIKIS_OFF_MESSAGE);
      const root = resolveProjectReference(deps.db, params.root);
      if (!root.ok) {
        return fail(root.code === 'AMBIGUOUS_PROJECT' ? 'AMBIGUOUS_MATCH' : 'NOT_FOUND', `Wiki root ${params.root}: ${root.code}`);
      }
      const home = findWikiHome(deps.db, root.project.id, config.wikiType);
      if (home === null) {
        return ok({ root_id: root.project.id, home_node_id: null, status: null, version: null, built: false, written: false });
      }
      if (params.status === undefined) {
        return ok({
          root_id: root.project.id, home_node_id: home.id, status: home.status, version: home.version,
          built: home.evidenceHash !== null, written: false,
        });
      }
      try {
        // Current or paused for a project whose notes moved on is written as behind (#547).
        const status = settledWikiStatus(deps.db, config, root.project.id, params.status, home.evidenceHash);
        const write = setWikiHomeStatus(deps, home.id, status);
        if (write === null) return fail('NOT_FOUND', `Wiki home ${home.id} is gone`);
        return ok({
          root_id: root.project.id,
          home_node_id: home.id,
          previous_status: write.previous,
          status: write.status,
          version: write.version,
          built: home.evidenceHash !== null,
          written: write.written,
        });
      } catch (error) {
        if (error instanceof ContentHashMismatchError) return buildContentHashMismatchEnvelope(deps.db, error);
        if (error instanceof StaleNodeError) return buildStaleNodeEnvelope(deps.db, error);
        if (error instanceof PipelineError) {
          const described = describePipelineError(error);
          if (described !== null) return fail(described.code, described.message, { details: described.details });
        }
        return fail('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
      }
    },
  );
}
