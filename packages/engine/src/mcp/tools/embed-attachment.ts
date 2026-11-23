// src/mcp/tools/embed-attachment.ts
// Write a base64 image into the vault as an attachment, returning the `![[ref]]` filename.
// Additive + idempotent (content-hash filename); NOT a node mutation, so it does not go through
// executeMutation / the undo log (owner decision 2026-06-15). Vision extraction happens later, when
// a node body embeds `![[ref]]` and is reindexed.
import { z } from 'zod';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, fail } from './errors.js';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { atomicWriteFileBuffer } from '../../pipeline/file-writer.js';
import { isAllowedImageMime, isAllowedAudioMime, attachmentFilename } from './attachment-name.js';

const paramsShape = {
  filename: z.string(),
  mime: z.string(),
  data_base64: z.string(),
};

export function registerEmbedAttachment(server: McpServer, vaultPath: string, attachmentDir: string): void {
  server.tool(
    'embed-attachment',
    'Write a base64-encoded image or audio attachment into the vault and return its embed ref (the `![[ref]]` filename). Idempotent: re-embedding identical bytes returns the same ref.',
    paramsShape,
    async ({ filename, mime, data_base64 }) => {
      if (!isAllowedImageMime(mime) && !isAllowedAudioMime(mime)) {
        return fail('INVALID_PARAMS', `Unsupported attachment type: ${mime}. Allowed images: image/png, image/jpeg, image/gif, image/webp. Allowed audio: audio/webm, audio/ogg, audio/wav, audio/mp4, audio/mpeg.`);
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(data_base64, 'base64');
      } catch {
        return fail('INVALID_PARAMS', 'data_base64 is not valid base64.');
      }
      if (bytes.length === 0) return fail('INVALID_PARAMS', 'Decoded attachment is empty.');

      const ref = attachmentFilename(filename, mime, bytes);
      const relPath = `${attachmentDir}/${ref}`;
      let target: string;
      try {
        target = safeVaultPath(vaultPath, relPath);
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : 'Path traversal blocked.');
      }
      try {
        if (!existsSync(target)) {
          atomicWriteFileBuffer(target, bytes, join(vaultPath, '.vault-engine', 'tmp'));
        }
      } catch (err) {
        return fail('INTERNAL_ERROR', `Failed to write attachment: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok({ ref, vault_path: relPath });
    },
  );
}
