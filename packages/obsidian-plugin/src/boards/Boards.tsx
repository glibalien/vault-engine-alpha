import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardContextCard } from '@vault/chat-core';
import {
  VizCard, NodeCard, StatsCard, SpendCard,
  parseBoardCardSpec, VIZ_KINDS, Icon, useDismissOnOutside, KIND_LABEL, tableSortOf, withoutColumnSort,
  useVizVocabulary, namedFields,
} from '@vault/viz-ui';
import type { VizSpec, BoardCardSpec, IconName, PreviewRef, ViewVocabulary } from '@vault/viz-ui';
import type { BoardClient, Board, BoardCard, BoardSummary, DocScope } from '@vault/board-core';
import { addCard, removeCard, normalizeOrder, pickFollowBoard, orderBoards, isBoardNotFound, TABLE_PRESET, kanbanPreset } from '@vault/board-core';
import { Notice } from 'obsidian';
import type { BoardChoice, ChooseBoard } from './board-picker-modal.js';
import { applyResolvedOps, type ResolvedOp, type AppliedOps } from './board-ops.js';
import { BoardComposer, type BoardInterpret, type ComposerScope, type ComposerTool } from './BoardComposer.js';
import { pushHistory, applyInverse, type HistoryEntry } from './history.js';
import type { BoardSync } from './board-sync.js';
import type { BoardLevelPlan } from './board-level.js';

export interface BoardsProps {
  client: BoardClient;
  onOpenPreview?: (ref: PreviewRef) => void;
  /** Active-document scope (Phase 4b). When absent, the view lists all boards and follow is disabled. */
  docScope?: DocScope;
  /** Opens the "all boards" picker (fuzzy search + create-new). Injected; board-view wires the real modal. */
  chooseBoard?: ChooseBoard;
  /** Plain-language composer (spec 2026-07-25). Absent = no composer, no sparkles. */
  interpret?: BoardInterpret;
  /** Plugin-wide coordination with board changes from elsewhere (chat's Pin). */
  boardSync?: BoardSync;
}

/** viz-ui's canonical query-viz kind list (table/kanban/list/calendar) — the ones VizCard renders
 *  and whose presentation keys (`pickPresentation`) are meaningful. Node/stats/spend
 *  views are server-shaped and render through their own dedicated components instead. */
const isVizKind = (s: BoardCardSpec): s is VizSpec => (VIZ_KINDS as readonly string[]).includes(s.kind);

/**
 * The composer's interpreter only ever returns the six structural VizSpec keys — its schema
 * can't express viz-ui's presentation keys (INTERPRET_SCHEMA omits them). Replacing a view's
 * spec wholesale with the interpreter's result would silently discard any hand-tuned
 * presentation the user set via the view's own controls. Carry those keys forward from the
 * prior spec instead. `date_field` is NOT included here — it is structural (calendar's plotted
 * field), not presentation, and the interpreter is the authority on it.
 */
function pickPresentation(spec: VizSpec): Partial<VizSpec> {
  const { density, show_row_numbers, show_version, show_link_counts, column_widths } = spec;
  return {
    ...(density !== undefined ? { density } : {}),
    ...(show_row_numbers !== undefined ? { show_row_numbers } : {}),
    ...(show_version !== undefined ? { show_version } : {}),
    ...(show_link_counts !== undefined ? { show_link_counts } : {}),
    ...(column_widths !== undefined ? { column_widths } : {}),
  };
}

/** A table showing a column sort (#393): its query's sort_by / sort_order are not the order shown. */
function hasColumnSort(spec: VizSpec): boolean {
  return spec.kind === 'table' && tableSortOf(spec)?.client === true;
}

/**
 * The view as the interpreter sees it. The interpreter's schema can't express a column sort, so the
 * spec goes without one, and a table showing one also goes without the query sort it replaces. A
 * sort in the interpreter's answer is then something the person asked for (carryForward).
 */
function forInterpreter(spec: VizSpec): VizSpec {
  // Folded sections are presentation the interpreter's schema can't express (carryForward keeps them).
  const { collapsed_groups: _folds, ...unfolded } = spec;
  const plain = withoutColumnSort(unfolded);
  if (!hasColumnSort(spec)) return plain;
  const { sort_by: _by, sort_order: _order, ...query } = spec.query;
  return { ...plain, query };
}

/**
 * The interpreter's result with the prior view's presentation carried forward. A column sort
 * carries forward too, with the query sort under it, unless the answer sets a query sort: the
 * interpreter saw none (forInterpreter), so that sort was asked for and becomes the view's sort.
 */
function carryForward(prior: VizSpec, next: VizSpec): VizSpec {
  // Folded sections (#573) name the group field's values, so they carry only while it is unchanged.
  const keepsFolds = prior.collapsed_groups !== undefined && next.group_by === prior.group_by;
  const merged: VizSpec = { ...next, ...pickPresentation(prior), ...(keepsFolds ? { collapsed_groups: prior.collapsed_groups } : {}) };
  if (!hasColumnSort(prior) || next.query.sort_by !== undefined || next.query.sort_order !== undefined) return merged;
  const { sort_by, sort_order } = prior.query;
  return {
    ...merged,
    query: { ...next.query, ...(sort_by !== undefined ? { sort_by } : {}), ...(sort_order !== undefined ? { sort_order } : {}) },
    column_sort: prior.column_sort,
  };
}

// ─── View presets ────────────────────────────────────────────────────────────

interface ViewPreset { key: string; label: string; icon: IconName; spec: () => BoardCardSpec }

/** The List preset for a vault: its tasks, showing their status and due date. The names are written
 *  into the spec, so a saved board keeps them. Null when the vault map has no task kind. */
export function listPreset(v: Pick<ViewVocabulary, 'taskType' | 'taskStatusField' | 'dueField'>): VizSpec | null {
  if (v.taskType === null) return null;
  return { kind: 'list', title: '', query: { types: [v.taskType] }, display_fields: namedFields(v.taskStatusField, v.dueField) };
}

const CALENDAR_PRESET: VizSpec = { kind: 'calendar', title: '', query: {}, display_fields: [] };

/**
 * The query views offered for a vault (the vault map's names). Kanban and List are task views: a
 * vault with no task kind gets neither, and one with no task status field gets no Kanban.
 */
export function queryViewPresets(v: ViewVocabulary): readonly ViewPreset[] {
  const kanban = kanbanPreset(v);
  const list = listPreset(v);
  return [
    { key: 'table', label: 'Table', icon: 'b-table', spec: () => ({ ...TABLE_PRESET }) },
    ...(kanban ? [{ key: 'kanban', label: 'Kanban', icon: 'b-kanban', spec: () => ({ ...kanban }) } satisfies ViewPreset] : []),
    ...(list ? [{ key: 'list', label: 'List', icon: 'b-list', spec: () => ({ ...list }) } satisfies ViewPreset] : []),
    { key: 'calendar', label: 'Calendar', icon: 'b-calendar', spec: () => ({ ...CALENDAR_PRESET }) },
  ];
}

