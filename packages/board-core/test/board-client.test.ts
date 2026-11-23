import { describe, it, expect, vi } from 'vitest';
import { BoardToolError, isBoardNotFound, makeBoardClient } from '../src/board-client.js';
import type { CallFn } from '../src/types.js';

function envResult(payload: unknown, ok = true) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok, data: payload }) }] } as Awaited<ReturnType<CallFn>>;
}

describe('makeBoardClient', () => {
  it('list maps the boards array', async () => {
    const call = vi.fn(async () => envResult({ boards: [{ id: 'b1', name: 'B', updated_at: 1, card_count: 2 }] })) as unknown as CallFn;
    const client = makeBoardClient(call);
    const out = await client.list();
    expect(out).toEqual([{ id: 'b1', name: 'B', updated_at: 1, card_count: 2 }]);
    expect(call).toHaveBeenCalledWith({ name: 'list-boards', arguments: {} });
  });

  it('save omits id when creating, includes it when updating', async () => {
    const call = vi.fn(async () => envResult({ id: 'new' })) as unknown as CallFn;
    const client = makeBoardClient(call);
    await client.save({ name: 'X', cards: [] });
    expect(call).toHaveBeenLastCalledWith({ name: 'save-board', arguments: { name: 'X', cards: [] } });
    await client.save({ id: 'b1', name: 'X', cards: [] });
    expect(call).toHaveBeenLastCalledWith({ name: 'save-board', arguments: { name: 'X', cards: [], id: 'b1' } });
  });

  it("save throws the Engine's error code, so a deleted board reads as not found (#304)", async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'no board b1' } }) }] })) as unknown as CallFn;
    const err = await makeBoardClient(call).save({ id: 'b1', name: 'X', cards: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardToolError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', message: 'no board b1' });
    expect(isBoardNotFound(err)).toBe(true);
    expect(isBoardNotFound(new Error('NOT_FOUND'))).toBe(false);
  });

  it('get returns null on ok:false', async () => {
    const call = vi.fn(async () => envResult(undefined, false)) as unknown as CallFn;
    const client = makeBoardClient(call);
    expect(await client.get('missing')).toBeNull();
  });

  it('linkToDoc / unlinkToDoc / listForDoc pass the right tool + args', async () => {
    const call = vi.fn(async () => envResult({ linked: true })) as unknown as CallFn;
    const client = makeBoardClient(call);
    await client.linkToDoc('b1', 'n1');
    expect(call).toHaveBeenLastCalledWith({ name: 'link-board', arguments: { board_id: 'b1', doc_node_id: 'n1' } });
    await client.unlinkFromDoc('b1', 'n1');
    expect(call).toHaveBeenLastCalledWith({ name: 'link-board', arguments: { board_id: 'b1', doc_node_id: 'n1', linked: false } });
    await client.listForDoc('n1');
    expect(call).toHaveBeenLastCalledWith({ name: 'list-boards', arguments: { doc_node_id: 'n1' } });
  });
});
