import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { BoardComposer, type ComposerScope, type ComposerTool } from '../../src/boards/BoardComposer.js';
import type { BoardContextCard } from '@vault/chat-core';
import type { VizSpec, BoardCardSpec } from '@vault/viz-ui';
import type { ResolvedOp } from '../../src/boards/board-ops.js';
import type { BoardLevelPlan } from '../../src/boards/board-level.js';

const SPEC: VizSpec = { kind: 'table', title: 'open tasks', query: { types: ['task'] }, display_fields: ['status'] };
const SCOPE: ComposerScope = { cardId: 'c1', title: 'By status', spec: SPEC };

function setup(over: Partial<Parameters<typeof BoardComposer>[0]> = {}) {
  const props = {
    interpret: vi.fn(async (_tool: ComposerTool, _text: string, _current?: BoardCardSpec, _boardCards?: BoardContextCard[]) => ({ ok: true as const, spec: SPEC })),
    scope: null, onClearScope: vi.fn(), onCreate: vi.fn(), onTweak: vi.fn(),
    onBoardOps: vi.fn((_ops: ResolvedOp[], _summary: string, _boardKey: string | null, _capped: boolean) =>
      ({ added: 1, replaced: 0, removed: 0 })),
    onBoardPlan: vi.fn(async () => {}),
    onRevert: vi.fn(), revert: null as { label: string; detail: string } | null, boardCards: [] as BoardContextCard[],
    boardKey: 'b1' as string | null, ...over,
  };
  render(<BoardComposer {...props} />);
  return props;
}

const input = () => screen.getByPlaceholderText('describe a view…') as HTMLInputElement;
const submit = (text: string) => {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
};

