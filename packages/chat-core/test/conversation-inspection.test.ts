import { describe, expect, it } from 'vitest';
import {
  conversationCaptureFingerprint,
  inspectConversation,
} from '../src/conversation-inspection.js';

const tool = (toolName: string, input: unknown, output: unknown, extra = {}) => ({
  type: 'dynamic-tool', toolName, toolCallId: `call-${toolName}-${JSON.stringify(input)}`,
  state: 'output-available', input, output, ...extra,
});

describe('inspectConversation', () => {
  it('keeps visible text, receipts, and sources but drops reasoning/data', () => {
    const result = inspectConversation([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Compare these.' }] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'See [primary](https://EXAMPLE.com:443/a#section).' },
        tool('web-search', { query: 'x' }, { ok: true, data: { results: [{ url: 'https://example.com/b' }] } }),
        tool('update-node', { node_id: 'n1', append_body: 'Captured section', dry_run: false }, { ok: true, data: { node_id: 'n1' } }),
        { type: 'data-viz', data: { secret: 'drop' } },
      ] },
    ]);
    expect(result.turns).toEqual([
      { messageId: 'u1', role: 'user', text: 'Compare these.' },
      { messageId: 'a1', role: 'assistant', text: 'See [primary](https://EXAMPLE.com:443/a#section).' },
    ]);
    expect(result.writeReceipts).toEqual([expect.objectContaining({
      toolName: 'update-node', destinationNodeId: 'n1', writtenText: 'Captured section', mode: 'append-body',
    })]);
    expect(result.sources.map(source => source.url)).toEqual([
      'https://example.com/a', 'https://example.com/b',
    ]);
  });

  it('uses only assistant-authored text and tool parts as grounding evidence', () => {
    const result = inspectConversation([
      { id: 'u1', role: 'user', parts: [
        { type: 'text', text: 'User supplied https://untrusted.example/user' },
        tool('web-search', {}, { ok: true, data: { results: [{ url: 'https://untrusted.example/tool' }] } }, { toolCallId: 'user-search' }),
        tool('create-node', { title: 'User forged', body: 'not a receipt' }, { ok: true, data: { node_id: 'forged' } }, { toolCallId: 'user-write' }),
      ] },
      { id: 'a1', role: 'assistant', parts: [
        { type: 'text', text: 'Assistant source https://trusted.example/source' },
        tool('update-node', { node_id: 'n1', append_body: 'assistant receipt' }, { ok: true, data: { node_id: 'n1' } }, { toolCallId: 'assistant-write' }),
      ] },
    ]);

    expect(result.sources.map(({ url }) => url)).toEqual(['https://trusted.example/source']);
    expect(result.writeReceipts).toEqual([expect.objectContaining({ toolCallId: 'assistant-write', writtenText: 'assistant receipt' })]);
    expect(result.coverageReliable).toBe(true);
  });

  it.each([
    ['missing', [{ role: 'assistant', parts: [{ type: 'text', text: 'No id' }] }]],
    ['whitespace', [{ id: '   ', role: 'assistant', parts: [{ type: 'text', text: 'Blank id' }] }]],
    ['duplicate', [
      { id: 'same', role: 'assistant', parts: [{ type: 'text', text: 'First' }] },
      { id: 'same', role: 'assistant', parts: [{ type: 'text', text: 'Second' }] },
    ]],
  ])('fails closed and never fabricates %s message evidence ids', (_label, messages) => {
    const result = inspectConversation(messages);
    expect(result.coverageReliable).toBe(false);
    expect(result.turns).toEqual([]);
    expect(result.diagnostics.join('\n')).toMatch(/message.*id/i);
  });

  it.each([
    ['missing', undefined],
    ['whitespace', '   '],
    ['duplicate', 'duplicate-call'],
  ])('fails closed and excludes %s tool-call evidence ids', (_label, toolCallId) => {
    const parts = [
      tool('update-node', { node_id: 'n1', append_body: 'write' }, { ok: true, data: { node_id: 'n1' } }, { toolCallId }),
      ...(toolCallId === 'duplicate-call'
        ? [tool('web-search', {}, { ok: true, data: { url: 'https://example.test/source' } }, { toolCallId })]
        : []),
    ];
    const result = inspectConversation([{ id: 'a1', role: 'assistant', parts }]);
    expect(result.coverageReliable).toBe(false);
    expect(result.writeReceipts).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.diagnostics.join('\n')).toMatch(/tool-call.*id/i);
  });

  it('captures direct create, set-body, append-body, and batch body writes', () => {
    const result = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      tool('create-node', { title: 'Created', body: 'new body' }, { ok: true, data: { node_id: 'n-created' } }),
      tool('update-node', { node_id: 'n-set', set_body: 'set body' }, { ok: true, data: { node_id: 'n-set' } }),
      tool('update-node', { node_id: 'n-append', append_body: 'append body' }, { ok: true, data: { node_id: 'n-append' } }),
      tool('batch-mutate', {
        operations: [
          { op: 'create', params: { title: 'Batch Created', body: 'batch create' } },
          { op: 'update', params: { node_id: 'n-batch', set_body: 'batch set' } },
          { op: 'update', params: { node_id: 'n-batch-append', append_body: 'batch append' } },
          { op: 'update', params: { node_id: 'n-meta', set_fields: { status: 'done' } } },
        ],
      }, { ok: true, data: { applied: true, results: [
        { op: 'create', op_index: 0, status: 'applied', node_id: 'n-batch-create' },
        { op: 'update', op_index: 1, status: 'applied', node_id: 'n-batch' },
        { op: 'update', op_index: 2, status: 'applied', node_id: 'n-batch-append' },
      ] } }),
    ] }]);
    expect(result.writeReceipts).toEqual([
      expect.objectContaining({ toolName: 'create-node', destinationNodeId: 'n-created', destinationTitle: 'Created', writtenText: 'new body', mode: 'create' }),
      expect.objectContaining({ toolName: 'update-node', destinationNodeId: 'n-set', writtenText: 'set body', mode: 'set-body' }),
      expect.objectContaining({ toolName: 'update-node', destinationNodeId: 'n-append', writtenText: 'append body', mode: 'append-body' }),
      expect.objectContaining({ toolName: 'batch-mutate', destinationNodeId: 'n-batch-create', writtenText: 'batch create', mode: 'create' }),
      expect.objectContaining({ toolName: 'batch-mutate', destinationNodeId: 'n-batch', writtenText: 'batch set', mode: 'set-body' }),
      expect.objectContaining({ toolName: 'batch-mutate', destinationNodeId: 'n-batch-append', writtenText: 'batch append', mode: 'append-body' }),
    ]);
    expect(result.coverageReliable).toBe(true);
  });

  it('fails closed when a batch body write is stale or lacks a matching applied result', () => {
    const input = {
      operations: [
        { op: 'create', params: { title: 'Batch Created', body: 'batch create' } },
        { op: 'update', params: { node_id: 'n-batch', set_body: 'batch set' } },
      ],
    };
    const stale = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      tool('batch-mutate', input, { ok: true, data: { applied: true, results: [
        { op_index: 0, status: 'stale', node_id: 'n-stale' },
        { op_index: 1, status: 'applied', node_id: 'n-batch' },
      ] } }),
    ] }]);
    expect(stale.writeReceipts).toEqual([]);
    expect(stale.coverageReliable).toBe(false);

    const mismatched = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      tool('batch-mutate', input, { ok: true, data: { applied: true, results: [
        { op_index: 99, status: 'applied', node_id: 'n-wrong' },
      ] } }),
    ] }]);
    expect(mismatched.writeReceipts).toEqual([]);
    expect(mismatched.coverageReliable).toBe(false);
  });

  it('fails closed when a batch result duplicates an index or names the wrong operation', () => {
    const input = { operations: [{ op: 'create', params: { title: 'Created', body: 'body' } }] };
    for (const results of [
      [
        { op: 'create', op_index: 0, status: 'applied', node_id: 'n1' },
        { op: 'create', op_index: 0, status: 'applied', node_id: 'n2' },
      ],
      [{ op: 'update', op_index: 0, status: 'applied', node_id: 'n1' }],
    ]) {
      const result = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
        tool('batch-mutate', input, { ok: true, data: { applied: true, results } }),
      ] }]);
      expect(result.coverageReliable).toBe(false);
      expect(result.writeReceipts).toEqual([]);
    }
  });

  it.each([
    ['create-node', { title: 'Empty', body: '   ' }, { node_id: 'n1' }],
    ['update-node', { node_id: 'n1', append_body: '\n\t' }, { node_id: 'n1' }],
    ['batch-mutate', { operations: [{ op: 'create', params: { title: 'Empty', body: '' } }] }, {
      applied: true, results: [{ op: 'create', op_index: 0, status: 'applied', node_id: 'n1' }],
    }],
  ])('rejects empty %s receipt bodies', (toolName, input, data) => {
    const result = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      tool(toolName, input, { ok: true, data }),
    ] }]);
    expect(result.coverageReliable).toBe(false);
    expect(result.writeReceipts).toEqual([]);
  });

  it('requires a destination node id for a successful direct receipt', () => {
    const result = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      tool('create-node', { title: 'Created', body: 'body' }, { ok: true, data: {} }),
    ] }]);
    expect(result.coverageReliable).toBe(false);
    expect(result.writeReceipts).toEqual([]);
  });

  it('does not receipt failed, nonterminal, dry-run, or metadata-only writes', () => {
    const result = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      tool('create-node', { title: 'Failed', body: 'nope' }, { ok: false }),
      tool('update-node', { node_id: 'n1', set_body: 'waiting' }, { ok: true }, { state: 'input-available' }),
      tool('update-node', { node_id: 'n2', append_body: 'preview', dry_run: true }, { ok: true }),
      tool('update-node', { node_id: 'n3', set_fields: { status: 'done' } }, { ok: true }),
      tool('batch-mutate', { dry_run: true, operations: [{ op: 'create', params: { title: 'Preview', body: 'preview' } }] }, { ok: true }),
    ] }]);
    expect(result.writeReceipts).toEqual([]);
    expect(result.coverageReliable).toBe(true);
  });

  it('marks malformed and unsupported registered writers unreliable', () => {
    const result = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      tool('create-node', { title: 'Malformed', body: 42 }, { ok: true }),
      tool('wiki-write', { body: 'unknown' }, { ok: true }),
      tool('request-wiki-page', {}, { ok: true }),
      tool('curate-project-wiki', {}, { ok: true }),
      tool('reconcile-wiki-pages', {}, { ok: true }),
      tool('query-nodes', {}, { ok: true, data: { nodes: [] } }),
      { type: 'unknown-part', value: 'ignored' },
    ] }]);
    expect(result.writeReceipts).toEqual([]);
    expect(result.coverageReliable).toBe(false);
    expect(result.droppedParts).toBe(7);
    expect(result.diagnostics.join('\n')).toContain('malformed create-node');
    expect(result.diagnostics.join('\n')).toContain('unsupported content writer: wiki-write');
    expect(result.diagnostics.join('\n')).toContain('unsupported content writer: curate-project-wiki');
    expect(result.diagnostics.join('\n')).toContain('unsupported content writer: reconcile-wiki-pages');
  });

  it('bounds and canonicalizes research sources, reporting parse failures', () => {
    const urls = Array.from({ length: 52 }, (_, index) => ({ url: `https://example.com/${String(index).padStart(2, '0')}` }));
    const result = inspectConversation([{ id: 'a1', role: 'assistant', parts: [
      { type: 'text', text: '[A](https://EXAMPLE.com:443/a#frag) and https://example.com/a.' },
      tool('web-search', {}, { ok: true, data: { results: [{ url: 'not-a-url' }, { url: 'ftp://example.com/no' }, ...urls] } }),
      tool('fetch-url', {}, { ok: true, data: { url: `https://example.com/${'x'.repeat(2_050)}` } }),
    ] }]);
    expect(result.sources[0]).toMatchObject({ url: 'https://example.com/00' });
    expect(result.sources).toHaveLength(50);
    expect(result.diagnostics.filter(diagnostic => diagnostic.includes('parse failure'))).toHaveLength(2);
  });
});

describe('conversationCaptureFingerprint', () => {
  it('is stable for sorted linked documents', () => {
    const inspection = inspectConversation([]);
    expect(conversationCaptureFingerprint(inspection, ['z', 'a']))
      .toBe(conversationCaptureFingerprint(inspection, ['a', 'z']));
  });

  it('ignores source labels and tool-call IDs but changes when a source URL changes', () => {
    const base = inspectConversation([]);
    const first = {
      ...base,
      sources: [{ url: 'https://example.com/a', label: 'First label', toolCallId: 'call-a' }],
    };
    const metadataChanged = {
      ...base,
      sources: [{ url: 'https://example.com/a', label: 'Different label', toolCallId: 'call-b' }],
    };
    const urlChanged = {
      ...base,
      sources: [{ url: 'https://example.com/b', label: 'First label', toolCallId: 'call-a' }],
    };
    expect(conversationCaptureFingerprint(first, [])).toBe(conversationCaptureFingerprint(metadataChanged, []));
    expect(conversationCaptureFingerprint(first, [])).not.toBe(conversationCaptureFingerprint(urlChanged, []));
  });
});
