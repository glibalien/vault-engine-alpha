import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import type { MemoryNoteProjection } from '../../memories/note-projection.js';
import { ContentHashMismatchError } from '../../pipeline/execute.js';

/**
 * `refresh-memory-note` — render and write the canonical `Settings/Memories.md`
 * projection through `executeMutation` (Task 8 of the durable-memory
 * markdown-projection plan).
 *
 * The curator calls this once during its production scheduled daily sweep
 * (after memory/conversation/organization/reconciliation phases and before
 * the journal). No ordinary memory mutation writes the note — only this
 * explicit refresh or the scheduled sweep does.
 *
 * `dry_run` defaults to false (matching single-node mutation tools). Dry-run
 * uses `preview()` (no DB/file/undo/sync-log mutation); real mode uses
 * `refresh()`. Stale disk/DB CAS failures map to `CONTENT_HASH_MISMATCH`.
 */
export function registerRefreshMemoryNote(
  server: McpServer,
  projection: MemoryNoteProjection,
): void {
  server.tool(
    'refresh-memory-note',
    'Render and write the editable Settings/Memories.md projection of every durable memory (live + historical). Drains pending note edits first. No ordinary memory mutation writes the note — only this tool or the production scheduled daily sweep does.',
    {
      dry_run: z.boolean().default(false).describe('When true, render and count without writing to disk or the DB.'),
    },
    async (params) => {
      try {
        if (params.dry_run) {
          const preview = await projection.preview();
          return ok({
            file_path: preview.file_path,
            node_id: preview.node_id,
            live_count: preview.live_count,
            historical_count: preview.historical_count,
            total: preview.total,
            rendered_hash: preview.rendered_hash,
            bytes: preview.bytes,
            would_write: preview.would_write,
            file_written: false,
            issues_rendered: preview.issues_rendered,
            snapshot_at: preview.snapshot_at,
          });
        }
        const result = await projection.refresh();
        return ok({
          file_path: result.file_path,
          node_id: result.node_id,
          live_count: result.live_count,
          historical_count: result.historical_count,
          total: result.total,
          rendered_hash: result.rendered_hash,
          bytes: result.bytes,
          would_write: result.would_write,
          file_written: result.file_written,
          issues_rendered: result.issues_rendered,
          snapshot_at: result.snapshot_at,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof ContentHashMismatchError || /content_hash|stale/i.test(message)) {
          return fail('CONTENT_HASH_MISMATCH', `Memory note refresh conflict: ${message}`);
        }
        return fail('INTERNAL_ERROR', message);
      }
    },
  );
}
