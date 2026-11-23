import type Database from 'better-sqlite3';
import { ContentHashMismatchError } from '../../pipeline/execute.js';
import { fail } from './errors.js';
import { buildCurrentNodeForStale } from './stale-helpers.js';

export function buildContentHashMismatchDetails(db: Database.Database, err: ContentHashMismatchError): Record<string, unknown> {
  const details: Record<string, unknown> = {
    expected_content_hash: err.expectedHash,
    current_content_hash: err.currentHash,
  };
  const currentNode = buildCurrentNodeForStale(db, err.nodeId);
  if (currentNode !== undefined) details.current_node = currentNode;
  return details;
}

export function buildContentHashMismatchEnvelope(db: Database.Database, err: ContentHashMismatchError) {
  return fail(
    'CONTENT_HASH_MISMATCH',
    `Node ${err.nodeId} changed on disk since you read it — reload or overwrite.`,
    { details: buildContentHashMismatchDetails(db, err) },
  );
}
