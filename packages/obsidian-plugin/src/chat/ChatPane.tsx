import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatTransport, UIMessage } from 'ai';
import type { VizSpec, PreviewRef } from '@vault/viz-ui';
import type { BoardCard, BoardClient, BoardSummary } from '@vault/board-core';
import { addCard, isBoardNotFound, normalizeOrder } from '@vault/board-core';
import { pickEffectiveBoard, providerAvailability, type ProviderKeys } from '@vault/chat-core';
import { resolvePricing } from '@vault/pricing';
import { Notice } from 'obsidian';
import { Chat } from './Chat.js';
import { ContextChipsBar, ConversationSwitcher, type ModelPickerItem } from '@vault/chat-ui';
import { hydrateBoardChoice, hydrateDocChip, hydrateModelRef, hydrateNodeChips, patchActiveBoard, patchDocChip, patchModelRef, patchNodeChips, type ChatContextHolder } from './context-state.js';
import type { ConversationClient, ConversationMeta } from './conversation-client.js';
import { pickFollowConversation } from '@vault/conversation-core';
import type { DocScope } from '../engine/doc-scope.js';
import type { BoardSync } from '../boards/board-sync.js';
import type { PluginSettingsClient } from '../engine/settings-client.js';

/** Resolve the effective board id from the persisted choice + the doc's current boards. */
function resolveEffectiveBoard(boards: BoardSummary[], choice: string | null | undefined): string | undefined {
  return pickEffectiveBoard({ doc: true, board: true, nodes: [], activeBoardId: choice }, boards.map((b) => b.id));
}

function deriveTitle(messages: UIMessage[]): string | undefined {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return undefined;
  const text = firstUser.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join(' ').trim();
  // Cap matches vault-chat web's history.ts deriveTitle (80) so a title derived on either
  // surface is byte-identical — no cross-surface clobber when continuing a shared conversation.
  return text ? text.slice(0, 80) : undefined;
}

/**
 * True while a conversation has no user-meaningful title yet: absent, empty, the engine
 * default ('New chat'), or the web placeholder ('New conversation'). Mirrors vault-chat web's
 * history.ts isPlaceholderTitle so that a real title set on EITHER surface is recognized and
 * never re-derived/re-sent (the engine's metadata-preserving upsert would otherwise clobber a
 * web-set 80-char title with this surface's re-derivation).
 */
function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (title == null || title.trim() === '') return true;
  return title === 'New chat' || title === 'New conversation';
}

