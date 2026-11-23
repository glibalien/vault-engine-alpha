import { AddContextPicker } from './AddContextPicker.js';
import type { NodeCandidate } from '../node-candidate.js';

export interface ContextChips {
  doc: boolean;
  board: boolean;
  nodes: Array<{ id: string; title: string; type: string }>;
  /** Persisted board-context choice (shared client_state): undefined = none yet, null = explicit off, string = that board. */
  activeBoardId?: string | null;
}

export interface ContextChipsBarProps {
  docPath: string | null;
  chips: ContextChips;
  /** The doc's linked boards (most-recent first), for the board-context dropdown. */
  boards: Array<{ id: string; name: string }>;
  /** The resolved effective board id (via pickEffectiveBoard), or undefined when off. */
  activeBoardId: string | undefined;
  adding: boolean;
  searchNodes: (query: string) => Promise<NodeCandidate[]>;
  onToggleDoc: () => void;
  /** Pick a board (id) or null for "No board (off)". */
  onSelectBoard: (id: string | null) => void;
  onRemoveNode: (id: string) => void;
  onAddClick: () => void;
  onAddPick: (c: NodeCandidate) => void;
  onAddClose: () => void;
  /** Board-follow 👁 — renders only when a handler is provided (plugin-only this pass). */
  followBoard?: boolean;
  onToggleFollowBoard?: () => void;
}

export function ContextChipsBar({ docPath, chips, boards, activeBoardId, adding, searchNodes, onToggleDoc, onSelectBoard, onRemoveNode, onAddClick, onAddPick, onAddClose, followBoard, onToggleFollowBoard }: ContextChipsBarProps) {
  // Basename without .md — shown in the bound line AND as the doc chip's label, so it is
  // unambiguous which document joins the context.
  const docName = docPath ? (docPath.split('/').pop() ?? docPath).replace(/\.md$/, '') : null;
  return (
    <div className="ctx-bar-wrap">
      <div className="ctx-bar">
        <div className="ctx-bound">
          {docPath ? (
            <>bound to <strong>{docName}</strong>{activeBoardId ? ' + board' : ''}</>
          ) : (
            'unbound conversation'
          )}
        </div>
        <div className="ctx-chips">
          {docPath && (
            <button className={`ctx-chip ctx-chip-doc${chips.doc ? ' on' : ''}`} onClick={onToggleDoc} title="toggle document context">{docName}</button>
          )}
          {docPath && (
            <select
              className="ctx-board"
              aria-label="board context"
              value={activeBoardId ?? ''}
              onChange={(e) => onSelectBoard(e.target.value || null)}
              title="which board feeds the chat (or none)"
            >
              <option value="">No board (off)</option>
              {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          {docPath && onToggleFollowBoard && (
            <button
              className={`ctx-follow${followBoard ? ' on' : ''}`}
              aria-label="follow active note's board"
              aria-pressed={!!followBoard}
              title={followBoard ? "Following the active note's board — click to freeze" : 'Board frozen — click to follow the active note'}
              onClick={onToggleFollowBoard}
            >👁</button>
          )}
          {chips.nodes.map((n) => (
            <span key={n.id} className="ctx-chip node on" title={n.type || 'node'}>
              {n.title}
              <button className="ctx-chip-x" onClick={() => onRemoveNode(n.id)} title="remove from context">×</button>
            </span>
          ))}
          <button className="ctx-chip add" onClick={onAddClick} title="add a node to context">+ add</button>
        </div>
      </div>
      {adding && <AddContextPicker searchNodes={searchNodes} onPick={onAddPick} onClose={onAddClose} />}
    </div>
  );
}
