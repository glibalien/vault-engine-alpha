import { truncate } from './evidence.js';
import type { PreparedCapture } from './llm/types.js';
import { pageNarrativeContext } from './page-markdown.js';
import { canonical, spanDigest } from './provenance-evidence.js';
import type { BundleV1, CaptureTarget, InputItem, Json, SourceObservation } from './provenance-types.js';
import type { EngineNode, Memory } from './types.js';
import { memoryRole, renderWikiMemories } from './wiki-memories.js';
import { renderPageRules, withoutRulesSection } from './page-rules.js';

export type PageCaptureContext = {
  projectId: string; runRef: string; target: CaptureTarget; generatedAt: Date; dryRun: boolean;
  items: InputItem[]; omissions: BundleV1['omissions'];
  /** The zone of the recorded Log stamp (`Config.curatorTz`); the host's when absent (#459). */
  timeZone?: string;
};
export type PageSourceSelection = Pick<PageCaptureContext, 'items' | 'omissions' | 'generatedAt'>;

/** Evidence offsets are recorded as blocks are appended, never by searching text. */
export function pageEvidence(nodes: readonly EngineNode[], ids: readonly string[], cap: number | null,
  wikiIds: ReadonlySet<string>, selection?: PageSourceSelection, start = 0): string {
  const selected = new Set(ids);
  const blocks: string[] = [];
  let offset = start;
  for (const node of nodes) {
    if (ids.length && !selected.has(node.id)) {
      selection?.omissions.push({ code: 'page_evidence_not_selected', source: node.provenance_observation?.source ?? null });
      continue;
    }
    const body = wikiIds.has(node.id) ? pageNarrativeContext(node.body ?? '') : (node.body ?? '').trim();
    const prefix = `### [${node.id}] ${node.title ?? node.file_path ?? node.id}\ntypes: ${node.types.join(', ') || '(none)'}\n`;
    const retained = truncate(body, cap);
    const block = prefix + (retained || '(empty body)');
    if (selection) selection.items.push(attributedItem('evidence', block, offset, node,
      'page-evidence:body.trim.prefix:v1', prefix + (body || '(empty body)'), retained !== body));
    blocks.push(block);
    offset += Buffer.byteLength(block) + 2;
  }
  return blocks.join('\n\n') || '(no matching source evidence was available)';
}

/**
 * A project sub-page's evidence: the selected notes, then the build's memories (#297), the same
 * blocks the home sees. With capture, each memory line is attributed to its memory. A `prefix`
 * (a rewrite's CURRENT PAGE block, #352) goes first, and the caller attributes it; every other
 * span starts after it.
 */
export function pageEvidenceWithMemories(nodes: readonly EngineNode[], ids: readonly string[], cap: number | null,
  wikiIds: ReadonlySet<string>, memories: readonly Memory[], selection?: PageSourceSelection,
  subject: 'project' | 'topic' = 'project', prefix = '', rules: readonly Memory[] = [], people: readonly string[] = [],
  conflicts: readonly string[] = []): string {
  // The project's people and companies go after the notes (#474 idea 4); they are its note titles.
  const notes = pageEvidence(nodes, ids, cap, wikiIds, selection, Buffer.byteLength(prefix));
  const base = prefix + notes + (people.length > 0 ? `\n\n${people.join('\n')}` : '');
  const rendered = renderWikiMemories(memories, subject);
  // Drop only the renderer's trailing separator lines: a memory's own bytes are kept exactly.
  const lines = [...rendered.lines];
  while (lines.at(-1) === '') lines.pop();
  // Memory pairs nothing has settled follow the memories (#474 idea 4).
  if (conflicts.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(...conflicts);
  }
  // The page's rules on what to say come last (#474 idea 4), each attributed to its memory.
  const ruleLines = renderPageRules(rules);
  const entries: Array<{ readonly lineIndex: number; readonly memory: Memory; readonly truncated: boolean; readonly originalBytes: number }> =
    [...rendered.entries];
  if (ruleLines.length > 0) {
    const start = lines.length + (lines.length > 0 ? 1 : 0);
    if (lines.length > 0) lines.push('');
    lines.push(...ruleLines);
    rules.forEach((rule, index) => entries.push({ lineIndex: start + 1 + index, memory: rule, truncated: false,
      originalBytes: Buffer.byteLength(ruleLines[index + 1]!) }));
  }
  if (lines.length === 0) return base;
  const text = `${base}\n\n${lines.join('\n')}`;
  if (selection) {
    let offset = Buffer.byteLength(`${base}\n\n`);
    lines.forEach((line, index) => {
      const entry = entries.find(e => e.lineIndex === index);
      if (entry) {
        const observation = entry.memory.provenance_observation;
        if (observation === undefined) throw new Error('PROVENANCE_OBSERVATION_MISSING');
        const spans = [{ field: 'evidence', start: offset, end: offset + Buffer.byteLength(line) }];
        selection.items.push({ key: `evidence:${offset}`, observation, role: memoryRole(entry.memory), upstream_derivation_id: null,
          selection: 'memory:v2', spans, original_bytes: entry.truncated ? entry.originalBytes : Buffer.byteLength(line),
          retained_bytes: Buffer.byteLength(line), input_digest: spanDigest(spans, { evidence: text }),
          truncated: entry.truncated, origin: 'identified' });
      }
      offset += Buffer.byteLength(line) + 1;
    });
  }
  return text;
}