export const OTHER_VIEW_PRESETS: readonly ViewPreset[] = [
  { key: 'stats', label: 'Vault overview', icon: 'b-stats', spec: () => ({ kind: 'stats', title: 'Vault overview' }) },
  { key: 'spend', label: 'Usage and cost', icon: 'b-coins', spec: () => ({ kind: 'spend', title: 'Usage and cost', range: 'month' }) },
];

/** Views that need a target or an argument first: the + menu opens the composer on that tool. */
const COMPOSER_VIEW_PRESETS: ReadonlyArray<{ tool: ComposerTool; label: string; icon: IconName }> = [
  { tool: 'get-node', label: 'One note', icon: 'b-file' },
];

const VIEW_KIND_ICON: Record<string, IconName> = {
  table: 'b-table', kanban: 'b-kanban', list: 'b-list', tasklist: 'b-list', calendar: 'b-calendar',
  node: 'b-file', stats: 'b-stats', spend: 'b-coins',
};

const OTHER_KIND_LABEL: Record<string, string> = {
  node: 'Note', stats: 'Vault overview', spend: 'Usage and cost',
};

/** A view's tab label: its title, else the layout's label. */
function viewName(spec: BoardCardSpec): string {
  const title = spec.title.trim();
  if (title) return title;
  return isVizKind(spec) ? KIND_LABEL[spec.kind] : (OTHER_KIND_LABEL[spec.kind] ?? spec.kind);
}

/** Name for a board created implicitly (the empty pane's chooser, a composer create with no
 *  board): the active note's name, so the board is recognisable in "Show all boards…". */
function defaultBoardName(docScope: DocScope | undefined): string {
  const key = docScope?.currentKey();
  const base = key ? key.split('/').pop()?.replace(/\.md$/i, '').trim() : '';
  return base || 'New board';
}

/** Inline text input for board create/rename and view rename. Defined at module scope so React
 *  never remounts it due to parent re-renders (e.g. follow-subscription active-doc changes). */
function InlineNameInput({ value, className, label = 'board name', commitOnBlur = false, onChange, onCommit, onCancel }: {
  value: string;
  className: string;
  label?: string;
  /** Commit when focus leaves (the tab rename); the header inputs keep explicit Save/Cancel. */
  commitOnBlur?: boolean;
  /** Reports each edit, so a Create/Save button beside the input commits the current text. */
  onChange?: (val: string) => void;
  onCommit: (val: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  // Enter/Escape settle the input once; a blur that follows (unmount, focus moving) is ignored.
  const settled = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      className={className}
      aria-label={label}
      value={val}
      onChange={(e) => { setVal(e.target.value); onChange?.(e.target.value); }}
      onBlur={() => { if (commitOnBlur && !settled.current) { settled.current = true; onCommit(val); } }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); settled.current = commitOnBlur; onCommit(val); }
        if (e.key === 'Escape') { e.preventDefault(); settled.current = commitOnBlur; onCancel(); }
      }}
    />
  );
}

/** The layout chooser shown for a note with no board, or a board with no view yet. */
function ViewChooser({ onPick, onDescribe }: { onPick: (spec: BoardCardSpec) => void; onDescribe?: () => void }) {
  const vocabulary = useVizVocabulary();
  const presets = useMemo(() => queryViewPresets(vocabulary), [vocabulary]);
  return (
    <div className="vb-chooser" role="group" aria-label="Choose a view">
      {[...presets, ...OTHER_VIEW_PRESETS].map((p) => (
        <button key={p.key} type="button" className="vb-chooser-btn" onClick={() => onPick(p.spec())}>
          <Icon name={p.icon} />{p.label}
        </button>
      ))}
      {onDescribe && (
        <button type="button" className="vb-chooser-btn" onClick={onDescribe}>
          <Icon name="b-sparkles" />Describe a view…
        </button>
      )}
    </div>
  );
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'creating'; name: string; saving: boolean }
  | { kind: 'renaming'; name: string; saving: boolean }
  | { kind: 'deleting' };

/** The composer is either tweaking the view in the current tab or describing new views. */
type ComposerState = { mode: 'tweak' } | { mode: 'create'; tool?: ComposerTool };

/** The undo banner: boards the composer created (Undo deletes them), or a view tab the user
 *  closed (Undo puts it back where it was). */
type UndoSlot =
  | { kind: 'boards'; label: string; detail: string; boardIds: string[] }
  | { kind: 'view'; label: string; boardId: string; card: BoardCard };

/** How long an untouched undo banner stays up. A closed view's Undo is a short toast; a
 *  created-boards Undo deletes whole boards, so it stays up longer. */
export const UNDO_TIMEOUT_MS: Record<UndoSlot['kind'], number> = { view: 10_000, boards: 60_000 };

/**
 * The undo banner. It dismisses itself after UNDO_TIMEOUT_MS; the timer pauses while the pointer
 * is over the banner, while focus is inside it, and while an undo is in flight, then resumes with
 * the time that was left. A new slot starts a fresh timer. × dismisses it at once.
 */