export function ChatPane({ client, transport, docScope, boardClient, boardSync, contextHolder, newBoardName, onOpenPreview, searchNodes, resolveNodes, settingsClient, keys, onModelRefChange, generateTitle }: {
  client: ConversationClient;
  transport: ChatTransport<UIMessage>;
  docScope: DocScope;
  boardClient: BoardClient;
  /** Plugin-wide coordination with the Boards panes, so a pin and a pane edit can't drop each other (#287). */
  boardSync?: BoardSync;
  contextHolder: ChatContextHolder;
  newBoardName: () => string;
  onOpenPreview?: (ref: PreviewRef) => void;
  searchNodes: (q: string) => Promise<{ id: string; title: string; type?: string }[]>;
  resolveNodes: (ids: string[]) => Promise<Array<{ id: string; title: string; type: string }>>;
  /** The composer's model-picker data source (Task 8): enabled Settings/Models catalog
   *  entries + the resolved default, availability-flagged from this surface's OWN keys
   *  (never the engine's) — matches the web endpoint's filter/shape. */
  settingsClient: Pick<PluginSettingsClient, 'effective' | 'resolvedDefault'>;
  keys: ProviderKeys;
  /** Notifies the host (chat-view.ts) of the live model-picker selection so the turn
   *  resolver — outside React — can resolve it fresh at send time. Mirrors the contextHolder
   *  lockstep-effect pattern below (activeBoardId/docEnabled/nodes). REQUIRED: an unwired
   *  callback would silently pin every send to the surface default. */
  onModelRefChange: (title: string | null) => void;
  /** Kicks off the async LLM titling flow once per conversation (chat-view.ts owns the
   *  model/relay/usage plumbing). Resolves true when a title (LLM or fallback) was saved. */
  generateTitle: (opts: { conversationId: string; messages: UIMessage[]; fallbackTitle: string | null; saveTitle: (title: string) => Promise<void> }) => Promise<boolean>;
}) {
  const [list, setList] = useState<ConversationMeta[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [conversationId, setConversationId] = useState<string>('');
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  // Follow the active note by default — parity with vault-chat web, whose doc→conversation follow is
  // always on (navigating to a note surfaces its linked conversation already waiting there). Mirrors
  // followBoard's default-on below; off = freeze the current conversation while browsing notes.
  const [followActive, setFollowActive] = useState(true);
  const [currentArchived, setCurrentArchived] = useState(false);
  // Doc node id this (new) conversation should link to once its row exists (on first settle).
  const pendingDocLink = useRef<string | null>(null);
  // Whether the current conversation already has a non-placeholder title (avoid clobbering).
  const titled = useRef(false);
  // The active-doc key we last followed to. Lets the follow path ignore redundant
  // active-leaf-change events (e.g. focusing the chat pane and back) so an
  // in-progress blank conversation isn't wiped on every leaf change.
  const lastFollowedKey = useRef<string | null>(null);

  const [docBoards, setDocBoards] = useState<BoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | undefined>(undefined);
  // The persisted board choice (client_state.activeBoardId): undefined = none yet
  // (default to the doc's most-recent board), null = explicit off, string = that board.
  const [boardChoice, setBoardChoice] = useState<string | null | undefined>(undefined);
  // Whether the board tracks the active note (default on — preserves prior behaviour).
  // When off, the board is frozen on its current selection while you browse notes.
  const [followBoard, setFollowBoard] = useState(true);

  // Persisted ContextState.doc chip for the current conversation (default ON — web parity).
  const [docEnabled, setDocEnabled] = useState(true);
  // Last known active doc path, for the context-bar chip label.
  const [docPath, setDocPath] = useState<string | undefined>(undefined);

  // '@'/'+ add' context-node chips for the current conversation ({id,title,type} for display;
  // ids alone are what persist in the shared client_state and feed the holder).
  const [ctxNodes, setCtxNodes] = useState<Array<{ id: string; title: string; type: string }>>([]);
  // Whether the shared ContextChipsBar's add-node picker popover is open.
  const [addingContext, setAddingContext] = useState(false);

  // Persisted per-conversation model override (client_state.modelRef): undefined = use the
  // surface default (Settings/Chat.md → defaultModel, resolved by chat-view.ts's turn()).
  const [modelRef, setModelRef] = useState<string | undefined>(undefined);
  // The composer's model-picker data source: enabled catalog entries + resolved default title.
  // Static per session (mirrors vault-chat web's mount-only fetchModels) — the catalog itself
  // doesn't vary per conversation, only the selection (modelRef, above) does.
  const [modelCatalog, setModelCatalog] = useState<{ items: ModelPickerItem[]; defaultTitle: string }>({ items: [], defaultTitle: '' });

  // Keep the mutable holder (read by transport.buildContext) in lockstep with React state.
  useEffect(() => { contextHolder.activeBoardId = activeBoardId; }, [contextHolder, activeBoardId]);
  useEffect(() => { contextHolder.docEnabled = docEnabled; }, [contextHolder, docEnabled]);
  useEffect(() => { contextHolder.nodes = ctxNodes.map((n) => n.id); }, [contextHolder, ctxNodes]);
  // Same lockstep discipline for chat-view.ts's selectedModelRef slot (read by turn() at send
  // time, outside React) — fires on mount, on hydration (openConversation/newConversation), and
  // on an explicit pick, so the slot is never stale relative to the conversation on screen.
  useEffect(() => { onModelRefChange(modelRef ?? null); }, [onModelRefChange, modelRef]);

  // Load the model-picker's data source once per session: enabled catalog entries, each flagged
  // with THIS surface's provider availability and whether a rate is known, plus the resolved
  // default's title (mirrors the web's ChatSettingsClient.modelsForPicker()).
  // Pricing uses resolvePricing (entry frontmatter → static @vault/pricing table), the same
  // frontmatter-first chain the engine's usage recorder costs calls with. pricingFor() alone
  // would badge every OpenRouter model "unpriced": the static table only carries the
  // first-party/Fireworks ids, while discover/add-model writes an OpenRouter model's real rates
  // into its Settings/Models note's price_* frontmatter, which lands on the catalog entry.
  useEffect(() => {
    void (async () => {
      const avail = providerAvailability(keys);
      const { catalog } = await settingsClient.effective();
      const items: ModelPickerItem[] = catalog
        .filter((e) => e.enabled)
        .map((e) => ({ title: e.title, provider: e.provider, available: avail[e.provider], unpriced: resolvePricing(e.model, e.pricing) === null }));
      const def = await settingsClient.resolvedDefault(avail);
      setModelCatalog({ items, defaultTitle: def.title });
    })();
  }, [settingsClient, keys]);

  const refreshList = useCallback(async () => {
    setList(await client.list(showArchived));
  }, [client, showArchived]);

  // Guards openConversation's async hydration + the doc-toggle revert (below) against a
  // conversation switch racing an in-flight persist/resolve for the PREVIOUS conversation.
  // Declared before openConversation (its first consumer) rather than down near onToggleDoc.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // Two rapid add/removes each run their own client.get→client.setState RMW round-trip; without
  // serialization the second get can read pre-first-write state and its (later-resolving) setState
  // can clobber the first's write out of order — a lost update. Chain every persist through this
  // ref'd queue so a call's get→setState round-trip fully completes before the next one starts.
  const persistQueue = useRef<Promise<void>>(Promise.resolve());

  const persistNodes = useCallback((cid: string, ids: string[]) => {
    persistQueue.current = persistQueue.current.then(async () => {
      const got = await client.get(cid);
      if (!(await client.setState(cid, patchNodeChips(got?.client_state, ids)))) throw new Error('set-conversation-state failed');
    }).catch((err: unknown) => {
      new Notice(`Context update failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [client]);

  const addContextNode = useCallback((c: { id: string; title: string; type?: string }) => {
    setCtxNodes((cur) => {
      if (cur.some((n) => n.id === c.id)) return cur;
      const next = [...cur, { id: c.id, title: c.title, type: c.type ?? '' }];
      persistNodes(conversationId, next.map((n) => n.id));
      return next;
    });
  }, [conversationId, persistNodes]);

  const removeContextNode = useCallback((id: string) => {
    setCtxNodes((cur) => {
      const next = cur.filter((n) => n.id !== id);
      persistNodes(conversationId, next.map((n) => n.id));
      return next;
    });
  }, [conversationId, persistNodes]);

  const openConversation = useCallback(async (id: string) => {
    pendingDocLink.current = null;
    const got = await client.get(id);
    // Set the guard when the stored title is already real, so a title set on EITHER surface is
    // never re-derived + re-sent (the spec invariant: title sent only on first save, no clobber
    // across surfaces). A placeholder leaves the guard off so the next real turn derives once.
    titled.current = !isPlaceholderTitle(got?.conversation?.title);
    setCurrentArchived(!!got?.conversation?.archived);
    setInitialMessages((got?.messages ?? []) as UIMessage[]);
    setConversationId(id);
    // Hydrate the persisted board choice from the shared client_state (web may have set it).
    // hydrateBoardChoice maps a legacy "board off" conversation onto the explicit "No board" choice.
    setBoardChoice(hydrateBoardChoice(got?.client_state));
    setDocEnabled(hydrateDocChip(got?.client_state));
    setModelRef(hydrateModelRef(got?.client_state));
    // Hydrate node chips: show id-labeled chips immediately, then resolve titles async. The
    // resolve's setCtxNodes is guarded on conversationIdRef so a slow resolution for a
    // conversation the user has since navigated away from can never land on the wrong one.
    const ids = hydrateNodeChips(got?.client_state);
    setCtxNodes(ids.map((nid) => ({ id: nid, title: nid, type: '' }))); // id-labeled until resolved
    if (ids.length) {
      void resolveNodes(ids).then((rows) => {
        if (conversationIdRef.current === id) setCtxNodes(rows);
      });
    }
  }, [client, resolveNodes]);

  const newConversation = useCallback((docNodeId: string | null = null) => {
    pendingDocLink.current = docNodeId;
    titled.current = false;
    setCurrentArchived(false);
    setInitialMessages([]);
    // Fresh conversation: drop the prior conversation's explicit board choice so it starts at the
    // documented default (most-recent linked board). The web self-resets via its re-fetch on switch.
    setBoardChoice(undefined);
    setDocEnabled(true);
    setCtxNodes([]);
    setModelRef(undefined);
    setConversationId(crypto.randomUUID());
  }, []);

  // Initial load: populate the conversation list, then pick the opening conversation. When following
  // an active note, the follow effect below anchors to that note's conversation (parity: it's already
  // there on open), so skip opening here to avoid a double-open. Otherwise open the most-recent, else
  // a fresh one.
  useEffect(() => {
    void (async () => {
      const items = await client.list(false);
      setList(items);
      if (followActive && docScope.currentKey()) return; // follow effect anchors to the active note
      if (items[0]) await openConversation(items[0].id);
      else newConversation();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; the follow effect handles later note/follow changes
  }, [client, openConversation, newConversation]);

  const handleSettled = useCallback(async (messages: UIMessage[]) => {
    const needsTitle = !titled.current;
    // Claim BEFORE the async gap so a fast second turn can't start a second flow;
    // released below only if the flow reports total failure (self-healing next turn).
    if (needsTitle) titled.current = true;
    await client.save({ id: conversationId, messages });
    if (pendingDocLink.current) {
      // The row now exists (save above) so link-conversation won't 404. No archive-prior (pure M:N).
      await client.linkToDoc(conversationId, pendingDocLink.current);
      pendingDocLink.current = null;
    }
    if (needsTitle) {
      const id = conversationId;
      void generateTitle({
        conversationId: id,
        messages,
        fallbackTitle: deriveTitle(messages) ?? null,
        saveTitle: async (title) => { await client.save({ id, title }); },
      }).then((saved) => {
        // Only touch the guard if the user is still on this conversation — after a switch
        // `titled` describes the NEW conversation and must not be reset by this old flow.
        if (!saved && conversationIdRef.current === id) titled.current = false;
        void refreshList();
      });
    }
    void refreshList();
  }, [client, conversationId, generateTitle, refreshList]);

  const archiveCurrent = useCallback(async () => { await client.archive(conversationId); newConversation(); void refreshList(); }, [client, conversationId, newConversation, refreshList]);
  const deleteCurrent = useCallback(async () => {
    await client.remove(conversationId);
    const items = await client.list(showArchived); setList(items);
    if (items[0]) await openConversation(items[0].id); else newConversation();
  }, [client, conversationId, showArchived, openConversation, newConversation]);

  const loadDocBoards = useCallback(async () => {
    const nodeId = await docScope.current();
    setDocBoards(nodeId ? await boardClient.listForDoc(nodeId) : []);
  }, [docScope, boardClient]);

  useEffect(() => { void loadDocBoards(); return docScope.subscribe(() => void loadDocBoards()); }, [docScope, loadDocBoards]);

  // Track the active doc for chat context. Null events (focusing the chat pane / a board /
  // settings fires active-leaf-change with no active file) are ignored so the last known
  // doc survives — same reasoning as lastFollowedKey above.
  const syncActiveDoc = useCallback(async () => {
    const path = docScope.currentKey();
    if (!path) return;
    contextHolder.docPath = path;
    setDocPath(path);
    // Clear the id before the (possibly slow, cache-miss) lookup so an in-flight resolution
    // for the PREVIOUS doc can never be paired with this new path — an undefined id renders
    // as an honest "node id unknown" reference instead of a stale/wrong one.
    contextHolder.docId = undefined;
    const id = (await docScope.current()) ?? undefined;
    // Guard against a later, non-null sync having already taken the holder over while this
    // lookup was in flight (e.g. a fast cache-hit for a different note resolved first). Check
    // the HOLDER's docPath, not docScope.currentKey() — the holder alone survives null
    // chat-pane-focus events, so a resolved id for the still-current doc must land even if the
    // user focused the chat pane mid-await.
    if (contextHolder.docPath === path) contextHolder.docId = id;
  }, [contextHolder, docScope]);
  useEffect(() => { void syncActiveDoc(); return docScope.subscribe(() => void syncActiveDoc()); }, [docScope, syncActiveDoc]);

  const unarchiveCurrent = useCallback(async () => {
    try {
      await client.unarchive(conversationId);
      setCurrentArchived(false);
      void refreshList();
    } catch (err) {
      new Notice(`Unarchive failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, conversationId, refreshList]);

  const attachCurrentToNote = useCallback(async () => {
    try {
      const nodeId = await docScope.current();
      if (!nodeId) { new Notice('Open a note to attach this conversation to'); return; }
      await client.linkToDoc(conversationId, nodeId);
      // Non-atomic two-step: if unarchive throws after linkToDoc succeeds, the conversation is
      // linked-but-archived (invisible to auto-follow until re-unarchived). Recoverable — the
      // ♻/🔗 buttons stay (currentArchived remains true), so the user can retry.
      if (currentArchived) { await client.unarchive(conversationId); setCurrentArchived(false); }
      await loadDocBoards();
      void refreshList();
      new Notice('Attached to this note');
    } catch (err) {
      new Notice(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, conversationId, currentArchived, docScope, loadDocBoards, refreshList]);

  // Resolve the effective board from the persisted choice + the doc's current boards via the
  // shared resolver (it handles default-vs-explicit, so we never re-default over an explicit
  // choice). Two triggers, deliberately split so the follow toggle can gate the doc-driven one:
  //  - boardChoice changes (switching conversations / explicit board pick) ALWAYS re-resolve.
  //  - the active note's boards change re-resolves only while following; when frozen (follow off)
  //    the board is kept as you browse notes.
  useEffect(() => {
    setActiveBoardId(resolveEffectiveBoard(docBoards, boardChoice));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docBoards read fresh; its trigger is the effect below
  }, [boardChoice]);
  useEffect(() => {
    if (!followBoard) return;
    setActiveBoardId(resolveEffectiveBoard(docBoards, boardChoice));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boardChoice handled by the effect above
  }, [followBoard, docBoards]);

  const onSelectBoard = useCallback((id: string | null) => {
    setBoardChoice(id);
    // RMW persist: preserve doc/board/nodes the other surface manages; set only activeBoardId.
    // Chained through the same persistQueue as persistNodes/onToggleDoc so interleaved
    // get→setState round-trips from different context-bar actions can't clobber each
    // other's client_state slice (e.g. a doc-toggle's stale get dropping a just-added node).
    const op = persistQueue.current.then(async () => {
      const got = await client.get(conversationId);
      await client.setState(conversationId, patchActiveBoard(got?.client_state, id));
    });
    // Keep the shared queue alive regardless of this op's outcome (a rejection here must not
    // permanently poison later queued persists); the returned promise still rejects normally
    // so handlePin's own await/catch sees the failure exactly as before.
    persistQueue.current = op.catch(() => {});
    return op;
  }, [client, conversationId]);

  // Pick a model (catalog title) or null = clear back to the surface default. Persisted per
  // conversation via the same RMW persistQueue as onSelectBoard/persistNodes; the lockstep effect
  // above notifies chat-view.ts's slot whenever modelRef changes, so this handler doesn't need to
  // write it directly.
  const onSelectModel = useCallback((title: string | null) => {
    setModelRef(title ?? undefined);
    const op = persistQueue.current.then(async () => {
      const got = await client.get(conversationId);
      await client.setState(conversationId, patchModelRef(got?.client_state, title));
    });
    persistQueue.current = op.catch(() => {});
    return op;
  }, [client, conversationId]);

  // Toggle + persist the shared doc chip. set-conversation-state upserts a missing row,
  // so this is safe on a brand-new (not yet saved) conversation. On failure: revert + Notice.
  // The revert is guarded on the toggle's captured conversation still being active (via
  // conversationIdRef, declared above openConversation) — if the user switched conversations
  // while the persist was in flight, reverting would clobber the new conversation's
  // just-hydrated chip (the persist itself targets the captured id, so stored state is never
  // misdirected).
  const onToggleDoc = useCallback(async () => {
    const next = !docEnabled;
    setDocEnabled(next); // holder synced by the lockstep effect
    // Chained through the same persistQueue as persistNodes/onSelectBoard (see there) so this
    // get→setState round-trip can't interleave with another context-bar persist and clobber it.
    const op = persistQueue.current.then(async () => {
      const got = await client.get(conversationId);
      // setState resolves false (rather than throwing) on an ok:false envelope — treat that as
      // a failure too so an engine-side persist error still hits the revert + Notice below.
      if (!(await client.setState(conversationId, patchDocChip(got?.client_state, next)))) throw new Error('set-conversation-state failed');
    });
    persistQueue.current = op.catch(() => {}); // keep the shared queue alive regardless of this op's outcome
    try {
      await op;
    } catch (err) {
      if (conversationIdRef.current === conversationId) setDocEnabled(!next);
      new Notice(`Doc context toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, conversationId, docEnabled]);

  const handlePin = useCallback(async (spec: VizSpec) => {
    try {
      // A stale id (the board was deleted from the Boards pane) reads as null: start a new board
      // rather than saving under that id, which would quietly recreate it without its links.
      const board = activeBoardId ? await boardClient.get(activeBoardId) : null;
      if (board) {
        // Canonical order first, so the pinned view lands after every existing tab.
        const pin = (cards: BoardCard[]) => addCard(normalizeOrder(cards), spec, () => crypto.randomUUID());
        // A Boards pane showing this board makes the pin as its own edit, so neither whole-list
        // save drops the other's change (#287). With none, read and write the board here: this
        // runs in BoardSync's per-board queue, so a second pin reads the first one's save.
        const direct = async (change: (cards: BoardCard[]) => BoardCard[]) => {
          const current = await boardClient.get(board.id);
          if (!current) throw new Error('the board was deleted');
          await boardClient.save({ id: current.id, name: current.name, cards: change(current.cards) });
        };
        if (boardSync) await boardSync.change(board.id, pin, direct);
        else await direct(pin);
        new Notice(`Pinned to "${board.name}"`);
        return;
      }
      const nodeId = await docScope.current();
      const name = newBoardName();
      const created = await boardClient.save({ name, cards: addCard([], spec, () => crypto.randomUUID()) });
      if (nodeId) await boardClient.linkToDoc(created.id, nodeId);
      // Refresh the doc's boards so the new one is selectable, then persist it as the active
      // choice. Setting activeBoardId directly would be reverted by the resolution effect (which
      // derives it from boardChoice), and the choice must persist so the board survives reopen.
      await loadDocBoards();
      await onSelectBoard(created.id);
      new Notice(`Pinned to new board "${name}"`);
    } catch (err) {
      new Notice(`Pin failed: ${isBoardNotFound(err) ? 'the board was deleted' : err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeBoardId, boardClient, boardSync, docScope, newBoardName, loadDocBoards, onSelectBoard]);

  const openNoteRef = useRef(openNoteConversation);
  openNoteRef.current = openNoteConversation;
  // Anchor to the active note's conversation on mount and whenever follow is (re-)enabled, then track
  // later note changes — mirrors the board-follow effect's immediate resolve + subscribe above.
  useEffect(() => {
    if (!followActive) return;
    void openNoteRef.current({ force: true });
    return docScope.subscribe(() => { void openNoteRef.current(); });
  }, [followActive, docScope]);

  return (
    <div className="vc-pane">
      <ConversationSwitcher
        list={list}
        currentId={conversationId}
        showArchived={showArchived}
        followActive={followActive}
        onSelect={openConversation}
        onNew={() => newConversation()}
        archived={currentArchived}
        onArchive={archiveCurrent}
        onUnarchive={() => void unarchiveCurrent()}
        onAttachToNote={() => void attachCurrentToNote()}
        onDelete={deleteCurrent}
        onToggleArchived={() => setShowArchived((v) => { const nv = !v; void client.list(nv).then(setList); return nv; })}
        onOpenNoteConversation={() => void openNoteConversation({ force: true })}
        onToggleFollow={() => setFollowActive((v) => !v)}
      />
      <ContextChipsBar
        docPath={docPath ?? null}
        chips={{ doc: docEnabled, board: true, nodes: ctxNodes, activeBoardId: boardChoice }}
        boards={docBoards.map((b) => ({ id: b.id, name: b.name }))}
        activeBoardId={activeBoardId}
        adding={addingContext}
        searchNodes={searchNodes}
        onToggleDoc={() => void onToggleDoc()}
        onSelectBoard={(id) => void onSelectBoard(id)}
        onRemoveNode={removeContextNode}
        onAddClick={() => setAddingContext((v) => !v)}
        onAddPick={addContextNode}
        onAddClose={() => setAddingContext(false)}
        followBoard={followBoard}
        onToggleFollowBoard={() => setFollowBoard((v) => !v)}
      />
      <Chat
        key={conversationId}
        transport={transport}
        conversationId={conversationId}
        initialMessages={initialMessages}
        onSettled={(m) => void handleSettled(m)}
        onOpenPreview={onOpenPreview}
        onPinToBoard={(spec) => void handlePin(spec)}
        searchNodes={searchNodes}
        onAddNodeChip={addContextNode}
        modelPicker={{ items: modelCatalog.items, selected: modelRef ?? null, defaultTitle: modelCatalog.defaultTitle, onSelect: (title) => void onSelectModel(title) }}
      />
    </div>
  );

  // --- doc-anchoring: resolve the active doc and show its conversation. With a
  //     linked conversation, open the most-recent one; otherwise reset to a fresh
  //     blank conversation for that note (claims the doc on first settle when the
  //     note is an engine node, stays unowned when it isn't). `force` bypasses the
  //     same-note dedup for the explicit "open this note's conversation" action. ---
  async function openNoteConversation({ force = false }: { force?: boolean } = {}) {
    const key = docScope.currentKey();
    // No active note at all (focus on the chat pane / a board / settings) — keep
    // the current conversation rather than blanking it.
    if (!key) return;
    // Same note as last time — refresh only on an actual note change.
    if (!force && key === lastFollowedKey.current) return;
    lastFollowedKey.current = key;
    const nodeId = await docScope.current();
    const linked = nodeId ? await client.listForDoc(nodeId) : [];
    // Shared selection rule with vault-chat web: most-recent active linked conversation.
    const followId = pickFollowConversation(linked);
    if (followId) await openConversation(followId);
    else newConversation(nodeId);
  }
}
