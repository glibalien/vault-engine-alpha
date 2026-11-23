import { describe, it, expect, vi } from 'vitest';
import { makeConversationClient } from '../../src/chat/conversation-client.js';

const envelope = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] });
const meta = (id: string) => ({ id, title: id, created_at: '', updated_at: '', archived: 0 });

describe('conversation-client', () => {
  it('list → list-conversations, returns conversations', async () => {
    const call = vi.fn(async () => envelope({ conversations: [meta('c1')] }));
    const c = makeConversationClient(call as never);
    expect(await c.list()).toHaveLength(1);
    expect(call).toHaveBeenCalledWith({ name: 'list-conversations', arguments: { include_archived: false } });
  });
  it('save → save-conversation with id+title+messages', async () => {
    const call = vi.fn(async () => envelope({ id: 'c1' }));
    await makeConversationClient(call as never).save({ id: 'c1', title: 'T', messages: [{ role: 'user' }] });
    expect(call).toHaveBeenCalledWith({ name: 'save-conversation', arguments: { id: 'c1', title: 'T', messages: [{ role: 'user' }] } });
  });
  it('save → OMITS title when undefined', async () => {
    const call = vi.fn(async () => envelope({ id: 'c1' }));
    await makeConversationClient(call as never).save({ id: 'c1', messages: [] });
    const sent = (call.mock.calls[0] as unknown[])[0] as { arguments: Record<string, unknown> };
    expect(sent.arguments).not.toHaveProperty('title');
  });
  it('get → returns {conversation, messages, linked_docs} or null on !ok', async () => {
    const ok = vi.fn(async () => envelope({ conversation: meta('c1'), messages: [], linked_docs: ['node-1'] }));
    expect((await makeConversationClient(ok as never).get('c1'))?.linked_docs).toEqual(['node-1']);
    const bad = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } }) }] }));
    expect(await makeConversationClient(bad as never).get('nope')).toBeNull();
  });
  it('linkToDoc → link-conversation (snake_case args), maps linked flag', async () => {
    const call = vi.fn(async () => envelope({ linked: true }));
    expect(await makeConversationClient(call as never).linkToDoc('c1', 'node-1')).toBe(true);
    expect(call).toHaveBeenCalledWith({ name: 'link-conversation', arguments: { conversation_id: 'c1', doc_node_id: 'node-1' } });
  });
  it('unlinkFromDoc → link-conversation linked:false, maps unlinked flag', async () => {
    const call = vi.fn(async () => envelope({ unlinked: true }));
    expect(await makeConversationClient(call as never).unlinkFromDoc('c1', 'node-1')).toBe(true);
    expect(call).toHaveBeenCalledWith({ name: 'link-conversation', arguments: { conversation_id: 'c1', doc_node_id: 'node-1', linked: false } });
  });
  it('listForDoc → list-conversations by doc, returns conversations', async () => {
    const call = vi.fn(async () => envelope({ conversations: [meta('c1'), meta('c2')] }));
    expect(await makeConversationClient(call as never).listForDoc('node-1')).toHaveLength(2);
    expect(call).toHaveBeenCalledWith({ name: 'list-conversations', arguments: { doc_node_id: 'node-1', include_archived: false } });
  });
  it('archive → archive-conversation; remove → delete-conversation', async () => {
    const a = vi.fn(async () => envelope({ archived: true }));
    expect(await makeConversationClient(a as never).archive('c1')).toBe(true);
    const d = vi.fn(async () => envelope({ deleted: true }));
    expect(await makeConversationClient(d as never).remove('c1')).toBe(true);
  });
});
