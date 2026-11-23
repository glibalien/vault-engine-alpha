import { z } from 'zod';

/**
 * Memories v3 evidence provenance. Per-kind required fields:
 *   note         → node_id + hash (the source note and its content hash)
 *   conversation → ref ("<conversationId>#<messageIndex>", stamped by the chat server)
 *   curation-run → ref (curator runRef)
 * 'unknown' is a storage-only value for grandfathered pre-v3 rows — it is not
 * an accepted input kind. Evidence is REQUIRED on create since P2 (2026-07); 'unknown' survives only on grandfathered pre-v3 rows.
 */
export const EVIDENCE_KINDS = ['note', 'conversation', 'curation-run'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const evidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  node_id: z.string().optional(),
  hash: z.string().optional(),
  ref: z.string().optional(),
});

export type MemoryEvidence = z.infer<typeof evidenceSchema>;

/** Returns a human-readable error naming the missing fields, or null when valid. */
export function validateEvidence(e: MemoryEvidence): string | null {
  if (e.kind === 'note') {
    const missing = [
      ...(e.node_id ? [] : ['evidence.node_id']),
      ...(e.hash ? [] : ['evidence.hash']),
    ];
    return missing.length > 0 ? `evidence kind "note" requires ${missing.join(' and ')}` : null;
  }
  return e.ref ? null : `evidence kind "${e.kind}" requires evidence.ref`;
}
