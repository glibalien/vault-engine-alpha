import { describe, it, expect, vi } from 'vitest';
import { makeConversationClient } from '../src/conversation-client.js';
import type { CallFn } from '../src/types.js';

const envResult = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) as Awaited<ReturnType<CallFn>>;

describe('makeConversationClient', () => {
  it('save passes client_state only when provided', async () => {
    const call = vi.fn().mockResolvedValue(envResult({ ok: true, data: { id: 'c1' } }));
    const client = makeConversationClient(call as never);
    await client.save({ id: 'c1', messages: [], client_state: { nodes: [] } });
    expect(call).toHaveBeenCalledWith({ name: 'save-conversation', arguments: { id: 'c1', messages: [], client_state: { nodes: [] } } });
    call.mockClear();
    await client.save({ id: 'c1', messages: [] });
    expect(call).toHaveBeenCalledWith({ name: 'save-conversation', arguments: { id: 'c1', messages: [] } });
  });

  it('save forwards created_at/updated_at only when provided', async () => {
    const call = vi.fn().mockResolvedValue(envResult({ ok: true, data: { id: 'c1' } }));
    const client = makeConversationClient(call as never);
    await client.save({ id: 'c1', messages: [], created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-03-15T12:30:00.000Z' });
    expect(call).toHaveBeenCalledWith({ name: 'save-conversation', arguments: { id: 'c1', messages: [], created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-03-15T12:30:00.000Z' } });
    // Omitted → not forwarded at all (engine then stamps now).
    call.mockClear();
    await client.save({ id: 'c1', messages: [] });
    expect(call).toHaveBeenCalledWith({ name: 'save-conversation', arguments: { id: 'c1', messages: [] } });
  });

  it('save omits messages from the tool args when not provided (title-only save)', async () => {
    const call = vi.fn().mockResolvedValue(envResult({ ok: true, data: { id: 'c1' } }));
    const client = makeConversationClient(call as never);
    await client.save({ id: 'c1', title: 'Identifying Project Alpha Task' });
    expect(call).toHaveBeenCalledWith({ name: 'save-conversation', arguments: { id: 'c1', title: 'Identifying Project Alpha Task' } });
  });

  it('get returns parsed data incl client_state, null on !ok', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(envResult({ ok: true, data: { conversation: { id: 'c1' }, messages: [], linked_docs: [], client_state: { doc: true } } }))
      .mockResolvedValueOnce(envResult({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } }));
    const client = makeConversationClient(call as never);
    expect((await client.get('c1'))!.client_state).toEqual({ doc: true });
    expect(await client.get('nope')).toBeNull();
  });

  it('list / listForDoc map the conversations array + pass include_archived', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(envResult({ ok: true, data: { conversations: [{ id: 'c1', title: 'C', created_at: '0', updated_at: '1', archived: 0 }] } }))
      .mockResolvedValueOnce(envResult({ ok: true, data: { conversations: [] } }));
    const client = makeConversationClient(call as never);
    expect((await client.list(true)).map((c) => c.id)).toEqual(['c1']);
    expect(call).toHaveBeenLastCalledWith({ name: 'list-conversations', arguments: { include_archived: true } });
    await client.listForDoc('n1');
    expect(call).toHaveBeenLastCalledWith({ name: 'list-conversations', arguments: { doc_node_id: 'n1', include_archived: false } });
  });

  it('archive / remove / link / unlink pass the right tool + args', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(envResult({ ok: true, data: { archived: true } }))
      .mockResolvedValueOnce(envResult({ ok: true, data: { deleted: true } }))
      .mockResolvedValueOnce(envResult({ ok: true, data: { linked: true } }))
      .mockResolvedValueOnce(envResult({ ok: true, data: { unlinked: true } }));
    const client = makeConversationClient(call as never);
    expect(await client.archive('c1')).toBe(true);
    expect(call).toHaveBeenLastCalledWith({ name: 'archive-conversation', arguments: { id: 'c1' } });
    expect(await client.remove('c1')).toBe(true);
    expect(call).toHaveBeenLastCalledWith({ name: 'delete-conversation', arguments: { id: 'c1' } });
    expect(await client.linkToDoc('c1', 'n1')).toBe(true);
    expect(call).toHaveBeenLastCalledWith({ name: 'link-conversation', arguments: { conversation_id: 'c1', doc_node_id: 'n1' } });
    expect(await client.unlinkFromDoc('c1', 'n1')).toBe(true);
    expect(call).toHaveBeenLastCalledWith({ name: 'link-conversation', arguments: { conversation_id: 'c1', doc_node_id: 'n1', linked: false } });
  });

  it('unarchive + setState issue the right calls', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(envResult({ ok: true, data: { unarchived: true } }))
      .mockResolvedValueOnce(envResult({ ok: true, data: { ok: true } }));
    const client = makeConversationClient(call as never);
    expect(await client.unarchive('c1')).toBe(true);
    expect(await client.setState('c1', { x: 1 })).toBe(true);
    expect(call).toHaveBeenLastCalledWith({ name: 'set-conversation-state', arguments: { id: 'c1', client_state: { x: 1 } } });
  });
});
