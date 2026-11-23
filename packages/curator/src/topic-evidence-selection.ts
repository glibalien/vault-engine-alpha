import { createHash } from 'node:crypto';

export interface TopicEvidenceSource {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** A vault source's body as wikis compare it (#332; `comparableTopicBody`), for its fingerprint. */
  readonly comparableBody?: string;
  readonly priority: 'changed' | 'explicit' | 'semantic' | 'web';
  readonly availability: 'present' | 'missing' | 'unavailable';
  readonly origin: { readonly kind: 'node'; readonly nodeId: string; readonly types: readonly string[] }
    | { readonly kind: 'web'; readonly url: string };
}
export interface EvidenceSpan { readonly startByte: number; readonly endByte: number }
export interface SourceExcerpt {
  readonly sourceId: string; readonly text: string; readonly spans: readonly EvidenceSpan[];
  readonly originalBytes: number; readonly retainedBytes: number;
}
export interface EvidenceOmission {
  readonly sourceId: string;
  readonly reason: 'unavailable' | 'not_selected' | 'per_source_limit' | 'request_limit';
}
export interface TopicEvidenceSelection {
  readonly policyVersion: 1;
  readonly excerpts: readonly SourceExcerpt[];
  readonly omissions: readonly EvidenceOmission[];
}
const rank = { changed: 0, explicit: 1, semantic: 2, web: 3 } as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function webSourceId(url: string): string {
  return 'web:' + createHash('sha256').update(new URL(url).href).digest('hex');
}
function terms(text: string): string[] {
  return [...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

/** Missing planner selection is a visible lexical fallback, never "all sources". */
export function fallbackTopicPageSourceIds(sources: readonly TopicEvidenceSource[], query: string): string[] {
  const keywords = terms(query);
  const matching = sources.filter(s => {
    const content = new Set(terms(s.title + ' ' + s.body));
    return keywords.some(word => content.has(word));
  });
  return (matching.length ? matching : sources.filter(s => s.priority === 'explicit' || s.priority === 'changed'))
    .map(s => s.id);
}
function prefixBytes(bytes: Buffer, limit: number): number {
  let end = Math.min(bytes.length, Math.max(0, Math.floor(limit)));
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}
/** Keep original byte coordinates even when query matching normalizes Unicode. */
function matchingWindow(bytes: Buffer, limit: number, keywords: readonly string[]): EvidenceSpan {
  let startByte = 0;
  if (bytes.length > limit && keywords.length) {
    const text = bytes.toString('utf8');
    for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
      if (!terms(match[0]).some(term => keywords.includes(term))) continue;
      const matchStart = Buffer.byteLength(text.slice(0, match.index));
      const matchBytes = Buffer.byteLength(match[0]);
      startByte = Math.max(0, Math.min(bytes.length - limit,
        matchStart - Math.floor(Math.max(0, limit - matchBytes) / 2)));
      while (startByte < bytes.length && (bytes[startByte]! & 0xc0) === 0x80) startByte++;
      break;
    }
  }
  return { startByte, endByte: startByte + prefixBytes(bytes.subarray(startByte), limit) };
}
function excerpt(source: TopicEvidenceSource, budget: number, query: string): SourceExcerpt {
  const bytes = Buffer.from(source.body);
  if (bytes.length <= budget) return { sourceId: source.id, text: source.body,
    spans: bytes.length ? [{ startByte: 0, endByte: bytes.length }] : [], originalBytes: bytes.length, retainedBytes: bytes.length };
  const keywords = terms(query);
  // Paragraphs carry the complete governing heading chain. A qualifier may not
  // be dropped just because its paragraph scored higher than the heading.
  type Block = EvidenceSpan & { score: number; headings: EvidenceSpan[]; isHeading: boolean };
  const blocks: Block[] = [];
  const headings: Array<EvidenceSpan & { level: number }> = [];
  let offset = 0;
  let paragraph: EvidenceSpan | undefined;
  const addParagraph = () => {
    if (!paragraph) return;
    const tokens = new Set(terms(headings.map(h => bytes.subarray(h.startByte, h.endByte).toString()).join(' ')
      + ' ' + bytes.subarray(paragraph.startByte, paragraph.endByte).toString()));
    blocks.push({ ...paragraph, score: keywords.reduce((n, t) => n + Number(tokens.has(t)), 0),
      headings: headings.map(h => ({ startByte: h.startByte, endByte: h.endByte })), isHeading: false });
    paragraph = undefined;
  };
  for (const line of source.body.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const end = offset + Buffer.byteLength(line[0]);
    const heading = /^ {0,3}(#{1,6})[ \t]+/.exec(line[0]);
    if (heading) {
      addParagraph();
      const level = heading[1]!.length;
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      const tokens = new Set(terms(line[0]));
      blocks.push({ startByte: offset, endByte: end, isHeading: true,
        score: keywords.reduce((n, t) => n + Number(tokens.has(t)), 0),
        headings: headings.map(h => ({ startByte: h.startByte, endByte: h.endByte })) });
      headings.push({ startByte: offset, endByte: end, level });
    } else if (!line[0].trim()) addParagraph();
    else paragraph = { startByte: paragraph?.startByte ?? offset, endByte: end };
    offset = end;
  }
  addParagraph();
  const ordered = [...blocks].sort((a, b) => b.score - a.score || a.startByte - b.startByte);
  const candidates = [...ordered.filter(b => b.score > 0), blocks[0], blocks.at(-1), ...ordered]
    .filter((b): b is NonNullable<typeof b> => b !== undefined);
  const seen = new Set<number>(), chosen = new Map<number, EvidenceSpan>();
  let left = budget;
  for (const b of candidates) {
    if (seen.has(b.startByte) || chosen.has(b.startByte) || left < 1) continue;
    seen.add(b.startByte);
    const needed = b.headings.filter(h => !chosen.has(h.startByte));
    const contextBytes = needed.reduce((n, h) => n + h.endByte - h.startByte, 0);
    if (contextBytes >= left) continue;
    const blockBytes = bytes.subarray(b.startByte, b.endByte);
    const window = matchingWindow(blockBytes, left - contextBytes, b.isHeading ? [] : keywords);
    const length = window.endByte - window.startByte;
    if (length === 0 || (b.isHeading && length !== b.endByte - b.startByte)) continue;
    for (const h of needed) chosen.set(h.startByte, h);
    chosen.set(b.startByte, { startByte: b.startByte + window.startByte, endByte: b.startByte + window.endByte });
    left -= contextBytes + length;
  }
  const spans: EvidenceSpan[] = [];
  for (const span of [...chosen.values()].sort((a, b) => a.startByte - b.startByte)) {
    const prior = spans.at(-1);
    if (prior && prior.endByte === span.startByte) spans[spans.length - 1] = { startByte: prior.startByte, endByte: span.endByte };
    else spans.push(span);
  }
  return { sourceId: source.id, text: spans.map(s => bytes.subarray(s.startByte, s.endByte).toString('utf8')).join('\n[… excerpt gap …]\n'),
    spans, originalBytes: bytes.length, retainedBytes: budget - left };
}

export function selectTopicEvidence(input: {
  sources: readonly TopicEvidenceSource[]; query: string; selectedIds?: readonly string[];
  totalTextBytes: number; perSourceBytes: number;
}): TopicEvidenceSelection {
  if (!Number.isSafeInteger(input.totalTextBytes) || input.totalTextBytes < 0
    || !Number.isSafeInteger(input.perSourceBytes) || input.perSourceBytes < 1) throw new Error('Invalid topic selection budget');
  const byId = new Map(input.sources.map(s => [s.id, s]));
  if (input.selectedIds?.some(id => !byId.has(id))) throw new Error('Unknown topic evidence ID');
  const selected = input.selectedIds === undefined ? undefined : new Set(input.selectedIds);
  const sources = [...byId.values()].sort((a, b) => rank[a.priority] - rank[b.priority] || compare(a.id, b.id));
  const eligible = sources.filter(s => s.availability === 'present' && (!selected || selected.has(s.id)));
  const allowances = new Map<string, number>();
  let left = input.totalTextBytes;
  for (const s of eligible.filter(s => s.priority === 'changed' || s.priority === 'explicit')) {
    const n = Math.min(512, input.perSourceBytes, Buffer.byteLength(s.body), left);
    allowances.set(s.id, n); left -= n;
  }
  for (const s of eligible) {
    const had = allowances.get(s.id) ?? 0;
    const n = Math.min(Math.max(0, Math.min(input.perSourceBytes, Buffer.byteLength(s.body)) - had), left);
    allowances.set(s.id, had + n); left -= n;
  }
  const excerpts: SourceExcerpt[] = [], omissions: EvidenceOmission[] = [];
  for (const s of sources) {
    if (s.availability !== 'present') { omissions.push({ sourceId: s.id, reason: 'unavailable' }); continue; }
    if (selected && !selected.has(s.id)) { omissions.push({ sourceId: s.id, reason: 'not_selected' }); continue; }
    const limit = allowances.get(s.id) ?? 0;
    if (limit === 0 && s.body.length > 0) { omissions.push({ sourceId: s.id, reason: 'request_limit' }); continue; }
    const e = excerpt(s, limit, input.query);
    excerpts.push(e);
    if (e.retainedBytes < e.originalBytes) omissions.push({ sourceId: s.id,
      reason: e.originalBytes > input.perSourceBytes ? 'per_source_limit' : 'request_limit' });
  }
  return { policyVersion: 1, excerpts, omissions };
}

export function renderTopicEvidence(selection: TopicEvidenceSelection, sources: readonly TopicEvidenceSource[]): string {
  const byId = new Map(sources.map(s => [s.id, s]));
  const inventory = sources.map(s => ({ id: s.id, title: s.title, origin: s.origin, availability: s.availability }));
  const blocks = selection.excerpts.map(e => {
    const s = byId.get(e.sourceId)!;
    return '### ' + s.title + '\nSource ID: ' + s.id
      + (s.origin.kind === 'web' ? '\nURL: ' + s.origin.url : '')
      + (e.retainedBytes < e.originalBytes ? '\n[Partial source excerpts]' : '') + '\n' + e.text;
  });
  return ['## Source inventory (metadata only; not proof of review)', JSON.stringify(inventory),
    '## Selected evidence', ...blocks, '## Omissions', JSON.stringify(selection.omissions),
    'Excerpts are partial. Omitted sources were not reviewed in full. Do not infer their contents.'].join('\n\n');
}
