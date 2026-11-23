import { describe, expect, it } from 'vitest';
import { pageEvidenceWithMemories, type PageSourceSelection } from '../src/provenance-page-evidence.js';
import { spanDigest } from '../src/provenance-evidence.js';
import { observedNode } from './provenance-page-fixtures.js';
import type { Memory } from '../src/types.js';

const memoryObservation = (id: number) => ({ ...observedNode(`m${id}`).provenance_observation!,
  source: { namespace: 'vault', kind: 'memory' as const, native_id: String(id) } });
const mem = (id: number, source: string, content: string): Memory => ({
  id, source, scope: 'vault', node_id: null, content, category: 'fact', created_at: '', updated_at: '',
  provenance_observation: memoryObservation(id),
});

describe('sub-page memories (#297)', () => {
  it("appends the build's memories after the page's notes, and attributes each memory line", () => {
    const node = observedNode('note');
    const memories = [mem(1, 'owner', 'Keep pages short — é'), mem(2, 'curator', 'The client runs its own gateway.')];
    const plain = pageEvidenceWithMemories([node], [], null, new Set(), memories);
    expect(plain).toContain('## OWNER MEMORIES');
    expect(plain.indexOf('[note]')).toBeLessThan(plain.indexOf('## OWNER MEMORIES'));
    expect(plain.indexOf('## OWNER MEMORIES')).toBeLessThan(plain.indexOf('## MEMORIES (durable facts about this project'));

    const selection: PageSourceSelection = { generatedAt: new Date(), items: [], omissions: [] };
    const text = pageEvidenceWithMemories([node], [], null, new Set(), memories, selection);
    expect(text).toBe(plain);
    const memoryItems = selection.items.filter(item => item.observation?.source.kind === 'memory');
    expect(memoryItems.map(item => [item.observation!.source.native_id, item.role])).toEqual([['1', 'human_correction'], ['2', 'generated_context']]);
    for (const item of memoryItems) {
      const span = item.spans[0]!;
      expect(Buffer.from(text).subarray(span.start, span.end).toString()).toMatch(/^- \[fact\] /);
      expect(item.input_digest).toBe(spanDigest(item.spans, { evidence: text }));
      expect(item.retained_bytes).toBe(span.end - span.start);
    }
  });

  it('shifts every note and memory span past a leading block, such as a rewrite\'s current page (#352)', () => {
    const memories = [mem(1, 'owner', 'Keep pages short — é'), mem(2, 'curator', 'The client runs its own gateway.')];
    const prefix = 'CURRENT PAGE (é)\n## Risks\n\n- Old.\n\nCHANGED NOTES\n\n';
    const selection: PageSourceSelection = { generatedAt: new Date(), items: [], omissions: [] };
    const text = pageEvidenceWithMemories([observedNode('note')], [], null, new Set(), memories, selection, 'project', prefix);
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.slice(prefix.length)).toBe(pageEvidenceWithMemories([observedNode('note')], [], null, new Set(), memories));
    const bytes = Buffer.from(text);
    for (const item of selection.items) {
      const span = item.spans[0]!;
      expect(span.start).toBeGreaterThanOrEqual(Buffer.byteLength(prefix));
      expect(item.input_digest).toBe(spanDigest(item.spans, { evidence: text }));
      expect(bytes.subarray(span.start, span.end).toString()).toMatch(/^(### \[note\]|- \[fact\] )/);
    }
  });

  it("keeps a memory's trailing whitespace inside the evidence its span points at", () => {
    const selection: PageSourceSelection = { generatedAt: new Date(), items: [], omissions: [] };
    const text = pageEvidenceWithMemories([observedNode('note')], [], null, new Set(),
      [mem(1, 'curator', 'Ends with a newline\n'), mem(2, 'chat', 'Ends with spaces   ')], selection);
    const bytes = Buffer.from(text);
    const memoryItems = selection.items.filter(item => item.observation?.source.kind === 'memory');
    expect(memoryItems).toHaveLength(2);
    for (const item of memoryItems) {
      const span = item.spans[0]!;
      expect(span.end).toBeLessThanOrEqual(bytes.length);
      expect(item.input_digest).toBe(spanDigest(item.spans, { evidence: text }));
    }
    expect(bytes.subarray(memoryItems[1]!.spans[0]!.start, memoryItems[1]!.spans[0]!.end).toString()).toBe('- [fact] Ends with spaces   ');
  });

  it('leaves the evidence unchanged without memories, and fails a captured memory with no observation', () => {
    const node = observedNode('note');
    expect(pageEvidenceWithMemories([node], [], null, new Set(), [])).not.toContain('MEMORIES');
    const bare = { ...mem(3, 'curator', 'x') }; delete (bare as { provenance_observation?: unknown }).provenance_observation;
    expect(() => pageEvidenceWithMemories([node], [], null, new Set(), [bare], { generatedAt: new Date(), items: [], omissions: [] }))
      .toThrow('PROVENANCE_OBSERVATION_MISSING');
  });
});