function UndoBanner({ slot, busy, onUndo, onDismiss }: {
  slot: UndoSlot;
  busy: boolean;
  onUndo: () => void;
  /** Drops `slot`, and only `slot`: a newer slot that replaced it stays. */
  onDismiss: (slot: UndoSlot) => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused || busy;
  // Time left on the current slot's timer, kept across pauses.
  const left = useRef<{ slot: UndoSlot; ms: number } | null>(null);
  useEffect(() => {
    if (left.current?.slot !== slot) left.current = { slot, ms: UNDO_TIMEOUT_MS[slot.kind] };
    if (paused) return;
    const entry = left.current;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(slot), entry.ms);
    return () => {
      clearTimeout(timer);
      entry.ms = Math.max(0, entry.ms - (Date.now() - started));
    };
  }, [slot, paused, onDismiss]);
  return (
    <div
      className="vb-board-undo"
      title={slot.kind === 'boards' ? slot.detail : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
    >
      <span className="vb-board-undo-msg">
        {slot.label} · <button type="button" className="vb-board-undo-btn" disabled={busy} onClick={onUndo}>↩ Undo</button>
      </span>
      <button type="button" className="vb-board-undo-dismiss" aria-label="Dismiss" title="Dismiss" disabled={busy} onClick={() => onDismiss(slot)}>
        <Icon name="b-x" />
      </button>
    </div>
  );
}

/**
 * The Vault Boards pane. A board holds several views; the header picks the board (the active
 * note's linked boards, following the note unless frozen) and the tab strip below shows that
 * board's views, one at a time, in their stored order.
 */
export function Boards({ client, onOpenPreview, docScope, chooseBoard, interpret, boardSync }: BoardsProps): React.ReactElement {
  // The query views the + menu offers come from the vault map (Kanban and List need a task kind).
  const vocabulary = useVizVocabulary();
  const queryPresets = useMemo(() => queryViewPresets(vocabulary), [vocabulary]);
  // The active note's linked boards (or all boards when there is no docScope).
  const [summaries, setSummaries] = useState<BoardSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  // The selection as of the latest render, for async handlers that must not override a newer one.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // Bumped on a real active-document change to force a re-read of the selected board even when
  // selectedId itself is unchanged. lastDocKey suppresses the same-document events that
  // `active-leaf-change` fires when focus lands on the board leaf.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const lastDocKey = useRef<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  // Live pointer to the current board, kept in sync with `board` wherever `board` is assigned from
  // resolved data (never during render). Reads of this ref are what make applyCards/schedulePersist
  // immune to stale closures: a handler bound to an OLD render (e.g. a composer continuation that
  // resolves after the user has switched boards) still sees the CURRENT board through this ref.
  const boardRef = useRef<Board | null>(null);
  const [cards, setCards] = useState<BoardCard[]>([]);
  // The open view tab. Stale ids are harmless: the render falls back to the first view.
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  // The last open tab per board, so switching boards and back returns to the same view.
  const lastTabRef = useRef<Map<string, string>>(new Map());
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [renamingView, setRenamingView] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docNodeId, setDocNodeId] = useState<string | null>(null);
  // Live pointer to docNodeId, same rationale as boardRef: an async continuation that resolves
  // after the active document changed must refresh summaries for whichever doc is CURRENT.
  const docNodeIdRef = useRef<string | null>(null);
  // Whether the selection tracks the active note (default on). Off = frozen while browsing notes.
  const [follow, setFollow] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const boardMenuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(boardMenuRef, boardMenuOpen, () => setBoardMenuOpen(false));
  const [plusOpen, setPlusOpen] = useState(false);
  // Open the + menu leftward when the button sits in the right half of the pane, so it never
  // runs off a narrow (sidebar) pane's edge.
  const [plusRight, setPlusRight] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(plusRef, plusOpen, () => setPlusOpen(false));
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // The undo banner. Deliberately a SEPARATE slot from `history`/Revert: a created board need not
  // be the one in view, so that kind survives a board switch (a closed view's does not).
  const [undo, setUndo] = useState<UndoSlot | null>(null);
  // Guards undoAction against a double-click firing a second delete while the first is in flight.
  const [undoBusy, setUndoBusy] = useState(false);
  // The banner's timeout and × drop only the slot they belong to, never a newer one.
  const dismissUndo = useCallback((slot: UndoSlot) => setUndo((u) => (u === slot ? null : u)), []);
  const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // Debounce timer ref — board saves are debounced ~400ms to avoid excess writes on rapid edits.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the active note's linked boards (or all boards when there is no docScope).
  const loadSummaries = useCallback(async (docId: string | null): Promise<BoardSummary[]> => {
    try {
      const list = docScope ? (docId ? await client.listForDoc(docId) : []) : await client.list();
      setSummaries(list);
      setError(null);
      return list;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, [client, docScope]);

  // Mount: resolve the active doc, load its boards, and (following) select its most-recent board.
  useEffect(() => {
    void (async () => {
      lastDocKey.current = docScope?.currentKey() ?? null;
      const id = docScope ? await docScope.current() : null;
      setDocNodeId(id); docNodeIdRef.current = id;
      const list = await loadSummaries(id);
      setSelectedId(pickFollowBoard(list) ?? '');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Active-document changes: always refresh the note's boards; re-resolve the selection only while
  // following (frozen keeps the current selection as you browse). Re-subscribe when `follow` flips.
  //  - Ignore events whose document key is unchanged: `active-leaf-change` also fires when focus
  //    moves onto the board leaf itself, and refetching there would spam the engine and risk
  //    clobbering an in-progress edit.
  //  - Bump `refreshNonce` so the SELECTED board is re-read even when `selectedId` does not change.
  useEffect(() => {
    const ds = docScope;
    if (!ds) return;
    return ds.subscribe(() => void (async () => {
      const key = ds.currentKey();
      if (key === lastDocKey.current) return;
      lastDocKey.current = key;
      const id = await ds.current();
      setDocNodeId(id); docNodeIdRef.current = id;
      const list = await loadSummaries(id);
      if (follow) setSelectedId(pickFollowBoard(list) ?? '');
      setRefreshNonce((n) => n + 1);
    })());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docScope, follow, loadSummaries]);

  const loadBoard = useCallback(async (id: string): Promise<void> => {
    setError(null);
    try {
      const b = await client.get(id);
      // Canonical order (array position = layout.order = 0..n-1), which every board-core mutator
      // and history inverse assumes. A board saved by another client may arrive out of order.
      const loaded = normalizeOrder(b?.cards ?? []);
      setBoard(b);
      boardRef.current = b;
      setCards(loaded);
      latestCardsRef.current = { boardId: b?.id ?? null, cards: loaded };
      setActiveCardId(b ? (lastTabRef.current.get(b.id) ?? null) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // Load (or clear) the board whenever the selection changes, or when an active-document change
  // bumps refreshNonce. View edits touch neither, so this never clobbers in-progress edits.
  useEffect(() => {
    setComposer((c) => (c?.mode === 'tweak' ? null : c));
    setHistory([]);
    setRenamingView(null);
    // A closed view's Undo belongs to the board it was closed on. Created-board Undo is kept —
    // it names its boards explicitly, so it must survive a board switch.
    setUndo((u) => (u?.kind === 'view' ? null : u));
    const done = (async () => {
      // Flush the old board's pending save BEFORE the reload's own read, and AWAIT it: an
      // un-awaited flush would race the reload and a same-board refresh could revert the edit.
      // A failed save was already reported. Reloading that same board would replace the unsaved
      // edit with the older saved version, so keep it; a switch to another board goes ahead.
      const flushed = await flushPendingSave().then(() => true, () => false);
      if (!flushed && selectedId && boardRef.current?.id === selectedId) return;
      if (!selectedId) {
        setBoard(null); boardRef.current = null; setCards([]); setActiveCardId(null);
        latestCardsRef.current = { boardId: null, cards: [] };
        return;
      }
      await loadBoard(selectedId);
    })();
    // Until this load lands, the pane counts as showing the selected board (BoardSync).
    if (selectedId) {
      const loading = { id: selectedId, done };
      loadingRef.current = loading;
      void done.finally(() => { if (loadingRef.current === loading) loadingRef.current = null; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, refreshNonce, loadBoard]);

  // Close the ⋯ menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest('.vb-actions-menu, .vb-menu-btn')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  async function toggleFollow(): Promise<void> {
    const next = !follow;
    setFollow(next);
    if (next) {
      // Resume: snap to the active note's most-recent board.
      const list = await loadSummaries(docNodeId);
      setSelectedId(pickFollowBoard(list) ?? '');
    }
  }

  /**
   * Shared board-create path: the inline "New board…" input, the pickers' create-new entry, the
   * empty pane's chooser and a composer create with no board open. Links the new board to the
   * active note while following (or when forced — the link-a-board flow links regardless), then
   * selects it. Returns the new board id.
   */
  async function createBoard(name: string, opts?: { forceLink?: boolean; cards?: BoardCard[] }): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    setError(null);
    const { id } = await client.save({ name: trimmed, cards: opts?.cards ?? [] });
    const docId = docNodeIdRef.current;
    if ((follow || opts?.forceLink) && docId) await client.linkToDoc(id, docId); // entry-point-agnostic auto-link
    await loadSummaries(docId);
    setSelectedId(id);
    setMode({ kind: 'idle' });
    return id;
  }

  // Shared prefix of the two picker flows: fetch every board and run the modal.
  // Returns null on fetch failure (reported via the error banner) or dismissal.
  async function pickFromAllBoards(): Promise<BoardChoice | null> {
    if (!chooseBoard) return null;
    let all: BoardSummary[];
    try { all = await client.list(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return null; }
    return chooseBoard(all);
  }

  async function openAllBoards(): Promise<void> {
    setBoardMenuOpen(false);
    setMenuOpen(false);
    const choice = await pickFromAllBoards();
    if (!choice) return;
    if (choice.kind === 'existing') {
      if (!summaries.some((s) => s.id === choice.id)) setFollow(false); // off-note pick auto-freezes
      setSelectedId(choice.id);
    } else {
      try { await createBoard(choice.name); }
      catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    }
  }

  // Link-a-board flow: pick any board (or type a name to create one) and link it to the active
  // note. Unlike the "Show all boards…" browse escape, this never freezes — the picked board
  // becomes one of the note's own boards. The picker deliberately includes already-linked boards:
  // hiding them would make an exact-name query offer "Create board…" and silently create a
  // duplicate, while re-linking is a server-side no-op (INSERT OR IGNORE).
  async function linkExistingBoard(): Promise<void> {
    setBoardMenuOpen(false);
    setMenuOpen(false);
    if (!docNodeId) return;
    setError(null);
    const choice = await pickFromAllBoards();
    if (!choice) return;
    try {
      if (choice.kind === 'existing') {
        await client.linkToDoc(choice.id, docNodeId);
        await loadSummaries(docNodeId);
        setSelectedId(choice.id);
      } else {
        await createBoard(choice.name, { forceLink: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleLink(): Promise<void> {
    if (!board || !docNodeId) return;
    setError(null);
    const isLinked = (board.linked_docs ?? []).includes(docNodeId);
    try {
      if (isLinked) await client.unlinkFromDoc(board.id, docNodeId);
      else await client.linkToDoc(board.id, docNodeId);
      const refreshed = await client.get(board.id); // refresh linked_docs
      setBoard(refreshed);
      boardRef.current = refreshed;
      await loadSummaries(docNodeId);       // reflect an unlink in the note's boards
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** ⋯ → Refresh: land any pending save first, so the reload can't discard (then re-save over) an edit. */
  async function refreshBoard(): Promise<void> {
    // A failed save was already reported. Don't reload over it: the read would replace the unsaved
    // edit with the older saved version (and a deleted board has already been closed).
    try { await flushPendingSave(); } catch { return; }
    if (selectedId) await loadBoard(selectedId);
  }

  function selectBoard(id: string): void {
    setBoardMenuOpen(false);
    setMode({ kind: 'idle' });
    setSelectedId(id); // a note-board pick — follow stays as-is
  }

  function selectView(cardId: string): void {
    setActiveCardId(cardId);
    const id = boardRef.current?.id;
    if (id) lastTabRef.current.set(id, cardId);
  }

  /** Keep the header name field's text in `mode`, where the Create and Save buttons read it. */
  function setModeName(name: string): void {
    setMode((m) => (m.kind === 'creating' || m.kind === 'renaming') ? { ...m, name } : m);
  }

  function startCreate(): void { setError(null); setBoardMenuOpen(false); setMenuOpen(false); setMode({ kind: 'creating', name: '', saving: false }); }

  async function commitCreate(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    setMode({ kind: 'creating', name, saving: true });
    try { await createBoard(trimmed); }
    catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMode({ kind: 'creating', name, saving: false });
    }
  }

  function startRename(): void {
    if (!board) return;
    setError(null);
    setMode({ kind: 'renaming', name: board.name, saving: false });
  }

  async function commitRename(name: string): Promise<void> {
    if (!board) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === board.name) { setMode({ kind: 'idle' }); return; }
    setMode({ kind: 'renaming', name, saving: true });
    try {
      await client.save({ id: board.id, name: trimmed, cards: latestCardsRef.current.cards });
      await loadSummaries(docNodeId);
      const refreshed = await client.get(board.id);
      setBoard(refreshed);
      boardRef.current = refreshed;
      setMode({ kind: 'idle' });
    } catch (err) {
      if (isBoardNotFound(err)) { setMode({ kind: 'idle' }); reportSaveFailure(board, err); return; }
      setError(err instanceof Error ? err.message : String(err));
      setMode({ kind: 'renaming', name, saving: false });
    }
  }

  function startDelete(): void { if (!board) return; setError(null); setMode({ kind: 'deleting' }); }

  async function commitDelete(): Promise<void> {
    if (!board) return;
    try {
      await client.remove(board.id);
      lastTabRef.current.delete(board.id);
      setMode({ kind: 'idle' });
      const list = await loadSummaries(docNodeId);
      // Land on the note's next board rather than an empty pane.
      setSelectedId(pickFollowBoard(list) ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMode({ kind: 'idle' });
    }
  }

  // Synchronous latest-cards mirror. Every mutation flows through applyCards, which advances
  // this ref BEFORE React commits — so an async interpret continuation that resolves after a
  // manual edit computes from the post-edit array, not the render it was created in. boardId
  // tags which board the mirror describes: a debounce timer scheduled on one board must never
  // persist against another board's mirror (see flushPendingSave / the fire-time guard).
  const latestCardsRef = useRef<{ boardId: string | null; cards: BoardCard[] }>({ boardId: null, cards: [] });
  // The scheduled save, kept invokable (and awaitable) so a board switch/reload can flush it
  // instead of dropping it, and can await it instead of racing it.
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null);
  // Saves already sent, chained so they reach Engine in order: each one writes the whole card
  // list, so an older list landing after a newer one would undo it.
  const savingRef = useRef<Promise<unknown>>(Promise.resolve());
  // The board being loaded for a new selection, while that load is in flight.
  const loadingRef = useRef<{ id: string; done: Promise<void> } | null>(null);

  /** A save Engine refused. A board deleted elsewhere is closed here, never recreated (#304):
   *  the pane moves to the note's next board, as after deleting it here. */
  const reportSaveFailure = useCallback((forBoard: { id: string; name: string }, err: unknown): void => {
    if (!isBoardNotFound(err)) {
      new Notice(`Couldn't save "${forBoard.name}": ${errMsg(err)}`);
      return;
    }
    new Notice(`"${forBoard.name}" was deleted elsewhere, so the last change to it wasn't saved.`);
    lastTabRef.current.delete(forBoard.id);
    // Only while the deleted board is still the one selected: a switch to another board (whose
    // load flushed this save) or a selection made while the list reloads must stand.
    const stillSelected = (): boolean => selectedIdRef.current === forBoard.id;
    if (!stillSelected()) { void loadSummaries(docNodeIdRef.current).catch(() => {}); return; }
    if (boardRef.current?.id === forBoard.id) {
      boardRef.current = null;
      latestCardsRef.current = { boardId: null, cards: [] };
      setBoard(null); setCards([]); setActiveCardId(null); setHistory([]);
    }
    void loadSummaries(docNodeIdRef.current)
      .then(list => { if (stillSelected()) setSelectedId(pickFollowBoard(list) ?? ''); })
      .catch(() => { if (stillSelected()) setSelectedId(''); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSummaries]);

  const schedulePersist = useCallback(() => {
    // Captured HERE, at schedule time, from the live ref — never the render-scoped `board`.
    const forBoard = boardRef.current;
    if (!forBoard) return;
    const run = (): Promise<void> => {
      pendingSaveRef.current = null;
      if (latestCardsRef.current.boardId !== forBoard.id) return Promise.resolve(); // mirror moved on — never cross-save
      // Name read at FIRE time: a rename that landed while this save was pending must not be
      // reverted by persisting the schedule-time snapshot's name.
      const live = boardRef.current;
      const name = live && live.id === forBoard.id ? live.name : forBoard.name;
      const cards = latestCardsRef.current.cards;
      const saved = savingRef.current.then(() => client.save({ id: forBoard.id, name, cards }));
      savingRef.current = saved.catch(() => {});
      // Reported here once; callers that await it (a pin through BoardSync) still see it fail.
      return saved.then(() => undefined, (err: unknown) => { reportSaveFailure({ id: forBoard.id, name }, err); throw err; });
    };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    pendingSaveRef.current = run;
    saveTimerRef.current = setTimeout(() => { void run().catch(() => {}); }, 400);
  }, [client, reportSaveFailure]);

  /** Fire any pending debounced save NOW and return a promise that resolves once it, and every
   *  save sent before it, has landed. */
  const flushPendingSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const pending = pendingSaveRef.current;
    return pending ? pending() : savingRef.current.then(() => undefined);
  }, []);

  function applyCards(updater: (prev: BoardCard[]) => BoardCard[]): BoardCard[] {
    const next = updater(latestCardsRef.current.cards);
    latestCardsRef.current = { boardId: boardRef.current?.id ?? null, cards: next };
    setCards(next);
    schedulePersist();
    return next;
  }
  const applyCardsRef = useRef(applyCards);
  applyCardsRef.current = applyCards;

  // While this pane shows a board, a change from elsewhere (chat's Pin) is made here, as an edit
  // of this pane, so this pane's card list stays the only one saved for that board (#287).
  // A board still loading for a new selection counts as shown: the change waits for the load.
  useEffect(() => boardSync?.register({
    shownBoardId: () => loadingRef.current?.id ?? boardRef.current?.id ?? null,
    applyChange: async (boardId, change) => {
      await loadingRef.current?.done;
      if (boardRef.current?.id !== boardId) return false; // moved on to another board meanwhile
      applyCardsRef.current(change);
      await flushPendingSave(); // land it (and any save before it) now, so the caller can report it saved
      return true;
    },
  }), [boardSync, flushPendingSave]);

  function handleSpecChange(card_id: string, next: BoardCardSpec): void {
    applyCards((prev) => prev.map((c) => (c.card_id === card_id ? { ...c, spec: next } : c)));
  }

  /**
   * Add a view as a new tab and open it. With no board open (a note without boards), this
   * creates the note's board around the view instead (`created` = that board's id). Null on failure.
   */
  async function addView(spec: BoardCardSpec): Promise<{ cardId: string; created: string | null } | null> {
    const card_id = crypto.randomUUID();
    if (!boardRef.current) {
      try {
        const id = await createBoard(defaultBoardName(docScope), { cards: [{ card_id, spec, layout: { order: 0 } }] });
        if (!id) return null;
        lastTabRef.current.set(id, card_id);
        return { cardId: card_id, created: id };
      } catch (err) {
        setError(errMsg(err));
        return null;
      }
    }
    applyCards((prev) => addCard(prev, spec, () => card_id));
    selectView(card_id);
    return { cardId: card_id, created: null };
  }

  /** Close a view tab. The banner's Undo puts it back where it was. */
  function closeView(card_id: string): void {
    const b = boardRef.current;
    const card = latestCardsRef.current.cards.find((c) => c.card_id === card_id);
    if (!b || !card) return;
    const spec = parseBoardCardSpec(card.spec);
    // Closing the open tab lands on its right-hand neighbour (or the left one at the end).
    const ordered = [...latestCardsRef.current.cards].sort((a, b) => a.layout.order - b.layout.order);
    const idx = ordered.findIndex((c) => c.card_id === card_id);
    const wasOpen = (ordered.find((c) => c.card_id === activeCardId) ?? ordered[0])?.card_id === card_id;
    applyCards((prev) => removeCard(prev, card_id));
    if (wasOpen) {
      const neighbour = ordered[idx + 1] ?? ordered[idx - 1];
      if (neighbour) selectView(neighbour.card_id);
    }
    if (renamingView === card_id) setRenamingView(null);
    setUndo({ kind: 'view', label: `Closed "${spec ? viewName(spec) : 'view'}"`, boardId: b.id, card });
  }

  function commitViewRename(card_id: string, name: string): void {
    setRenamingView(null);
    const card = latestCardsRef.current.cards.find((c) => c.card_id === card_id);
    const spec = card ? parseBoardCardSpec(card.spec) : null;
    if (!spec || name.trim() === spec.title.trim()) return;
    // An empty name clears the title, so the tab falls back to the layout's label.
    handleSpecChange(card_id, { ...spec, title: name.trim() });
  }

  // The trailing `boardKey` on the composer-continuation handlers below is the board id
  // BoardComposer captured when the user hit Enter. interpret() is async — by the time it
  // resolves, the user may have switched boards. Silently applying a stale continuation's result
  // to whatever board now happens to be current would be wrong, so these early-return instead.

  /** Composer create → a new tab on this board (Revert removes it), or a new board when none is open. */
  function handleComposerCreate(spec: BoardCardSpec, boardKey: string | null): void {
    if (boardKey !== (boardRef.current?.id ?? null)) return; // resolved after a board switch — drop it
    setUndo(null); // only an action that actually APPLIES retires the undo slot
    if (!boardRef.current) {
      setComposer(null);
      void (async () => {
        const name = defaultBoardName(docScope);
        const added = await addView(spec);
        if (added?.created) setUndo({ kind: 'boards', label: `✓ Created "${name}"`, detail: viewName(spec), boardIds: [added.created] });
      })();
      return;
    }
    const card_id = crypto.randomUUID();
    applyCards((prev) => addCard(prev, spec, () => card_id));
    selectView(card_id);
    setHistory((h) => pushHistory(h, { label: 'create', detail: viewName(spec), inverse: [{ op: 'remove_card', cardId: card_id }] }));
  }

  function handleComposerTweak(card_id: string, next: BoardCardSpec, boardKey: string | null): void {
    if (boardKey !== (boardRef.current?.id ?? null)) return; // resolved after a board switch — drop it
    setUndo(null);
    // Parsed, not raw: a legacy `tasklist`-kind prior fails isVizKind's raw check even though
    // parseBoardCardSpec normalizes it to `list`. Read from the mirror, not the render binding —
    // this continuation can resolve after a manual edit changed the view.
    const priorRaw = latestCardsRef.current.cards.find((c) => c.card_id === card_id)?.spec;
    const prior = priorRaw !== undefined ? parseBoardCardSpec(priorRaw) : null;
    if (prior) {
      setHistory((h) => pushHistory(h, {
        label: 'tweak',
        detail: prior.title.trim() || prior.kind,
        inverse: [{ op: 'restore_spec', cardId: card_id, spec: prior }],
      }));
    }
    // Presentation keys only carry forward when BOTH the prior and next specs are viz kinds.
    const merged = prior && isVizKind(prior) && isVizKind(next) ? carryForward(prior, next) : next;
    handleSpecChange(card_id, merged);
  }

  /** Several views: adds, replaces and removes all apply to this board's views, as one Revert step.
   *  When nothing on the board was replaced, the first added view opens. */
  function handleBoardOps(ops: ResolvedOp[], summary: string, boardKey: string | null, capped: boolean):
    { added: number; replaced: number; removed: number } | null {
    if (boardKey !== (boardRef.current?.id ?? null)) return null; // resolved after a board switch — drop it
    if (!boardRef.current) {
      // No board open (a note without boards): the added views become the note's new board.
      // Replaces and removes have nothing to act on.
      const adds = ops.flatMap((o) => (o.op === 'add' ? [o.spec] : []));
      if (adds.length === 0) return { added: 0, replaced: 0, removed: 0 };
      setUndo(null);
      setComposer(null);
      const name = defaultBoardName(docScope);
      const created = adds.map((spec, i): BoardCard => ({ card_id: crypto.randomUUID(), spec, layout: { order: i } }));
      void (async () => {
        try {
          const id = await createBoard(name, { cards: created });
          if (id) setUndo({ kind: 'boards', label: `✓ Created "${name}"`, detail: `${summary}${capped ? ' (capped)' : ''}`, boardIds: [id] });
        } catch (err) {
          setError(errMsg(err));
        }
      })();
      return { added: adds.length, replaced: 0, removed: 0 };
    }
    setUndo(null);
    let applied!: AppliedOps;
    applyCards((prev) => {
      applied = applyResolvedOps(prev, ops, () => crypto.randomUUID(), (prior, next) =>
        isVizKind(prior) && isVizKind(next) ? carryForward(prior, next) : next);
      return applied.next;
    });
    setHistory((h) => pushHistory(h, { label: 'board op', detail: `${summary}${capped ? ' (capped)' : ''}`, inverse: applied.inverse }));
    const addedIds = new Set(applied.inverse.flatMap((inv) => (inv.op === 'remove_card' ? [inv.cardId] : [])));
    const firstAdded = applied.next.find((c) => addedIds.has(c.card_id));
    if (firstAdded && applied.counts.replaced === 0) selectView(firstAdded.card_id);
    return applied.counts;
  }

  // Board-level plan apply (create_board): one new board holding every planned view, linked to the
  // plan's target note, then opened. Mirrors the stale-board guard of the other continuations.
  // Placed BEFORE `setUndo(null)` so a dropped/stale call has zero side effects.
  async function applyBoardPlan(plan: BoardLevelPlan, boardKey: string | null): Promise<void> {
    if (boardKey !== (boardRef.current?.id ?? null)) return; // resolved after a board switch — drop it
    setUndo(null);
    const { id } = await client.save({ name: plan.name, cards: plan.cards.map((spec, i) => ({ card_id: crypto.randomUUID(), spec, layout: { order: i } })) });
    let linkFailed = false;
    if (plan.linkNodeId) {
      try { await client.linkToDoc(id, plan.linkNodeId); }
      catch (err) { linkFailed = true; console.warn(`[vault-obsidian] link-board failed: ${errMsg(err)}`); }
    }
    setUndo({ kind: 'boards', label: `✓ Created "${plan.name}"${linkFailed ? ' (link failed)' : ''}`, detail: plan.summary, boardIds: [id] });
    setComposer(null);
    await loadSummaries(docNodeIdRef.current);
    setSelectedId(id);
  }

  async function undoAction(): Promise<void> {
    if (!undo || undoBusy) return;
    if (undo.kind === 'view') {
      if (boardRef.current?.id === undo.boardId) {
        applyCards((prev) => applyInverse(prev, [{ op: 'reinsert_card', card: undo.card }]));
        selectView(undo.card.card_id);
      }
      setUndo(null);
      return;
    }
    setUndoBusy(true);
    try {
      setError(null);
      for (const id of undo.boardIds) {
        try { await client.remove(id); }   // remove() returning false = already gone = success
        catch (err) { setError(`undo incomplete — ${errMsg(err)}`); return; }   // slot retained (retryable)
      }
      setUndo(null);
      const list = await loadSummaries(docNodeIdRef.current);
      if (boardRef.current && undo.boardIds.includes(boardRef.current.id)) setSelectedId(pickFollowBoard(list) ?? '');
    } finally {
      setUndoBusy(false);
    }
  }

  function handleRevert(): void {
    const top = history[history.length - 1];
    if (!top) return;
    setHistory((h) => h.slice(0, -1));
    applyCards((prev) => applyInverse(prev, top.inverse));
  }

  const sortedCards = [...cards].sort((a, b) => a.layout.order - b.layout.order);
  const view = sortedCards.find((c) => c.card_id === activeCardId) ?? sortedCards[0] ?? null;
  const viewSpec = view ? parseBoardCardSpec(view.spec) : null;

  // Derived fresh every render from the LIVE view — never a stale snapshot from the sparkles
  // click — and naturally null the instant the view stops being tweakable (gone or unparseable).
  const composerScope: ComposerScope | null = (() => {
    // A Usage and cost view has no composer tool: its range picker is its only control.
    if (composer?.mode !== 'tweak' || !view || !viewSpec || viewSpec.kind === 'spend') return null;
    return { cardId: view.card_id, title: viewName(viewSpec), spec: isVizKind(viewSpec) ? forInterpreter(viewSpec) : viewSpec };
  })();
  // A tweak composer whose target vanished closes rather than silently flipping to create mode.
  useEffect(() => {
    if (composer?.mode === 'tweak' && composerScope === null) setComposer(null);
  }, [composer, composerScope]);

  // Every view on the board, so "Several views" can address any of them by card_id.
  const boardContext: BoardContextCard[] = sortedCards.flatMap((c) => {
    const spec = parseBoardCardSpec(c.spec);
    if (!spec) return [];
    let promptSpec: Record<string, unknown> | undefined;
    if (isVizKind(spec)) {
      // Structural keys only — presentation is meaningless to the interpreter and bloats the prompt.
      const { density: _d, show_row_numbers: _r, show_version: _v, show_link_counts: _l, column_widths: _w, ...structural } = forInterpreter(spec);
      promptSpec = structural as unknown as Record<string, unknown>;
    }
    return [{ card_id: c.card_id, kind: spec.kind, title: spec.title.trim() || spec.kind, ...(promptSpec ? { spec: promptSpec } : {}) }];
  });
  const top = history[history.length - 1];
  const revert = top ? { label: top.label, detail: top.detail } : null;

  const offNoteSelected = !!selectedId && !!board && !summaries.some((s) => s.id === selectedId);
  const linkedToActive = !!(board && docNodeId && (board.linked_docs ?? []).includes(docNodeId));
  const boardList = useMemo(() => orderBoards(summaries), [summaries]);

  const sparkles = interpret && viewSpec ? (
    <button
      type="button"
      className={`viz-tb-btn viz-tb-icon vb-sparkles${composer?.mode === 'tweak' ? ' on' : ''}`}
      aria-label="describe a change to this view"
      aria-pressed={composer?.mode === 'tweak'}
      title="Describe a change to this view"
      onClick={() => setComposer((c) => (c?.mode === 'tweak' ? null : { mode: 'tweak' }))}
    >
      <Icon name="b-sparkles" />
    </button>
  ) : null;

  function openDescribe(tool?: ComposerTool): void {
    setPlusOpen(false);
    setComposer({ mode: 'create', ...(tool ? { tool } : {}) });
  }

  function addPreset(spec: BoardCardSpec): void {
    setPlusOpen(false);
    void addView(spec);
  }

  const renderView = (): React.ReactNode => {
    if (!board || !view) return null;
    const key = `${board.id}:${view.card_id}`;
    if (viewSpec === null) return <div className="vb-card-unrecognized" key={key}>unrecognized view</div>;
    if (isVizKind(viewSpec)) {
      return (
        <VizCard
          key={key}
          spec={viewSpec}
          presentation="pane"
          onOpenPreview={onOpenPreview}
          onSpecChange={(next) => handleSpecChange(view.card_id, next)}
          toolbarActions={sparkles}
        />
      );
    }
    switch (viewSpec.kind) {
      case 'node':
        return <NodeCard key={key} spec={viewSpec} onOpenPreview={onOpenPreview} onSpecChange={(next) => handleSpecChange(view.card_id, next)} actions={sparkles} />;
      case 'stats':
        return <StatsCard key={key} spec={viewSpec} actions={sparkles} />;
      case 'spend':
        return <SpendCard key={key} spec={viewSpec} onSpecChange={(next) => handleSpecChange(view.card_id, next)} />;
      default:
        return <div className="vb-card-unrecognized" key={key}>unrecognized view</div>;
    }
  };

  return (
    <div className="vb-root">
      <div className="vb-header">
        {mode.kind === 'creating' ? (
          <>
            <InlineNameInput value={mode.name} className="vb-new-input" onChange={setModeName} onCommit={(v) => void commitCreate(v)} onCancel={() => setMode({ kind: 'idle' })} />
            <button type="button" onClick={() => void commitCreate(mode.name)} disabled={mode.saving}>Create</button>
            <button type="button" onClick={() => setMode({ kind: 'idle' })}>Cancel</button>
          </>
        ) : mode.kind === 'renaming' ? (
          <>
            <InlineNameInput value={mode.name} className="vb-rename-input" onChange={setModeName} onCommit={(v) => void commitRename(v)} onCancel={() => setMode({ kind: 'idle' })} />
            <button type="button" onClick={() => void commitRename(mode.name)} disabled={mode.saving}>Save</button>
            <button type="button" onClick={() => setMode({ kind: 'idle' })}>Cancel</button>
          </>
        ) : mode.kind === 'deleting' ? (
          <>
            <span className="vb-delete-label">Delete board &ldquo;{board?.name}&rdquo; and its {cards.length === 1 ? 'view' : `${cards.length} views`}?</span>
            <button type="button" className="vb-delete-confirm" onClick={() => void commitDelete()}>Confirm</button>
            <button type="button" className="vb-delete-cancel" onClick={() => setMode({ kind: 'idle' })}>Cancel</button>
          </>
        ) : (
          <>
            <div className="vb-board-wrap" ref={boardMenuRef}>
              <button
                type="button"
                className={`vb-board-btn${offNoteSelected ? ' is-off-note' : ''}${board ? '' : ' is-empty'}`}
                data-board-id={selectedId}
                aria-label="board switcher"
                aria-haspopup="menu"
                aria-expanded={boardMenuOpen}
                title={board ? `${board.name}${offNoteSelected ? ' (not linked to this note)' : ''}` : 'Choose a board'}
                onClick={() => setBoardMenuOpen((v) => !v)}
              >
                <Icon name="b-boards" />
                <span className="vb-board-name">{board ? board.name : 'No board'}</span>
                <Icon name="b-chevron-down" className="vb-board-caret" />
              </button>
              {boardMenuOpen && (
                <div className="vb-menu vb-board-menu" role="menu" aria-label="Boards">
                  <div className="vb-menu-title">{docScope ? (docNodeId ? 'Boards on this note' : 'No active note') : 'Boards'}</div>
                  {boardList.map((s) => (
                    <button key={s.id} type="button" role="menuitemradio" aria-checked={s.id === selectedId} data-board-id={s.id} className="vb-board-item" onClick={() => selectBoard(s.id)}>
                      <span className="vb-menu-label">{s.name}</span>
                      {s.id === selectedId && <Icon name="b-check" className="vb-menu-check" />}
                    </button>
                  ))}
                  {offNoteSelected && board && (
                    <button type="button" role="menuitemradio" aria-checked data-board-id={board.id} className="vb-board-item is-off-note" onClick={() => setBoardMenuOpen(false)}>
                      <span className="vb-menu-label">{board.name}</span>
                      <Icon name="b-check" className="vb-menu-check" />
                    </button>
                  )}
                  {boardList.length === 0 && !offNoteSelected && <div className="vb-menu-empty">None yet</div>}
                  <div className="vb-menu-sep" />
                  <button type="button" role="menuitem" className="vb-menu-new" onClick={() => startCreate()}><Icon name="b-plus" />New board…</button>
                  {docNodeId && chooseBoard && (
                    <button type="button" role="menuitem" className="vb-menu-link-existing" onClick={() => void linkExistingBoard()}><Icon name="b-link" />Link a board to this note…</button>
                  )}
                  {chooseBoard && <button type="button" role="menuitem" className="vb-menu-all" onClick={() => void openAllBoards()}><Icon name="b-boards" />Show all boards…</button>}
                </div>
              )}
            </div>

            <span className="vb-header-spacer" />

            {docScope && (
              <button
                type="button"
                className={`vb-icon-btn vb-follow${follow ? ' on' : ''}`}
                aria-label="follow active note's board"
                aria-pressed={follow}
                title={follow ? "Following the active note's boards — click to freeze" : 'Frozen — click to follow the active note'}
                onClick={() => void toggleFollow()}
              ><Icon name="b-eye" /></button>
            )}

            <button
              type="button"
              className="vb-icon-btn vb-menu-btn"
              aria-label="board actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            ><Icon name="b-more" /></button>

            {menuOpen && (
              <div className="vb-menu vb-actions-menu" role="menu">
                <button type="button" role="menuitem" className="vb-menu-new" onClick={() => startCreate()}><Icon name="b-plus" />New board…</button>
                {board && <button type="button" role="menuitem" className="vb-menu-rename" onClick={() => { setMenuOpen(false); startRename(); }}><Icon name="b-pencil" />Rename board</button>}
                {board && docNodeId && (
                  <button type="button" role="menuitem" className="vb-menu-link" onClick={() => { setMenuOpen(false); void toggleLink(); }}>
                    <Icon name={linkedToActive ? 'b-unlink' : 'b-link'} />{linkedToActive ? 'Unlink from this note' : 'Link to this note'}
                  </button>
                )}
                {selectedId && <button type="button" role="menuitem" className="vb-refresh" onClick={() => { setMenuOpen(false); void refreshBoard(); }}><Icon name="b-refresh" />Refresh</button>}
                {board && <div className="vb-menu-sep" />}
                {board && <button type="button" role="menuitem" className="vb-menu-delete" onClick={() => { setMenuOpen(false); startDelete(); }}><Icon name="b-trash" />Delete board</button>}
              </div>
            )}
          </>
        )}
      </div>

      {board && (
        <div className="vb-tabbar">
          <div className="vb-tabs" role="tablist" aria-label="Views">
            {sortedCards.map((c) => {
              const spec = parseBoardCardSpec(c.spec);
              const on = c.card_id === view?.card_id;
              const name = spec ? viewName(spec) : 'Unrecognized view';
              if (renamingView === c.card_id) {
                return (
                  <span key={c.card_id} className="vb-tab is-active is-renaming" data-card-id={c.card_id}>
                    <InlineNameInput
                      value={spec?.title ?? ''}
                      className="vb-tab-input"
                      label="view name"
                      commitOnBlur
                      onCommit={(v) => commitViewRename(c.card_id, v)}
                      onCancel={() => setRenamingView(null)}
                    />
                  </span>
                );
              }
              return (
                <span key={c.card_id} className={`vb-tab${on ? ' is-active' : ''}`} data-card-id={c.card_id}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    className="vb-tab-btn"
                    title={on && spec ? `${name} — double-click to rename` : name}
                    onClick={() => selectView(c.card_id)}
                    onDoubleClick={() => { if (on && spec) setRenamingView(c.card_id); }}
                  >
                    <Icon name={(spec ? VIEW_KIND_ICON[spec.kind] : undefined) ?? 'b-boards'} />
                    <span className="vb-tab-label">{name}</span>
                  </button>
                  <button type="button" className="vb-tab-close" aria-label={`close view ${name}`} title="Close view" onClick={() => closeView(c.card_id)}>
                    <Icon name="b-x" />
                  </button>
                </span>
              );
            })}
          </div>

          <div className="vb-plus-wrap" ref={plusRef}>
            <button
              type="button"
              className={`vb-icon-btn vb-plus${plusOpen ? ' on' : ''}`}
              aria-label="add a view"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              onClick={(e) => {
                const btn = e.currentTarget.getBoundingClientRect();
                const pane = e.currentTarget.closest('.vb-root')?.getBoundingClientRect();
                setPlusRight(!!pane && btn.left - pane.left > pane.width / 2);
                setPlusOpen((v) => !v);
              }}
            >
              <Icon name="b-plus" />
            </button>
            {plusOpen && (
              <div className={`vb-menu vb-plus-menu${plusRight ? ' is-right' : ''}`} role="menu" aria-label="Add a view">
                <div className="vb-menu-title">Query views</div>
                {queryPresets.map((p) => (
                  <button key={p.key} type="button" role="menuitem" onClick={() => addPreset(p.spec())}><Icon name={p.icon} />{p.label}</button>
                ))}
                <div className="vb-menu-sep" />
                <div className="vb-menu-title">Other views</div>
                {OTHER_VIEW_PRESETS.map((p) => (
                  <button key={p.key} type="button" role="menuitem" onClick={() => addPreset(p.spec())}><Icon name={p.icon} />{p.label}</button>
                ))}
                {interpret && COMPOSER_VIEW_PRESETS.map((p) => (
                  <button key={p.tool} type="button" role="menuitem" onClick={() => openDescribe(p.tool)}><Icon name={p.icon} />{p.label}…</button>
                ))}
                {interpret && <div className="vb-menu-sep" />}
                {interpret && <button type="button" role="menuitem" onClick={() => openDescribe()}><Icon name="b-sparkles" />Describe a view…</button>}
              </div>
            )}
          </div>
        </div>
      )}

      {error && <div className="vb-error" role="alert">{error}</div>}
      {!follow && (
        <div className="vb-frozen-banner">Frozen — not following the active note · click the eye to resume</div>
      )}
      {undo && <UndoBanner slot={undo} busy={undoBusy} onUndo={() => void undoAction()} onDismiss={dismissUndo} />}
      {interpret && composer && (composer.mode === 'create' || composerScope) && (
        <BoardComposer
          key={composer.mode === 'create' ? `create:${composer.tool ?? ''}` : 'tweak'}
          interpret={interpret}
          scope={composerScope}
          initialTool={composer.mode === 'create' ? composer.tool : undefined}
          onClearScope={() => setComposer({ mode: 'create' })}
          onClose={() => setComposer(null)}
          stayScopedAfterTweak
          onCreate={handleComposerCreate}
          onTweak={handleComposerTweak}
          onBoardOps={handleBoardOps}
          onBoardPlan={applyBoardPlan}
          onRevert={handleRevert}
          revert={revert}
          boardCards={boardContext}
          boardKey={board?.id ?? null}
        />
      )}

      <div className="vb-view">
        {board ? (
          view ? renderView() : (
            <div className="vb-empty">
              <div className="vb-empty-msg">&ldquo;{board.name}&rdquo; has no views yet — pick one:</div>
              <ViewChooser onPick={(spec) => void addView(spec)} onDescribe={interpret ? () => openDescribe() : undefined} />
            </div>
          )
        ) : (
          <div className="vb-empty">
            <div className="vb-empty-msg">{docScope && docNodeId ? 'No board linked to this note yet — start one with a view:' : 'No board selected'}</div>
            <ViewChooser onPick={(spec) => void addView(spec)} onDescribe={interpret ? () => openDescribe() : undefined} />
            <div className="vb-empty-actions">
              {chooseBoard && docNodeId && (
                <button type="button" className="vb-empty-link" onClick={() => void linkExistingBoard()}>Link existing board…</button>
              )}
              {chooseBoard && <button type="button" onClick={() => void openAllBoards()}>Show all boards…</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
