import { projectFieldValues, type FieldRow } from '../fields/project.js';
import { readExplicitNullFields } from '../fields/explicit-null.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ExtractionCache } from './cache.js';
import type { AssembledNode, EmbedEntry, EmbedError } from './types.js';
import { resolveEmbedRef } from './resolve.js';
import { findFileInVault } from './find-file.js';
import type { TranscriptStore } from './transcript-store.js';

export interface AssembleOptions {
  maxEmbeds?: number;
  maxFileSizeBytes?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_EMBEDS = 20;
const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_MAX_DEPTH = 5;

const EMBED_REGEX = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function parseEmbedReferences(body: string): string[] {
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex in case regex is reused
  EMBED_REGEX.lastIndex = 0;
  while ((match = EMBED_REGEX.exec(body)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
}

interface NodeTypeRow {
  schema_type: string;
}

export async function assemble(
  db: Database.Database,
  nodeId: string,
  cache: ExtractionCache,
  vaultPath: string,
  options?: AssembleOptions,
  transcriptStore?: TranscriptStore,
): Promise<AssembledNode> {
  const maxEmbeds = options?.maxEmbeds ?? DEFAULT_MAX_EMBEDS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  // Load node
  const node = db
    .prepare('SELECT id, file_path, title, body FROM nodes WHERE id = ?')
    .get(nodeId) as NodeRow | undefined;

  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  // Load types
  const types = (
    db
      .prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(nodeId) as NodeTypeRow[]
  ).map((r) => r.schema_type);

  // Load fields
  const fieldRows = db
    .prepare('SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ?')
    .all(nodeId) as FieldRow[];
  const fields = projectFieldValues(fieldRows, readExplicitNullFields(db, nodeId));

  const embeds: EmbedEntry[] = [];
  const errors: EmbedError[] = [];
  const visited = new Set<string>([nodeId]);

  // Process embeds from the node's body
  if (node.body) {
    const refs = parseEmbedReferences(node.body);
    await processEmbeds(
      db, cache, vaultPath, refs, null, embeds, errors, visited,
      maxEmbeds, maxFileSizeBytes, maxDepth, 0, transcriptStore,
    );
  }

  return {
    node: { title: node.title, types, fields },
    body: node.body,
    embeds,
    errors,
  };
}

async function processEmbeds(
  db: Database.Database,
  cache: ExtractionCache,
  vaultPath: string,
  refs: string[],
  parentRef: string | null,
  embeds: EmbedEntry[],
  errors: EmbedError[],
  visited: Set<string>,
  maxEmbeds: number,
  maxFileSizeBytes: number,
  maxDepth: number,
  depth: number,
  transcriptStore?: TranscriptStore,
): Promise<void> {
  for (const ref of refs) {
    // Check embed limit
    if (embeds.length >= maxEmbeds) {
      errors.push({ reference: ref, error: 'TRUNCATED' });
      return;
    }

    // Resolve to file path
    const resolved = await resolveEmbedRef(db, vaultPath, ref);
    if (!resolved) {
      const retained = transcriptStore?.getByRef(ref);
      if (retained) {
        embeds.push({ reference: ref, mediaType: retained.media_type, text: retained.extracted_text, sourceDeleted: true, ...(parentRef ? { source: parentRef } : {}) });
      } else {
        errors.push({ reference: ref, error: `Could not resolve reference: ${ref}` });
      }
      continue;
    }
    const filePath = resolved.filePath;
    const resolvedNodeId = resolved.nodeId;

    // Check file size
    try {
      const stats = await stat(filePath);
      if (stats.size > maxFileSizeBytes) {
        // Too large to inline-extract here, but if we already have a retained
        // transcript (e.g. from prior indexing), serve that instead of erroring.
        // The source file exists (just oversized), so this is NOT sourceDeleted.
        const retained = transcriptStore?.getByRef(ref);
        if (retained) {
          embeds.push({ reference: ref, mediaType: retained.media_type, text: retained.extracted_text, ...(parentRef ? { source: parentRef } : {}) });
        } else {
          errors.push({ reference: ref, error: 'FILE_TOO_LARGE' });
        }
        continue;
      }
    } catch {
      // File doesn't exist on disk — fall back to a retained transcript if any.
      const retained = transcriptStore?.getByRef(ref);
      if (retained) {
        embeds.push({ reference: ref, mediaType: retained.media_type, text: retained.extracted_text, sourceDeleted: true, ...(parentRef ? { source: parentRef } : {}) });
      } else {
        errors.push({ reference: ref, error: `File not found: ${filePath}` });
      }
      continue;
    }

    // Try extraction
    try {
      const extraction = await cache.getExtraction(filePath);
      const entry: EmbedEntry = {
        reference: ref,
        mediaType: extraction.mediaType,
        text: extraction.text,
      };
      if (parentRef) {
        entry.source = parentRef;
      }
      embeds.push(entry);

      // Recursive markdown embeds
      if (extraction.mediaType === 'markdown' && depth < maxDepth && resolvedNodeId !== null) {
        if (!visited.has(resolvedNodeId)) {
          visited.add(resolvedNodeId);
          const subNode = db
            .prepare('SELECT body FROM nodes WHERE id = ?')
            .get(resolvedNodeId) as { body: string | null } | undefined;
          if (subNode?.body) {
            const subRefs = parseEmbedReferences(subNode.body);
            if (subRefs.length > 0) {
              await processEmbeds(
                db, cache, vaultPath, subRefs, ref, embeds, errors, visited,
                maxEmbeds, maxFileSizeBytes, maxDepth, depth + 1, transcriptStore,
              );
            }
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ reference: ref, error: message });
    }
  }
}
