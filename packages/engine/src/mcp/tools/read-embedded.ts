import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { join, basename, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { ok, fail } from './errors.js';
import type { ExtractionCache } from '../../extraction/cache.js';
import type { TranscriptStore, TranscriptRow } from '../../extraction/transcript-store.js';
import { findFileInVault } from '../../extraction/find-file.js';

function retainedResult(retained: TranscriptRow) {
  return ok({
    text: retained.extracted_text,
    media_type: retained.media_type,
    extractor_id: retained.extractor_id,
    content_hash: retained.content_hash,
    metadata: retained.metadata_json ? JSON.parse(retained.metadata_json) : null,
    source_deleted: true,
  });
}

export function registerReadEmbedded(
  server: McpServer,
  db: Database.Database,
  extractionCache: ExtractionCache,
  vaultPath: string,
  transcriptStore?: TranscriptStore,
): void {
  server.tool(
    'read-embedded',
    'Extract and return the content of a single embedded file. Supports audio (transcription), images (OCR), PDFs, office docs, and markdown. Specify file_path (vault-relative) or filename (basename to resolve).',
    {
      file_path: z.string().optional().describe('Vault-relative path to the file'),
      filename: z.string().optional().describe('Filename to resolve (basename match)'),
    },
    async (params) => {
      const { file_path, filename } = params;

      if (!file_path && !filename) {
        return fail('INVALID_PARAMS', 'Exactly one of file_path or filename is required');
      }
      if (file_path && filename) {
        return fail('INVALID_PARAMS', 'Provide only one of file_path or filename');
      }

      let resolvedPath: string;

      if (file_path) {
        resolvedPath = safeVaultPath(vaultPath, file_path);
      } else {
        // Resolve filename: find all nodes whose basename matches
        const allNodes = db.prepare('SELECT file_path FROM nodes').all() as { file_path: string }[];
        const matches = allNodes.filter(n => basename(n.file_path) === filename);

        if (matches.length === 0) {
          // Binary files (audio, images) aren't in nodes table — search vault
          const directPath = safeVaultPath(vaultPath, filename!);
          let directExists = false;
          try {
            await stat(directPath);
            directExists = true;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
              return fail('INTERNAL_ERROR', `stat failed for "${filename}": ${code ?? 'UNKNOWN'}: ${(err as Error).message}`);
            }
          }
          if (directExists) {
            resolvedPath = directPath;
          } else {
            const found = await findFileInVault(vaultPath, filename!);
            if (found) {
              resolvedPath = found;
            } else {
              const retained = transcriptStore?.getByRef(filename!) ?? transcriptStore?.getByPath(filename!);
              if (retained) {
                return retainedResult(retained);
              }
              return fail('NOT_FOUND', `File not found in vault: ${filename}`);
            }
          }
        } else if (matches.length === 1) {
          resolvedPath = join(vaultPath, matches[0].file_path);
        } else {
          return fail('AMBIGUOUS_FILENAME', `Multiple files match "${filename}"`, {
            details: { matches: matches.map(m => m.file_path) },
          });
        }
      }

      try {
        const result = await extractionCache.getExtraction(resolvedPath);
        return ok({
          text: result.text,
          media_type: result.mediaType,
          extractor_id: result.extractorId,
          content_hash: result.contentHash,
          metadata: result.metadata,
        });
      } catch (err) {
        const message = (err as Error).message;
        if (message.startsWith('EXTRACTOR_UNAVAILABLE')) {
          return fail('EXTRACTOR_UNAVAILABLE', message);
        }
        if (message.startsWith('No extractor')) {
          return fail('INVALID_PARAMS', message);
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || message.includes('ENOENT')) {
          const rel = relative(vaultPath, resolvedPath);
          const retained = transcriptStore?.getByPath(rel) ?? transcriptStore?.getByRef(rel);
          if (retained) {
            return retainedResult(retained);
          }
          return fail('NOT_FOUND', `File not found: ${rel}`);
        }
        return fail('INTERNAL_ERROR', message);
      }
    },
  );
}
