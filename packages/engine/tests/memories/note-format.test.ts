import { describe, it, expect } from 'vitest';
import {
  memoryNotePath,
  editableMemoryHash,
  renderMemoryNote,
  parseMemoryNote,
  validateParsedMemoryNote,
  rowToPayload,
  MEMORY_LOG_VERSION,
  type MemoryBlockPayload,
  type NewMemoryBlockPayload,
} from '../../src/memories/note-format.js';
import type { MemoryProjectionRow } from '../../src/memories/types.js';

function row(partial: Partial<MemoryProjectionRow> & { id: number; content: string; updated_at: string; source: string }): MemoryProjectionRow {
  return {
    scope: 'vault',
    node_id: null,
    category: null,
    metadata: null,
    created_at: partial.updated_at,
    expired_at: null,
    valid_at: partial.updated_at,
    invalid_at: null,
    superseded_by: null,
    predecessors: [],
    evidence_kind: 'conversation',
    evidence_node_id: null,
    evidence_hash: null,
    evidence_ref: 'test#0',
    expire_reason: null,
    changed_by: null,
    embedded: false,
    subjects: [],
    ...partial,
  };
}

const SAMPLE_ROW = row({
  id: 418,
  content: 'Avery prefers concise implementation plans.',
  category: 'correction',
  source: 'chat',
  updated_at: '2026-08-12T14:03:11.000Z',
});

describe('memoryNotePath', () => {
  it('places the note in the settings dir', () => {
    expect(memoryNotePath('Settings')).toBe('Settings/Memories.md');
  });
});

describe('editableMemoryHash', () => {
  it('is sha256-prefixed and stable for identical content/category/status', () => {
    const h = editableMemoryHash({ content: 'x', category: 'fact', status: 'live' });
    expect(h.startsWith('sha256:')).toBe(true);
    expect(h).toBe(editableMemoryHash({ content: 'x', category: 'fact', status: 'live' }));
  });
  it('differs when any editable field differs', () => {
    const a = editableMemoryHash({ content: 'x', category: 'fact', status: 'live' });
    expect(editableMemoryHash({ content: 'y', category: 'fact', status: 'live' })).not.toBe(a);
    expect(editableMemoryHash({ content: 'x', category: 'preference', status: 'live' })).not.toBe(a);
    expect(editableMemoryHash({ content: 'x', category: 'fact', status: 'expired' })).not.toBe(a);
  });
  it('is key-order independent (canonical JSON)', () => {
    expect(editableMemoryHash({ content: 'x', category: null, status: 'live' }))
      .toBe(editableMemoryHash({ content: 'x', category: null, status: 'live' }));
  });
});

