import { useEffect, useState } from 'react';

/** Minimal conversation row the switcher needs; both surfaces' summary types are structurally assignable. */
export interface ConversationRow {
  id: string;
  title?: string | null;
  archived?: number | boolean;
}

// Mirrors the board panel toolbar (Boards.tsx): a native dropdown switcher + a 👁 follow toggle +
// a ⋯ actions menu. The dropdown uses Obsidian's `.dropdown` class so it matches the board panel's
// board switcher exactly; the per-conversation actions (new / open-note / archive / delete) live in
// the ⋯ menu instead of a crowded button row.
export function ConversationSwitcher({
  list, currentId, showArchived, followActive, archived = false,
  onSelect, onNew, onArchive, onDelete, onToggleArchived, onOpenNoteConversation, onToggleFollow,
  onUnarchive, onAttachToNote,
}: {
  list: ConversationRow[];
  currentId: string;
  showArchived: boolean;
  followActive: boolean;
  archived?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onToggleArchived: () => void;
  onOpenNoteConversation: () => void;
  onToggleFollow: () => void;
  onUnarchive?: () => void;
  onAttachToNote?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const current = list.find((c) => c.id === currentId);

  // Close the ⋯ menu on an outside click (mirrors the board panel's menu).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest('.vc-conv-menu, .vc-conv-menu-btn')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <div className="vc-conv">
      <select
        className="dropdown vc-conv-switcher"
        aria-label="conversations"
        value={currentId}
        onChange={(e) => onSelect(e.target.value)}
      >
        {/* A brand-new (unsaved) conversation has no row yet — keep the value selectable. */}
        {!current && <option value={currentId}>New chat</option>}
        {list.map((c) => (
          <option key={c.id} value={c.id}>{(c.title || 'New chat') + (c.archived ? ' (archived)' : '')}</option>
        ))}
      </select>

      <button
        className={`vc-conv-follow${followActive ? ' on' : ''}`}
        aria-label="follow active note"
        aria-pressed={followActive}
        title="Follow active note"
        onClick={onToggleFollow}
      >👁</button>

      <button
        className="vc-conv-menu-btn"
        aria-label="conversation actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >⋯</button>

      {menuOpen && (
        <div className="vc-conv-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onNew(); }}>＋ New chat</button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenNoteConversation(); }}>⛓ Open this note&apos;s conversation</button>
          {archived ? (
            <>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onUnarchive?.(); }}>♻ Unarchive</button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onAttachToNote?.(); }}>🔗 Attach to this note</button>
            </>
          ) : (
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onArchive(); }}>🗄 Archive (start fresh)</button>
          )}
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }}>🗑 Delete</button>
          <label className="vc-conv-archtoggle">
            <input type="checkbox" checked={showArchived} onChange={onToggleArchived} /> show archived
          </label>
        </div>
      )}
    </div>
  );
}