describe('BoardComposer', () => {
  it('presents card choices in plain language while retaining the internal tool values', () => {
    setup();
    const picker = screen.getByLabelText('composer tool') as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.textContent)).toEqual([
      'Vault results',
      'One note',
      'Vault overview',
      'Several views',
    ]);
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      'query-nodes',
      'get-node',
      'vault-stats',
      'board',
    ]);
  });

  it('create: Enter interprets without a current spec and calls onCreate', async () => {
    const p = setup();
    submit('open tasks');
    await waitFor(() => expect(p.onCreate).toHaveBeenCalledWith(SPEC, 'b1'));
    expect(p.interpret).toHaveBeenCalledWith('query-nodes', 'open tasks', undefined, []);
    expect(input().value).toBe(''); // cleared on success
  });

  it('tweak: with a scope, interprets against its spec, calls onTweak, clears scope', async () => {
    const p = setup({ scope: SCOPE });
    expect(screen.getByText(/By status/)).toBeTruthy(); // scope chip
    submit('group by priority');
    await waitFor(() => expect(p.onTweak).toHaveBeenCalledWith('c1', SPEC, 'b1'));
    expect(p.interpret).toHaveBeenCalledWith('query-nodes', 'group by priority', SPEC, []);
    expect(p.onClearScope).toHaveBeenCalled();
  });

  it('failure: shows the error line and preserves the input text', async () => {
    const p = setup({ interpret: vi.fn(async () => ({ ok: false as const, error: 'viz model not configured' })) });
    submit('anything');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('viz model not configured'));
    expect(input().value).toBe('anything');
    expect(p.onCreate).not.toHaveBeenCalled();
  });

  it('interpret rejects: shows an error, re-enables the input, and preserves the text (no permanent lock)', async () => {
    const p = setup({ interpret: vi.fn(async () => { throw new Error('network blew up'); }) });
    submit('anything');
    expect(input().disabled).toBe(true); // busy while the rejected promise is in flight
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network blew up'));
    expect(input().disabled).toBe(false);
    expect(input().value).toBe('anything');
    expect(p.onCreate).not.toHaveBeenCalled();
    expect(p.onTweak).not.toHaveBeenCalled();
  });

  it('busy: input disabled while interpreting; re-submit ignored', async () => {
    let release!: (v: { ok: true; spec: VizSpec }) => void;
    const p = setup({ interpret: vi.fn(() => new Promise<{ ok: true; spec: VizSpec }>((r) => { release = r; })) });
    submit('x');
    expect(input().disabled).toBe(true);
    fireEvent.keyDown(input(), { key: 'Enter' });
    release({ ok: true, spec: SPEC });
    await waitFor(() => expect(p.onCreate).toHaveBeenCalledTimes(1));
  });

  it('Escape clears text first, then the scope; chip × clears scope', () => {
    const p = setup({ scope: SCOPE });
    fireEvent.change(input(), { target: { value: 'abc' } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(input().value).toBe('');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(p.onClearScope).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('clear tweak target'));
    expect(p.onClearScope).toHaveBeenCalledTimes(2);
  });

  it('revert chip renders only when revert is set and fires onRevert', () => {
    const p = setup({ revert: { label: 'tweak', detail: 'Open tasks' } });
    const btn = screen.getByText('↩ tweak');
    expect(btn.getAttribute('title')).toBe('Open tasks');
    fireEvent.click(btn);
    expect(p.onRevert).toHaveBeenCalled();
  });

  it('picker switches tools and drives placeholder + empty-text rule', async () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'get-node' } });
    expect(screen.getByPlaceholderText('which note?…')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'vault-stats' } });
    // vault-stats allows empty submit:
    fireEvent.keyDown(screen.getByPlaceholderText('view title (optional)…'), { key: 'Enter' });
    await waitFor(() => expect(p.interpret).toHaveBeenCalledWith('vault-stats', '', undefined, []));
  });

  it('switching tools clears a showing error line (stale error must not survive a tool change)', async () => {
    setup({ interpret: vi.fn(async () => ({ ok: false as const, error: 'viz model not configured' })) });
    submit('anything');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('viz model not configured'));
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'get-node' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a scope locks the picker to the card\'s tool', () => {
    setup({ scope: { cardId: 'c1', title: 'Charter', spec: { kind: 'node', title: 'Charter', node_id: 'n1' } } });
    const select = screen.getByLabelText('composer tool') as HTMLSelectElement;
    expect(select.value).toBe('get-node');
    expect(select.disabled).toBe(true);
  });

  it('>board appears unscoped, routes ops to onBoardOps, and shows the applied status line', async () => {
    const ops: ResolvedOp[] = [{ op: 'add', spec: { kind: 'stats', title: 'S' } }];
    const p = setup({ interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 's', capped: false })) });
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'board' } });
    const boardInput = screen.getByPlaceholderText('describe a set of views…');
    fireEvent.change(boardInput, { target: { value: 'reshape the board' } });
    fireEvent.keyDown(boardInput, { key: 'Enter' });
    await waitFor(() => expect(p.onBoardOps).toHaveBeenCalledWith(ops, 's', 'b1', false));
    expect(screen.getByText('✓ Added 1 · updated 0 · removed 0')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('describe a set of views…'), { target: { value: 'x' } });
    expect(screen.queryByText('✓ Added 1 · updated 0 · removed 0')).toBeNull();
  });

  it('capped plans append " (capped)" to the status line', async () => {
    const ops: ResolvedOp[] = [{ op: 'add', spec: { kind: 'stats', title: 'S' } }];
    const p = setup({ interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 's', capped: true })) });
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'board' } });
    const boardInput = screen.getByPlaceholderText('describe a set of views…');
    fireEvent.change(boardInput, { target: { value: 'reshape the board' } });
    fireEvent.keyDown(boardInput, { key: 'Enter' });
    await waitFor(() => expect(p.onBoardOps).toHaveBeenCalledWith(ops, 's', 'b1', true));
    expect(screen.getByText('✓ Added 1 · updated 0 · removed 0 · limited to the first set of changes')).toBeTruthy();
  });

  it('status line reports APPLIED counts from onBoardOps, and none when it returns null', async () => {
    const ops: ResolvedOp[] = [{ op: 'replace', card_id: 'c1', spec: SPEC }, { op: 'remove', card_id: 'c2' }];
    const onBoardOps = vi.fn(() => ({ added: 0, replaced: 0, removed: 1 }));
    setup({
      interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 's', capped: false })),
      onBoardOps,
    });
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'board' } });
    const boardInput = screen.getByPlaceholderText('describe a set of views…');
    fireEvent.change(boardInput, { target: { value: 'reshape the board' } });
    fireEvent.keyDown(boardInput, { key: 'Enter' });
    await waitFor(() => expect(onBoardOps).toHaveBeenCalledWith(ops, 's', 'b1', false));
    expect(screen.getByText('✓ Added 0 · updated 0 · removed 1')).toBeTruthy();

    cleanup();
    const onBoardOpsNull = vi.fn(() => null);
    setup({
      interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 's', capped: false })),
      onBoardOps: onBoardOpsNull,
    });
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'board' } });
    const boardInput2 = screen.getByPlaceholderText('describe a set of views…');
    fireEvent.change(boardInput2, { target: { value: 'reshape the board' } });
    fireEvent.keyDown(boardInput2, { key: 'Enter' });
    await waitFor(() => expect(onBoardOpsNull).toHaveBeenCalledWith(ops, 's', 'b1', false));
    expect(screen.queryByText(/✓ Applied/)).toBeNull();
  });

  it('switching tools clears a showing status line (stale ✓ Applied must not survive a tool change)', async () => {
    const ops: ResolvedOp[] = [{ op: 'add', spec: { kind: 'stats', title: 'S' } }];
    const p = setup({ interpret: vi.fn(async () => ({ ok: true as const, ops, summary: 's', capped: false })) });
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'board' } });
    const boardInput = screen.getByPlaceholderText('describe a set of views…');
    fireEvent.change(boardInput, { target: { value: 'reshape the board' } });
    fireEvent.keyDown(boardInput, { key: 'Enter' });
    await waitFor(() => expect(p.onBoardOps).toHaveBeenCalledWith(ops, 's', 'b1', false));
    expect(screen.getByText(/✓ Added/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('composer tool'), { target: { value: 'get-node' } });
    expect(screen.queryByText(/✓ Added/)).toBeNull();
  });

  it('the picker never shows >board while scoped (scope locks to the card tool)', () => {
    setup({ scope: { cardId: 'c1', title: 'Health', spec: { kind: 'stats', title: 'Health' } } });
    const select = screen.getByLabelText('composer tool') as HTMLSelectElement;
    expect(select.value).toBe('vault-stats');
    expect(select.disabled).toBe(true);
  });

  it('boardPlan results route to onBoardPlan and clear the input; a rejection shows the bar error', async () => {
    const plan: BoardLevelPlan = { kind: 'create', name: 'Ops', cards: [{ kind: 'stats', title: 'S' }], summary: 's' };
    const p = setup({ interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })) });
    submit('create an Ops board');
    await waitFor(() => expect(p.onBoardPlan).toHaveBeenCalledWith(plan, 'b1'));
    expect(input().value).toBe(''); // cleared on success
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/✓ Applied/)).toBeNull(); // no status line — Boards renders the banner

    cleanup();
    const p2 = setup({
      interpret: vi.fn(async () => ({ ok: true as const, boardPlan: plan })),
      onBoardPlan: vi.fn(async () => { throw new Error('save-board failed'); }),
    });
    submit('create an Ops board again');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('save-board failed'));
    expect(input().value).toBe('create an Ops board again'); // preserved on rejection
    expect(p2.onCreate).not.toHaveBeenCalled();
  });
});