describe('renderMemoryNote', () => {
  it('renders the canonical frontmatter + sections + footer', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    expect(rendered.bytes).toContain('---');
    expect(rendered.bytes).toContain('vault_engine_projection: memories');
    expect(rendered.bytes).toContain(`memory_log_version: ${MEMORY_LOG_VERSION}`);
    expect(rendered.bytes).toContain('live_count: 1');
    expect(rendered.bytes).toContain('historical_count: 0');
    expect(rendered.bytes).toContain('## Live — Rules, corrections and preferences');
    expect(rendered.bytes).toContain('## Live — Other memories');
    expect(rendered.bytes).toContain('## Historical — Expired and superseded');
    expect(rendered.bytes).toContain('How this stays current');
    expect(rendered.hash.startsWith('sha256:')).toBe(true);
    expect(rendered.snapshot_at).toBe('2026-08-12T14:03:11.000Z');
  });

  it('groups rules/corrections/preferences first, other live second, historical last', () => {
    const corr = row({ id: 1, content: 'pref', category: 'preference', source: 'a', updated_at: '2026-01-01T00:00:00.000Z' });
    const rule = row({ id: 4, content: 'never say X', category: 'rule', source: 'a', updated_at: '2026-01-01T00:00:00.000Z' });
    const other = row({ id: 2, content: 'fact', category: 'fact', source: 'a', updated_at: '2026-01-02T00:00:00.000Z' });
    const hist = row({ id: 3, content: 'old', category: 'fact', source: 'a', updated_at: '2026-01-03T00:00:00.000Z', expired_at: '2026-01-04T00:00:00.000Z' });
    const rendered = renderMemoryNote([corr, other, hist, rule], []);
    const corrIdx = rendered.bytes.indexOf('## Live — Rules, corrections and preferences');
    const otherIdx = rendered.bytes.indexOf('## Live — Other memories');
    const histIdx = rendered.bytes.indexOf('## Historical — Expired and superseded');
    expect(corrIdx).toBeLessThan(otherIdx);
    expect(otherIdx).toBeLessThan(histIdx);
    expect(rendered.bytes.indexOf('Memory 1 — preference')).toBeGreaterThan(corrIdx);
    expect(rendered.bytes.indexOf('Memory 1 — preference')).toBeLessThan(otherIdx);
    expect(rendered.bytes.indexOf('Memory 4 — rule')).toBeGreaterThan(corrIdx);
    expect(rendered.bytes.indexOf('Memory 4 — rule')).toBeLessThan(otherIdx);
  });

  it('sorts within a section by source ASC, scope ASC, updated_at DESC, id DESC', () => {
    const r1 = row({ id: 10, content: 'a', source: 'chat', scope: 'vault', updated_at: '2026-03-01T00:00:00.000Z' });
    const r2 = row({ id: 11, content: 'b', source: 'chat', scope: 'vault', updated_at: '2026-03-02T00:00:00.000Z' });
    const r3 = row({ id: 12, content: 'c', source: 'curator', scope: 'vault', updated_at: '2026-03-01T00:00:00.000Z' });
    const rendered = renderMemoryNote([r1, r2, r3], []);
    const i11 = rendered.bytes.indexOf('Memory 11 —');
    const i10 = rendered.bytes.indexOf('Memory 10 —');
    const i12 = rendered.bytes.indexOf('Memory 12 —');
    expect(i11).toBeLessThan(i10);
    expect(i10).toBeLessThan(i12);
  });

  it('renders an issues callout when issues are present', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], [
      { block_key: 'mem:5', outcome: 'conflict', message: 'stale revision' },
    ]);
    expect(rendered.bytes).toContain('> [!warning] Memory note ingest issues');
    expect(rendered.bytes).toContain('`mem:5` (conflict) — stale revision');
  });

  it('empty stock renders empty sections and a deterministic snapshot_at', () => {
    const rendered = renderMemoryNote([], [], { snapshotAt: '2026-08-13T09:00:00.000Z' });
    expect(rendered.live_count).toBe(0);
    expect(rendered.historical_count).toBe(0);
    expect(rendered.snapshot_at).toBe('2026-08-13T09:00:00.000Z');
    expect(rendered.bytes).toContain('_None._');
  });

  it('chooses a tilde fence longer than any all-tilde line in the payload', () => {
    const tricky = row({ id: 99, content: '~~~~\n~~~~~\nbe careful', source: 'chat', updated_at: '2026-01-01T00:00:00.000Z' });
    const rendered = renderMemoryNote([tricky], []);
    const fenceMatches = rendered.bytes.match(/^(~+)\s*$/gm) ?? [];
    const fenceLens = fenceMatches.map((f) => f.trim().length);
    expect(Math.max(...fenceLens)).toBeGreaterThan(5);
  });

  it('is byte-identical across two calls with the same input (deterministic)', () => {
    const a = renderMemoryNote([SAMPLE_ROW], []);
    const b = renderMemoryNote([SAMPLE_ROW], []);
    expect(a.bytes).toBe(b.bytes);
    expect(a.hash).toBe(b.hash);
  });

  it('keeps memory payload inside fenced code (no body wiki-links from [[links]] in content)', () => {
    const withLink = row({ id: 7, content: 'See [[Project X]] for context', source: 'chat', updated_at: '2026-01-01T00:00:00.000Z' });
    const rendered = renderMemoryNote([withLink], []);
    expect(rendered.bytes).toContain('See [[Project X]] for context');
    const yamlFenceIdx = rendered.bytes.indexOf('~~~yaml');
    const linkIdx = rendered.bytes.indexOf('See [[Project X]]');
    expect(yamlFenceIdx).toBeLessThan(linkIdx);
  });
});

