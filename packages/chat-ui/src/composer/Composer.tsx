import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon.js';
import type { PreviewRef } from '../preview-ref.js';
import type { NodeCandidate } from '../node-candidate.js';
import { composerTrigger, nextActive, type ComposerTrigger } from './composer-trigger.js';
import { applyNodePick } from './composer-insert.js';
import { ComposerAutocomplete, type AutocompleteRow } from './ComposerAutocomplete.js';
import { ModelPicker, type ModelPickerProps } from './ModelPicker.js';

interface MenuState {
  trigger: ComposerTrigger;
  rows: AutocompleteRow[];
  active: number;
  nodes: NodeCandidate[]; // populated for the '@' sigil so a pick can add a context chip
}

export function Composer({ disabled, streaming, capped, searchNodes, onSend, onStop, onAddNodeChip, onOpenPreview, modelPicker }: {
  disabled: boolean;
  streaming: boolean;
  capped: boolean;
  /** '@' menu data source — the surface's node search. */
  searchNodes: (query: string) => Promise<NodeCandidate[]>;
  onSend: (text: string) => void;
  onStop: () => void;
  onAddNodeChip?: (c: NodeCandidate) => void;
  onOpenPreview?: (ref: PreviewRef) => void;
  /** Model picker chip + popover, rendered in .crow before the sigil hints — omitted entirely when absent. */
  modelPicker?: ModelPickerProps;
}) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0); // stale-guard for async menu fills

  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
    setMenu(null);
  };

  // Recompute the active trigger whenever the buffer or caret changes.
  const refresh = useCallback((value: string, caret: number) => {
    const trig = composerTrigger(value, caret);
    if (!trig) { setMenu(null); return; }

    // '@' node search — debounced + monotonic stale-guard.
    const mine = ++seq.current;
    setTimeout(() => {
      if (mine !== seq.current) return;
      searchNodes(trig.query)
        .then((cands) => {
          if (mine !== seq.current) return;
          const rows = cands.map((c): AutocompleteRow => ({ key: c.id, label: c.title, hint: c.type ?? '' }));
          setMenu({ trigger: trig, rows, active: 0, nodes: cands });
        })
        .catch(() => { if (mine === seq.current) setMenu(null); });
    }, 120);
  }, [searchNodes]);

  const applyEdit = (edit: { text: string; caret: number }) => {
    setText(edit.text);
    setMenu(null);
    // restore caret after React commits the new value
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(edit.caret, edit.caret); }
    });
  };

  const pick = (index: number) => {
    if (!menu || menu.rows.length === 0) return;
    const { trigger } = menu;
    // '@'
    const cand = menu.nodes[index];
    if (!cand) return;
    applyEdit(applyNodePick(text, trigger, cand.title));
    onAddNodeChip?.(cand);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;
    setText(value);
    refresh(value, caret);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu({ ...menu, active: nextActive(menu.active, menu.rows.length, 1) }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenu({ ...menu, active: nextActive(menu.active, menu.rows.length, -1) }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(menu.active); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    // Canonical cross-surface send keys: Enter sends, Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Bump the stale-guard whenever any menu closes, so an in-flight search can't reopen a stale menu.
  useEffect(() => { if (!menu) seq.current++; }, [menu]);

  return (
    <div className="composer">
      <div className="box">
        {menu && (
          <ComposerAutocomplete
            sigil={menu.trigger.sigil}
            rows={menu.rows}
            active={menu.active}
            onPick={pick}
            onPreview={onOpenPreview
              ? (i) => { const c = menu.nodes[i]; if (c) onOpenPreview({ nodeId: c.id }); }
              : undefined}
          />
        )}
        <textarea
          ref={taRef}
          value={text}
          placeholder="Ask the vault…"
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        <div className="crow">
          {/* display:contents keeps .crow's flex layout; the capture closes the typed
              '@' menu before the picker opens, so the two popovers never stack. */}
          {modelPicker && (
            <span style={{ display: 'contents' }} onMouseDownCapture={() => setMenu(null)}>
              <ModelPicker {...modelPicker} />
            </span>
          )}
          <span className="sigils">
            <span><b>@</b>node</span>
          </span>
          <span className="hint"><kbd>↵</kbd> send</span>
          <span className="actions">
            {capped && !streaming && <button className="pillbtn" onClick={() => onSend('Continue.')}>continue?</button>}
            {streaming
              ? <button className="pillbtn" onClick={onStop}>stop</button>
              : <button className="send" title="send" disabled={disabled || !text.trim()} onClick={send}><Icon name="send" /></button>}
          </span>
        </div>
      </div>
    </div>
  );
}
