import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { ConversationSwitcher } from '../src/conversation/ConversationSwitcher.js';

const LIST = [
  { id: 'c1', title: 'First chat', archived: 0 },
  { id: 'c2', title: '', archived: 1 },
];

function setup(over: Record<string, unknown> = {}) {
  const props = {
    list: LIST, currentId: 'c1', showArchived: false, followActive: true, archived: false,
    onSelect: vi.fn(), onNew: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(),
    onToggleArchived: vi.fn(), onOpenNoteConversation: vi.fn(), onToggleFollow: vi.fn(),
    onUnarchive: vi.fn(), onAttachToNote: vi.fn(),
    ...over,
  };
  render(<ConversationSwitcher {...(props as never)} />);
  return props;
}

describe('ConversationSwitcher', () => {
  afterEach(() => cleanup());

  it('lists conversations; blank titles render as "New chat"; archived rows are marked', () => {
    setup();
    expect(screen.getByText('First chat')).toBeTruthy();
    expect(screen.getByText('New chat (archived)')).toBeTruthy();
  });

  it('unknown currentId keeps a selectable "New chat" option', () => {
    setup({ currentId: 'fresh-uuid' });
    expect((screen.getByLabelText('conversations') as HTMLSelectElement).value).toBe('fresh-uuid');
  });

  it('selecting fires onSelect(id)', () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText('conversations'), { target: { value: 'c2' } });
    expect(p.onSelect).toHaveBeenCalledWith('c2');
  });

  it('active conversation not archived → 🗄 Archive shown, ♻/🔗 hidden', () => {
    setup();
    fireEvent.click(screen.getByLabelText('conversation actions'));
    expect(screen.getByText(/Archive \(start fresh\)/)).toBeTruthy();
    expect(screen.queryByText(/Unarchive/)).toBeNull();
  });

  it('active conversation archived → ♻ Unarchive + 🔗 Attach shown, 🗄 hidden', () => {
    const p = setup({ archived: true });
    fireEvent.click(screen.getByLabelText('conversation actions'));
    expect(screen.queryByText(/Archive \(start fresh\)/)).toBeNull();
    fireEvent.click(screen.getByText(/Unarchive/));
    expect(p.onUnarchive).toHaveBeenCalled();
  });

  it('🔗 Attach to this note fires onAttachToNote when archived', () => {
    const p = setup({ archived: true });
    fireEvent.click(screen.getByLabelText('conversation actions'));
    fireEvent.click(screen.getByText(/Attach to this note/));
    expect(p.onAttachToNote).toHaveBeenCalled();
  });

  it('🗄 Archive (start fresh) fires onArchive when not archived', () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText('conversation actions'));
    fireEvent.click(screen.getByText(/Archive \(start fresh\)/));
    expect(p.onArchive).toHaveBeenCalled();
  });

  it('⛓ Open this note\'s conversation fires onOpenNoteConversation', () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText('conversation actions'));
    fireEvent.click(screen.getByText(/Open this note's conversation/));
    expect(p.onOpenNoteConversation).toHaveBeenCalled();
  });

  it('follow toggle reflects and fires', () => {
    const p = setup({ followActive: false });
    const eye = screen.getByLabelText('follow active note');
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(eye);
    expect(p.onToggleFollow).toHaveBeenCalled();
  });

  it('menu: new / delete / show-archived fire callbacks', () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText('conversation actions'));
    fireEvent.click(screen.getByText('＋ New chat'));
    expect(p.onNew).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('conversation actions'));
    fireEvent.click(screen.getByText('🗑 Delete'));
    expect(p.onDelete).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('conversation actions'));
    fireEvent.click(screen.getByLabelText('show archived'));
    expect(p.onToggleArchived).toHaveBeenCalled();
  });
});