describe('parseMemoryNote + validateParsedMemoryNote round-trip', () => {
  it('round-trips a rendered note: parse → validate → all no-ops', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    const parsed = parseMemoryNote(rendered.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = validateParsedMemoryNote(parsed, [SAMPLE_ROW]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]!.kind).toBe('noop');
  });

  it('detects a content edit as content-or-category', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    const edited = rendered.bytes.replace('Avery prefers concise implementation plans.', 'Avery prefers verbose implementation plans.');
    const parsed = parseMemoryNote(edited);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, [SAMPLE_ROW]);
    if (!plan.ok) throw new Error('validate failed');
    expect(plan.ops.some((o) => o.kind === 'content-or-category')).toBe(true);
  });

  it('detects a category edit as content-or-category (no content change)', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    const edited = rendered.bytes.replace('category: correction', 'category: preference');
    const parsed = parseMemoryNote(edited);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, [SAMPLE_ROW]);
    if (!plan.ok) throw new Error('validate failed');
    expect(plan.ops.some((o) => o.kind === 'content-or-category')).toBe(true);
  });

  it('detects a status live→expired as expire', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    const edited = rendered.bytes.replace('status: live', 'status: expired');
    const parsed = parseMemoryNote(edited);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, [SAMPLE_ROW]);
    if (!plan.ok) throw new Error('validate failed');
    expect(plan.ops.some((o) => o.kind === 'expire')).toBe(true);
  });

  it('detects a status expired→live as reactivate', () => {
    const expiredRow = row({ id: 5, content: 'gone', source: 'chat', updated_at: '2026-01-01T00:00:00.000Z', expired_at: '2026-01-02T00:00:00.000Z' });
    const rendered = renderMemoryNote([expiredRow], []);
    const edited = rendered.bytes.replace('status: expired', 'status: live');
    const parsed = parseMemoryNote(edited);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, [expiredRow]);
    if (!plan.ok) throw new Error('validate failed');
    expect(plan.ops.some((o) => o.kind === 'reactivate')).toBe(true);
  });

  it('rejects a compound edit (status + content) as invalid', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    let edited = rendered.bytes.replace('status: live', 'status: expired');
    edited = edited.replace('Avery prefers concise implementation plans.', 'Avery prefers verbose plans.');
    const parsed = parseMemoryNote(edited);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, [SAMPLE_ROW]);
    expect(!plan.ok).toBe(true);
    if (!plan.ok) {
      expect(plan.errors[0]!.message).toMatch(/two daily cycles/);
    }
  });

  it('rejects a read-only field change (source)', () => {
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    const edited = rendered.bytes.replace('source: chat', 'source: owner');
    const parsed = parseMemoryNote(edited);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, [SAMPLE_ROW]);
    expect(!plan.ok).toBe(true);
    if (!plan.ok) {
      expect(plan.errors[0]!.message).toMatch(/read-only field "source"/);
    }
  });

  it('deletion-by-omission: a canonical block missing from the note is an absent no-op', () => {
    const other = row({ id: 2, content: 'other', source: 'chat', updated_at: '2026-01-01T00:00:00.000Z' });
    const rendered = renderMemoryNote([SAMPLE_ROW], []);
    const parsed = parseMemoryNote(rendered.bytes);
    if (!parsed.ok) throw new Error('parse failed');
    const plan = validateParsedMemoryNote(parsed, [SAMPLE_ROW, other]);
    if (!plan.ok) throw new Error('validate failed');
    expect(plan.ops.some((o) => o.kind === 'absent' && o.id === 2)).toBe(true);
  });

  it('parses a new:<uuid> owner draft and validate routes it to create-owner', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const draftNote = `<!-- ve:memory:new:${uuid} revision="new" base="sha256:dummy" -->
~~~~yaml
id: new:${uuid}
status: live
content: A durable owner-authored fact.
category: fact
scope: vault
node_id:
~~~~
<!-- /ve:memory:new:${uuid} -->
`;
    const parsed = parseMemoryNote(draftNote);
    if (!parsed.ok) throw new Error(`parse failed: ${JSON.stringify(parsed)}`);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]!.id).toBe(`new:${uuid}`);
    const plan = validateParsedMemoryNote(parsed, []);
    if (!plan.ok) throw new Error('validate failed');
    expect(plan.ops.some((o) => o.kind === 'create-owner' && o.draft?.content === 'A durable owner-authored fact.')).toBe(true);
  });
});