/** A wiki page as a writer sees it: its narrative, without the rules section code writes (#474 idea 4). */
export function pageContextNode(node: EngineNode, cap: number | null): { id: string; title: string; body: string } {
  return { id: node.id, title: node.title ?? node.file_path ?? node.id,
    body: truncate(withoutRulesSection(pageNarrativeContext(node.body ?? '')), cap) };
}

/** Canonical JSON fields contain escaped strings: attribute their encoded bytes,
 * including a distinct array offset for every occurrence of a merge source. */
export function recordPageContext(selection: PageSourceSelection | undefined, field: 'current_target' | 'merge_sources',
  nodes: readonly EngineNode[], cap: number | null): void {
  if (!selection) return;
  let offset = field === 'merge_sources' ? 1 : 0;
  for (const node of nodes) {
    const retained = canonical(pageContextNode(node, cap));
    const original = canonical(pageContextNode(node, null));
    selection.items.push(attributedItem(field, retained, offset, node, 'page-narrative-context.prefix:v1', original, retained !== original));
    offset += Buffer.byteLength(retained) + 1;
  }
}

export function hasPageObservation(node: EngineNode): boolean {
  const observation = node.provenance_observation;
  return observation?.authority === 'engine' && observation.source.kind === 'node' && observation.source.native_id === node.id
    && (node.version === undefined || observation.native_version === node.version)
    && (node.metadata?.content_hash === undefined || observation.content_hash === node.metadata.content_hash);
}

function attributedItem(field: string, text: string, start: number, node: EngineNode,
  selection: string, original: string, truncated: boolean): InputItem {
  if (!hasPageObservation(node)) throw new Error('PROVENANCE_OBSERVATION_MISSING');
  const observation = node.provenance_observation as SourceObservation;
  const spans = [{ field, start, end: start + Buffer.byteLength(text) }];
  // Prefix padding only supplies the byte coordinates to the shared digest.
  return { key: `${field}:${start}`, observation, role: 'source_material', upstream_derivation_id: null,
    selection, spans, original_bytes: Buffer.byteLength(original), retained_bytes: Buffer.byteLength(text),
    input_digest: spanDigest(spans, { [field]: ' '.repeat(start) + text }), truncated, origin: 'identified' };
}

/** Mirrors Engine's subpage decoder, deriving only fields actually in the SDK
 * payload. Prompt-only schemas remain in system; no unsent schema field exists. */
export function capturedPageBundle(capture: PreparedCapture, context: PageCaptureContext): BundleV1 {
  const payload = capture.payload as Record<string, Json>;
  const messages = payload.messages as Array<{ role: string; content: string }>;
  const anthropic = capture.provider === 'anthropic';
  const user = messages[anthropic ? 0 : 1]!.content;
  const system = anthropic ? (payload.system as Array<{ text: string }>)[0]!.text : messages[0]!.content;
  const input = JSON.parse(user) as Record<string, Json>;
  const decoded_fields: Record<string, string> = { system, user };
  for (const key of ['action', 'title', 'kind', 'synthesis_brief', 'evidence']) {
    if (typeof input[key] !== 'string') throw new Error('PROVENANCE_UNAVAILABLE');
    decoded_fields[key] = input[key];
  }
  for (const key of ['scope', 'sibling_scopes', 'current_target', 'merge_sources']) {
    if (input[key] !== undefined) decoded_fields[key] = canonical(input[key]);
  }
  if (input.source_files_remain_historical !== undefined) decoded_fields.source_files_remain_historical = String(input.source_files_remain_historical);
  const items = structuredClone(context.items);
  for (const item of items) {
    const retained = item.spans.reduce((total, span) => {
      const field = decoded_fields[span.field];
      const bytes = field === undefined ? undefined : Buffer.from(field);
      if (!bytes || span.start < 0 || span.end <= span.start || span.end > bytes.length
        || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || [span.start, span.end].some(position => position < bytes.length && (bytes[position]! & 0xc0) === 0x80)) throw new Error('PROVENANCE_UNAVAILABLE');
      return total + span.end - span.start;
    }, 0);
    if (retained !== item.retained_bytes || spanDigest(item.spans, decoded_fields) !== item.input_digest) throw new Error('PROVENANCE_UNAVAILABLE');
  }
  for (const field of Object.keys(decoded_fields)) {
    if (field === 'user' || items.some(item => item.spans.some(span => span.field === field))) continue;
    const end = Buffer.byteLength(decoded_fields[field]!);
    if (!end) continue;
    const spans = [{ field, start: 0, end }];
    items.push({ key: field, observation: null, role: 'generated_context', upstream_derivation_id: null,
      selection: `${field}:v1`, spans, original_bytes: null, retained_bytes: end,
      input_digest: spanDigest(spans, decoded_fields), truncated: false, origin: 'opaque' });
  }
  return { version: 1, provider: capture.provider, model: capture.model, target: { ...context.target }, provider_payload: capture.payload,
    decoded_fields, items, omissions: structuredClone(context.omissions), dependency_coverage: 'direct_with_opaque_components',
    transform: { assembly: 'project-subpage-evidence-v1', prompt: 'project-subpage-v1', schema: 'page-synthesis-v1',
      adapter: capture.adapter_version, output: 'managed-subpage-contribution-v1' } };
}
