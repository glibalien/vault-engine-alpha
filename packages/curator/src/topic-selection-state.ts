import type { EvidenceSpan } from './topic-evidence-selection.js';

export interface TopicCommittedSelection {
  version: 1; freshnessVersion: 1; freshnessHash: string; inputHash: string;
  policyVersion: 1; bodyCharCap: number | null; spans: readonly EvidenceSpan[];
  spansTruncated: boolean; originalBytes: number; retainedBytes: number;
}
export function parseTopicSelection(raw: string): TopicCommittedSelection {
  if (Buffer.byteLength(raw) > 16384) throw new Error('Topic selection metadata exceeds limit');
  const s = JSON.parse(raw) as TopicCommittedSelection;
  if (!s || s.version !== 1 || s.freshnessVersion !== 1 || s.policyVersion !== 1
    || !/^[a-f0-9]{64}$/.test(s.freshnessHash) || !/^[a-f0-9]{64}$/.test(s.inputHash)
    || (s.bodyCharCap !== null && (!Number.isSafeInteger(s.bodyCharCap) || s.bodyCharCap < 1))
    || !Number.isSafeInteger(s.originalBytes) || s.originalBytes < 0
    || !Number.isSafeInteger(s.retainedBytes) || s.retainedBytes < 0 || s.retainedBytes > s.originalBytes
    || typeof s.spansTruncated !== 'boolean' || !Array.isArray(s.spans) || s.spans.length > 64
    || s.spans.some(p => !p || !Number.isSafeInteger(p.startByte) || !Number.isSafeInteger(p.endByte)
      || p.startByte < 0 || p.endByte <= p.startByte || p.endByte > s.originalBytes)) {
    throw new Error('Invalid topic selection metadata');
  }
  return s;
}

import { createHash, type Hash } from 'node:crypto';
import { topicVaultSourceFingerprint } from './topic-refresh-evidence.js';
import type { TopicEvidenceSource, TopicEvidenceSelection } from './topic-evidence-selection.js';
import type { TopicCommittedSourceProjection } from './db/topic-refresh.js';

/** Run-local hashes retain no source text; baseline persistence happens only after all writes succeed. */
export function createTopicSelectionRecorder(sources: readonly TopicEvidenceSource[],
  projections: readonly TopicCommittedSourceProjection[], bodyCharCap: number | null) {
  const records = new Map<string, { hash: Hash; spans: EvidenceSpan[]; bodyIncluded: boolean }>();
  return {
    record(stage: string, target: string | undefined, selection: TopicEvidenceSelection): void {
      const excerpts = new Map(selection.excerpts.map(e => [e.sourceId, e]));
      for (const source of sources) {
        if (source.origin.kind !== 'node') continue;
        let record = records.get(source.id);
        if (!record) {
          record = { hash: createHash('sha256'), spans: [], bodyIncluded: false };
          records.set(source.id, record);
        }
        const excerpt = excerpts.get(source.id);
        record.hash.update(JSON.stringify({ stage, target, id: source.id, title: source.title, origin: source.origin,
          text: excerpt?.text ?? '', spans: excerpt?.spans ?? [] }) + '\n');
        if (excerpt && excerpt.retainedBytes > 0) {
          record.bodyIncluded = true;
          record.spans.push(...excerpt.spans);
        }
      }
    },
    committedSources(): TopicCommittedSourceProjection[] {
      return projections.map(projection => {
        const record = records.get(projection.nodeId);
        const source = sources.find(s => s.id === projection.nodeId);
        if (!record || !source || source.origin.kind !== 'node' || projection.evidenceState !== 'present') return projection;
        const spans: EvidenceSpan[] = [];
        for (const p of record.spans.sort((a, b) => a.startByte - b.startByte)) {
          const prior = spans.at(-1);
          if (prior && p.startByte <= prior.endByte) spans[spans.length - 1] = { startByte: prior.startByte, endByte: Math.max(prior.endByte, p.endByte) };
          else spans.push(p);
        }
        const inputHash = record.hash.copy().digest('hex');
        const fresh = topicVaultSourceFingerprint({ nodeId: source.origin.nodeId, title: source.title,
          types: [...source.origin.types], bodyIncluded: record.bodyIncluded, renderedBody: record.bodyIncluded ? source.body : '',
          ...(record.bodyIncluded && source.comparableBody !== undefined ? { comparableBody: source.comparableBody } : {}) });
        return { ...projection, bodyIncluded: record.bodyIncluded ? 1 : 0, evidenceHash: inputHash,
          selection: { version: 1, freshnessVersion: 1, freshnessHash: fresh.hash, inputHash,
            policyVersion: 1, bodyCharCap, spans: spans.slice(0, 64), spansTruncated: spans.length > 64,
            originalBytes: Buffer.byteLength(source.body), retainedBytes: spans.reduce((n, s) => n + s.endByte - s.startByte, 0) } };
      });
    },
  };
}