describe('parseMemoryNote error cases', () => {
  it('rejects an unclosed frontmatter', () => {
    const parsed = parseMemoryNote('---\nsome: yaml\n');
    expect(!parsed.ok).toBe(true);
  });

  it('rejects an open marker with no fenced payload', () => {
    const note = `<!-- ve:memory:1 revision="t" base="sha256:x" -->
some prose
<!-- /ve:memory:1 -->`;
    const parsed = parseMemoryNote(note);
    expect(!parsed.ok).toBe(true);
  });

  it('rejects a fenced payload with no close marker', () => {
    const note = `<!-- ve:memory:1 revision="t" base="sha256:x" -->
~~~~yaml
id: 1
~~~~
orphan text`;
    const parsed = parseMemoryNote(note);
    expect(!parsed.ok).toBe(true);
  });

  it('rejects duplicate ids', () => {
    const canonical = renderMemoryNote([SAMPLE_ROW], []).bytes;
    const parsed = parseMemoryNote(`${canonical}\n${canonical}`);
    expect(!parsed.ok).toBe(true);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => /duplicate id/.test(e.message))).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    const note = `<!-- ve:memory:1 revision="t" base="sha256:x" -->
~~~~yaml
id: 1
status: archived
content: a
~~~~
<!-- /ve:memory:1 -->`;
    const parsed = parseMemoryNote(note);
    expect(!parsed.ok).toBe(true);
  });

  it('rejects unsupported log versions and malformed owner draft ids', () => {
    const unsupported = parseMemoryNote('---\nmemory_log_version: 2\n---\n');
    expect(!unsupported.ok).toBe(true);

    const malformedDraft = parseMemoryNote(`<!-- ve:memory:new:not-a-uuid revision="new" base="sha256:placeholder" -->
~~~~yaml
id: new:not-a-uuid
status: live
content: fact
scope: vault
~~~~
<!-- /ve:memory:new:not-a-uuid -->`);
    expect(!malformedDraft.ok).toBe(true);
  });

  it('rejects unexpected fields in an otherwise canonical block', () => {
    const bytes = renderMemoryNote([SAMPLE_ROW], []).bytes.replace('embedded: false', 'embedded: false\nmade_up: true');
    const parsed = parseMemoryNote(bytes);
    expect(!parsed.ok).toBe(true);
  });

  it('rejects invalid YAML in the payload', () => {
    const note = `<!-- ve:memory:1 revision="t" base="sha256:x" -->
~~~~yaml
id: 1
: : : broken
~~~~
<!-- /ve:memory:1 -->`;
    const parsed = parseMemoryNote(note);
    expect(!parsed.ok).toBe(true);
  });

  it('handles multiline and unicode content in a round-trip', () => {
    const r = row({ id: 42, content: 'Multi\nline\nÆvar þýði 中文', source: 'chat', updated_at: '2026-01-01T00:00:00.000Z' });
    const rendered = renderMemoryNote([r], []);
    const parsed = parseMemoryNote(rendered.bytes);
    if (!parsed.ok) throw new Error('parse failed');
    const payload = parsed.blocks[0]!.payload as MemoryBlockPayload;
    expect(payload.content).toBe('Multi\nline\nÆvar þýði 中文');
  });

  it('handles content with embedded backticks', () => {
    const r = row({ id: 43, content: 'Use `code` and ```blocks```', source: 'chat', updated_at: '2026-01-01T00:00:00.000Z' });
    const rendered = renderMemoryNote([r], []);
    const parsed = parseMemoryNote(rendered.bytes);
    if (!parsed.ok) throw new Error('parse failed');
    const payload = parsed.blocks[0]!.payload as MemoryBlockPayload;
    expect(payload.content).toBe('Use `code` and ```blocks```');
  });
});

describe('rowToPayload', () => {
  it('maps scope to vault|node and derives status from expired_at', () => {
    const live = rowToPayload(row({ id: 1, content: 'a', source: 'chat', updated_at: 't' }));
    expect(live.status).toBe('live');
    expect(live.scope).toBe('vault');
    const expired = rowToPayload(row({ id: 2, content: 'a', source: 'chat', updated_at: 't', expired_at: 't2' }));
    expect(expired.status).toBe('expired');
  });
});
