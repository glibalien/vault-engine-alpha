import React, { useEffect, useRef, useState } from 'react';
import type { BoardContextCard } from '@vault/chat-core';
import type { BoardCardSpec } from '@vault/viz-ui';
import type { ResolvedOp } from './board-ops.js';
import type { BoardLevelPlan } from './board-level.js';

export type ComposerTool = 'query-nodes' | 'get-node' | 'vault-stats' | 'board';

export const COMPOSER_TOOLS: ReadonlyArray<{ tool: ComposerTool; label: string; placeholder: string; allowEmpty: boolean }> = [
  { tool: 'query-nodes',      label: 'Vault results',      placeholder: 'describe a view…',        allowEmpty: false },
  { tool: 'get-node',         label: 'One note',           placeholder: 'which note?…',            allowEmpty: false },
  { tool: 'vault-stats',      label: 'Vault overview',     placeholder: 'view title (optional)…',  allowEmpty: true },
  { tool: 'board',            label: 'Several views',      placeholder: 'describe a set of views…', allowEmpty: false },
];

/** The pipeline that owns a card, for tweak routing and the scope-locked picker. */
export function toolForKind(kind: BoardCardSpec['kind']): ComposerTool | null {
  switch (kind) {
    case 'node': return 'get-node';
    case 'stats': return 'vault-stats';
    case 'spend': return null;   // a fixed view: its range picker is its only control
    default: return 'query-nodes';   // the four viz kinds
  }
}

export type BoardInterpretResult =
  | { ok: true; spec: BoardCardSpec }
  | { ok: true; ops: ResolvedOp[]; summary: string; capped: boolean }
  | { ok: true; boardPlan: BoardLevelPlan }
  | { ok: false; error: string };
export type BoardInterpret = (tool: ComposerTool, text: string, current?: BoardCardSpec, boardCards?: BoardContextCard[]) => Promise<BoardInterpretResult>;

export interface ComposerScope { cardId: string; title: string; spec: BoardCardSpec }

export interface BoardComposerProps {
  interpret: BoardInterpret;
  /** Tweak target; null = create mode. */
  scope: ComposerScope | null;
  onClearScope(): void;
  onCreate(spec: BoardCardSpec, boardKey: string | null): void;
  onTweak(cardId: string, spec: BoardCardSpec, boardKey: string | null): void;
  onBoardOps(ops: ResolvedOp[], summary: string, boardKey: string | null, capped: boolean):
    { added: number; replaced: number; removed: number } | null;
  onBoardPlan(plan: BoardLevelPlan, boardKey: string | null): Promise<void>;
  onRevert(): void;
  revert: { label: string; detail: string } | null;
  boardCards: BoardContextCard[];
  /** The board this composer instance is currently mounted against (the host passes `board?.id ??
   *  null`). Captured at submit-start and threaded through to onCreate/onTweak/onBoardOps so the
   *  host can tell a continuation still targeting THIS board apart from one whose interpret() call
   *  resolves after the user has already switched to a different board. */
  boardKey: string | null;
  /** Tool preselected when the composer opens in create mode (e.g. "+ → One note…"). */
  initialTool?: ComposerTool;
  /** Close the composer. Absent = no close button. */
  onClose?(): void;
  /** Keep the tweak target after a successful tweak (the board tab tweaks one view, so further
   *  descriptions keep refining it). Default false: the scope clears and the bar returns to create. */
  stayScopedAfterTweak?: boolean;
}

/**
 * The board composer bar: `[>tool ▾] [scope chip?] [text] [⏎]`.
 * Purely presentational — interpretation, persistence, and revert state live
 * in the caller (Boards.tsx). A scope locks the picker to the owning card's
 * tool (via toolForKind); otherwise the picker drives which pipeline the
 * caller's interpret() should route to.
 */
export function BoardComposer({ interpret, scope, onClearScope, onCreate, onTweak, onBoardOps, onBoardPlan, onRevert, revert, boardCards, boardKey, initialTool, onClose, stayScopedAfterTweak }: BoardComposerProps): React.ReactElement {
  const [text, setText] = useState('');
  const [tool, setTool] = useState<ComposerTool>(initialTool ?? 'query-nodes');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const effectiveTool = scope ? toolForKind(scope.spec.kind) : tool;
  const toolDef = COMPOSER_TOOLS.find((t) => t.tool === effectiveTool)!;

  // Opening the composer (or newly setting a tweak target) focuses the input — the sparkles or
  // "Describe a view…" click's natural continuation.
  useEffect(() => { inputRef.current?.focus(); }, [scope?.cardId]);

  async function submit(): Promise<void> {
    const t = text.trim();
    if (!effectiveTool || !toolDef || (!t && !toolDef.allowEmpty) || busy) return;
    // Captured at submit-start, not read after the await below — interpret() is async, and by the
    // time it resolves the host may have switched boards (boardKey prop would then differ from
    // what was true right now). The host uses this to tell apart a continuation still meant for
    // THIS board from one that should be dropped.
    const submittedBoardKey = boardKey;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await interpret(effectiveTool, t, scope?.spec, boardCards);
      if (!result.ok) { setError(result.error); return; }
      if ('boardPlan' in result) {
        await onBoardPlan(result.boardPlan, submittedBoardKey);   // Boards renders the banner; a throw lands in the catch → bar error
      } else if ('ops' in result) {
        const counts = onBoardOps(result.ops, result.summary, submittedBoardKey, result.capped);
        if (counts !== null) {
          setStatus(`✓ Added ${counts.added} · updated ${counts.replaced} · removed ${counts.removed}${result.capped ? ' · limited to the first set of changes' : ''}`);
        }
      } else if (scope) { onTweak(scope.cardId, result.spec, submittedBoardKey); if (!stayScopedAfterTweak) onClearScope(); }
      else onCreate(result.spec, submittedBoardKey);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (text) setText('');
      else if (scope) onClearScope();
      else onClose?.();
    }
  }

  return (
    <div className="vb-composer">
      <div className="vb-composer-row">
        <select
          className="dropdown vb-composer-tool"
          aria-label="composer tool"
          value={effectiveTool ?? ''}
          disabled={!!scope || busy}
          onChange={(e) => { setTool(e.target.value as ComposerTool); setError(null); setStatus(null); }}
        >
          {COMPOSER_TOOLS.map((t) => (
            <option key={t.tool} value={t.tool}>{t.label}</option>
          ))}
        </select>
        {scope && (
          <span className="vb-composer-scope" title={`tweaking “${scope.title}”`}>
            ⊞ {scope.title}
            <button type="button" aria-label="clear tweak target" onClick={onClearScope}>×</button>
          </span>
        )}
        <input
          ref={inputRef}
          className="vb-composer-input"
          placeholder={toolDef?.placeholder ?? 'describe a change…'}
          value={text}
          disabled={busy || !effectiveTool}
          onChange={(e) => { setText(e.target.value); setStatus(null); }}
          onKeyDown={onKeyDown}
        />
        {revert && (
          <button type="button" className="vb-composer-revert" title={revert.detail} onClick={onRevert}>↩ {revert.label}</button>
        )}
        <button
          type="button"
          className="vb-composer-send"
          aria-label="interpret"
          disabled={busy || !effectiveTool || (!text.trim() && !toolDef?.allowEmpty)}
          onClick={() => void submit()}
        >{busy ? <span className="vb-composer-spinner" aria-hidden="true" /> : '⏎'}</button>
        {onClose && (
          <button type="button" className="vb-composer-close" aria-label="close composer" onClick={onClose}>×</button>
        )}
      </div>
      {error && <div className="vb-composer-error" role="alert">{error}</div>}
      {status && !error && <div className="vb-composer-status">{status}</div>}
    </div>
  );
}
