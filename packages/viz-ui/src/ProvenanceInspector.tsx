import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DossierApi, ProvenanceInputMetadata, WikiControlApi } from '@vault/query-core';
import { useProvenanceInspector, type DossierKind, type FindWiki, type NoteKind } from './use-provenance-inspector.js';
import { useWikiStatus, wikiState, WikiSection, type RowState } from './WikiSection.js';
import { DossierSection, dossierState, useDossierNews, useDossierStatus } from './DossierSection.js';
import { shortDay } from './wiki-build-text.js';
import { PagesBuiltFrom } from './PagesBuiltFrom.js';
import type { ImpactCandidate } from './use-source-impact-review.js';
import { Icon, type IconName } from './icon.js';
import {
  currentProvenanceLabels,
  dependencyCoverageLabels,
  type InspectorTarget,
  type ReadState,
} from './provenance-inspector.js';
import {
  diffBuilds,
  friendlyTime,
  groupSources,
  inBuildOrder,
  internalInputLabel,
  linesMentioning,
  memoryText,
  plural,
  readsSource,
  sourceStatusLabels,
  sourceUse,
  sourceUseLabels,
  sourceUseOrigins,
  type BuildDiff,
  type SourceRow,
} from './provenance-sources.js';

export type ProvenanceInspectorProps = {
  onRefreshHome?: (outputRevisionId: string, namespace: string) => void;
  /** Rebuild the whole wiki this page belongs to. */
  onRebuildWiki?: (project: string) => void;
  /** Which registered wiki has a root note, so the panel can show the wiki a note belongs to (#545),
   *  whether or not the page has build records (#425, #544). */
  findWiki?: FindWiki;
  /** The wiki's status, and pausing or resuming it (#545). Without it, the panel shows no wiki controls. */
  wikiApi?: WikiControlApi;
  /** Changed by the host to read the wiki's Curator status again, as after a rebuild dialog closes. */
  statusKey?: number;
  /** Offered on a note that isn't part of a wiki, when the host can start one from it. */
  onCreateProjectWiki?: () => void;
  onCreateTopicWiki?: () => void;
  /** Which notes can have a dossier (#554), by their kinds: the host reads its vault map. */
  dossierKind?: DossierKind;
  /** A dossier's builds and today's budget (#554). Without it, the panel names a dossier but can't show its status. */
  dossierApi?: DossierApi;
  /** Build or rebuild a person's or company's dossier: the host shows build-dossier's free check, then the paid build. */
  onBuildDossier?: (subject: { nodeId: string; title: string }) => void;
  target: InspectorTarget | null;
  targetError: string | null;
  connectionKey: number;
  hasInspectionTool: boolean;
  /** Engine has find-affected-outputs: the panel offers "Pages built from this note". */
  hasImpactTool?: boolean;
  /** Changed by the host to open "Pages built from this note" and bring it into view. */
  focusImpact?: number;
  /** Show the build a page was built from, from "Pages built from this note". */
  onReviewBuild?: (candidate: ImpactCandidate, namespace: string | null) => void;
  /** The note to go back to, after following a page from "Pages built from this note". */
  backTo?: string | null;
  onBack?: () => void;
  /** The host follows the active note unless the panel is pinned. */
  pinned?: boolean;
  onTogglePin?: () => void;
  expectedNamespace?: string;
  preferredOutputId?: string;
  highlightInputIds?: readonly string[];
  onOpenNode: (
    nodeId: string,
    isCurrent?: () => boolean,
  ) => Promise<void>;
};

type Inspector = ReturnType<typeof useProvenanceInspector>;

const omissionLabels: Record<string, string> = {
  note_read_count_cap:
    'Curator reads a limited number of notes per build. Lower-ranked notes were only listed or left out.',
  task_bucket_count_cap: 'Long task lists were shortened.',
  node_field_count_cap: 'Notes with many fields had some fields left out.',
  memory_limit: 'Curator reads a limited number of memories per dossier: rules and preferences first, then the newest. Older ones were left out.',
  source_body_unavailable: 'A note it meant to read in full couldn’t be read, so only its title was shown.',
};

/** The kicker's icon for a dossier's subject, by its kind. */
const kindIcon = (kind: NoteKind): IconName => (kind.kind === 'person' ? 'b-user' : kind.kind === 'company' ? 'b-building' : 'b-file');

function ReadNotice({
  page,
  loadingText = 'Loading…',
}: {
  page: ReadState<unknown>;
  loadingText?: string;
}) {
  return (
    <>
      {page.loading && <p role="status" className="vp-hint">{loadingText}</p>}
      {page.error && (
        <p role="alert" className="vp-hint">
          {page.error}
          {page.stale ? ' — showing the previous details' : ''}
        </p>
      )}
      {page.warnings.map((w, i) => (
        <p key={i} role="status" className="vp-hint">
          {w.message}
        </p>
      ))}
    </>
  );
}

function Group({
  title,
  count,
  hint,
  defaultOpen = false,
  onOpen,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  defaultOpen?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const opened = useRef(false);
  const notifyOpen = (open: boolean) => {
    if (open && !opened.current) {
      opened.current = true;
      onOpen?.();
    }
  };
  useEffect(() => {
    if (defaultOpen) notifyOpen(true);
    // Only the initial default matters; later toggles go through onToggle.
  }, []);
  if (count === 0) return null;
  return (
    <details
      className="vp-group"
      open={defaultOpen || undefined}
      onToggle={(event) => notifyOpen(event.currentTarget.open)}
    >
      <summary>
        <Icon name="b-chevron-down" className="vp-chev" />
        <span>{title}</span> <span className="vp-count">{count}</span>
      </summary>
      {hint && <p className="vp-hint">{hint}</p>}
      {children}
    </details>
  );
}

/** Paged retained text for one input, read through the inspector's text reader. */
function FullText({ state, inputId }: { state: Inspector; inputId: string }) {
  if (state.selectedInputId !== inputId) return null;
  return (
    <div className="vp-excerpt">
      <ReadNotice page={state.text} loadingText="Loading the captured text…" />
      {state.text.data?.segments.map((s, i) => (
        <pre key={i} className="vp-input-text">
          {s.text}
        </pre>
      ))}
      {state.text.data && state.text.data.availability !== 'retained' && (
        <p className="vp-hint">The saved text is {state.text.data.availability}.</p>
      )}
      <div className="vp-actions">
        {state.canPreviousText && (
          <button disabled={state.text.loading} onClick={state.previousText}>
            Previous part
          </button>
        )}
        {state.text.data?.next_cursor && (
          <button disabled={state.text.loading} onClick={state.nextText}>
            Show more
          </button>
        )}
        {state.text.error && (
          <button onClick={() => state.selectInput(inputId)}>Try again</button>
        )}
      </div>
    </div>
  );
}

/** For a source that was only listed: the line(s) of each list that mention it. */
function ListedExcerpts({ state, row }: { state: Inspector; row: SourceRow }) {
  return (
    <div className="vp-excerpt">
      {row.inputs.map((input) => {
        const snippet = state.snippets[input.id];
        const origin = sourceUseOrigins[sourceUse(input.selection)];
        const lines = snippet?.text ? linesMentioning(snippet.text, row.title) : [];
        return (
          <div key={input.id}>
            <p className="vp-hint">{origin ? `In ${origin}:` : 'Saved text:'}</p>
            {snippet?.loading && <p role="status" className="vp-hint">Loading…</p>}
            {snippet?.error && <p role="alert" className="vp-hint">{snippet.error}</p>}
            {snippet?.text != null && (
              <pre className="vp-input-text">
                {lines.length > 0 ? lines.join('\n') : snippet.text}
                {lines.length === 0 && snippet.more ? '\n…' : ''}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SourceRowView({
  row,
  state,
  isNew,
  matched,
  open,
  expanded,
  onToggle,
}: {
  row: SourceRow;
  state: Inspector;
  isNew: boolean;
  matched: boolean;
  open: ((nodeId: string) => void) | null;
  expanded: boolean;
  /** Absent for summary rows that repeat a row listed below. */
  onToggle: (() => void) | null;
}) {
  const snippet = row.kind === 'memory' ? state.snippets[row.primary.id] : undefined;
  const memory = snippet?.text ? memoryText(snippet.text) : null;
  const title =
    row.kind === 'memory'
      ? (memory?.text ??
        (snippet?.error ? `Memory #${row.source?.native_id} (text unavailable)` : `Memory #${row.source?.native_id}`))
      : (row.title ?? row.path ?? 'Untitled source');
  const memoryUse = row.uses.includes('past')
    ? sourceUseLabels.past
    : row.uses.includes('rule') ? sourceUseLabels.rule : memory?.kind ?? 'memory';
  const uses =
    row.kind === 'memory'
      ? [memoryUse, ...(row.fromOwner ? ['from you'] : [])]
      : [
          ...row.uses.map((use) => sourceUseLabels[use]),
          ...(row.truncated ? ['partly'] : []),
        ];
  const readsText = row.uses.some(readsSource);
  const openable =
    open &&
    row.kind === 'note' &&
    row.source &&
    row.status !== 'missing';
  return (
    <li
      className={`vp-row${matched ? ' vp-row--matched' : ''}${row.status === 'changed' || row.status === 'missing' ? ' vp-row--attention' : ''}`}
    >
      <div className="vp-row-head">
        {openable ? (
          <button
            className="vp-link"
            title="Open this note"
            onClick={() => open(row.source!.native_id)}
          >
            {title}
          </button>
        ) : (
          <span className={row.kind === 'memory' ? 'vp-memory' : 'vp-row-title'}>
            {title}
          </span>
        )}
        {isNew && <span className="vp-chip vp-chip--new">New</span>}
        {row.status !== 'unchanged' && (
          <span className={`vp-chip vp-chip--${row.status}`}>
            {sourceStatusLabels[row.status]}
          </span>
        )}
      </div>
      <div className="vp-row-meta">
        {uses.join(' · ')}
        {onToggle && row.kind !== 'memory' && state.outputPages[0]?.data?.output.availability === 'retained' && (
          <>
            {' · '}
            <button className="vp-text-toggle" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? 'Hide captured text' : 'Show captured text'}
            </button>
          </>
        )}
      </div>
      {matched && <p className="vp-hint">The note you came from.</p>}
      {onToggle && expanded &&
        (readsText ? (
          <FullText state={state} inputId={row.primary.id} />
        ) : (
          <ListedExcerpts state={state} row={row} />
        ))}
    </li>
  );
}

function WhatsNew({
  diff,
  since,
}: {
  diff: BuildDiff;
  since: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const nothing =
    diff.addedNotes.length === 0 &&
    diff.removedNotes.length === 0 &&
    diff.addedMemories === 0 &&
    diff.removedMemories === 0;
  const cap = 8;
  const added = showAll ? diff.addedNotes : diff.addedNotes.slice(0, cap);
  return (
    <section aria-label="Changes from the previous build">
      <ul className="vp-diff">
        <li>Since the previous build{since ? ` (${since})` : ''}:</li>
        {nothing && <li>the same notes and memories</li>}
        {diff.addedNotes.length > 0 && (
          <li className="vp-chip vp-chip--new">+{plural(diff.addedNotes.length, 'note')}</li>
        )}
        {diff.removedNotes.length > 0 && (
          <li className="vp-chip">−{plural(diff.removedNotes.length, 'note')}</li>
        )}
        {diff.addedMemories > 0 && (
          <li className="vp-chip vp-chip--new">+{plural(diff.addedMemories, 'memory', 'memories')}</li>
        )}
        {diff.removedMemories > 0 && (
          <li className="vp-chip">−{plural(diff.removedMemories, 'memory', 'memories')}</li>
        )}
      </ul>
      {diff.addedNotes.length > 0 && (
        <p className="vp-hint">
          Newly used: {added.map((n) => n.title).join(' · ')}
          {!showAll && diff.addedNotes.length > cap && (
            <>
              {' '}
              <button className="vp-text-toggle" onClick={() => setShowAll(true)}>
                and {diff.addedNotes.length - cap} more
              </button>
            </>
          )}
        </p>
      )}
      {diff.removedNotes.length > 0 && (
        <p className="vp-hint">No longer used: {diff.removedNotes.map((n) => n.title).join(' · ')}</p>
      )}
    </section>
  );
}

/** A collapsible section, like Backlinks' "Linked mentions": a chevron, a title and a count. */
function Section({
  id,
  title,
  count,
  open,
  onToggle,
  lazy = false,
  children,
}: {
  id: string;
  title: string;
  count?: string | number | null;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
  /** Mount the body only while open, so it reads nothing until asked. */
  lazy?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className="vp-section"
      id={`vp-section-${id}`}
      aria-label={title}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) onToggle(id, next);
      }}
    >
      <summary className="vp-section-head">
        <Icon name="b-chevron-down" className="vp-chev" />
        <span>{title}</span>
        {count != null && count !== '' && <span className="vp-flair">{count}</span>}
      </summary>
      {(!lazy || open) && <div className="vp-section-body">{children}</div>}
    </details>
  );
}

function StatusRow({
  label,
  state,
  action,
  alert = false,
}: {
  label: string;
  state: RowState;
  action?: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="vp-status-row" role="group" aria-label={`${label} status`}>
      <div className="vp-status-label">{label}</div>
      <div className="vp-state">
        <span className={`vp-dot is-${state.dot}`} aria-hidden="true" />
        <span>{state.label}</span>
      </div>
      {action}
      {state.detail && (
        <div className="vp-state-detail" role={alert ? 'alert' : undefined}>
          {state.detail}
        </div>
      )}
    </div>
  );
}

function PaidButton({
  label,
  cta,
  onClick,
}: {
  label: string;
  cta?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`vp-row-action${cta ? ' mod-cta' : ''}`}
      aria-label={`${label} (paid)`}
      title={`${label} Uses Curator's budget; you confirm first.`}
      onClick={onClick}
    >
      <Icon name="b-coins" />
      Rebuild…
    </button>
  );
}

/** This page's state in a word and a sentence. */
function pageState({
  state,
  isLatest,
  committed,
  currentness,
  availability,
  inputsComplete,
  checkedCount,
  attentionCount,
  unknownCount,
  replacedAt,
}: {
  state: Inspector;
  isLatest: boolean;
  committed: string | undefined;
  currentness: 'matches' | 'changed' | 'missing' | 'unknown';
  availability: 'retained' | 'expired' | 'purged';
  inputsComplete: boolean;
  checkedCount: number;
  attentionCount: number;
  unknownCount: number;
  replacedAt: string | null;
}): RowState & { needsYou: boolean } {
  const built = `Built ${friendlyTime(committed)}.`;
  const erased =
    availability !== 'retained'
      ? ` Its saved text was ${availability}, so you can see which sources were used but not what Curator read.`
      : '';
  if (!isLatest)
    return {
      dot: 'paused',
      label: 'Viewing an older build',
      detail: `${built}${replacedAt ? ` Replaced ${friendlyTime(replacedAt)}.` : ''}${erased}`,
      needsYou: false,
    };
  if (currentness === 'missing')
    return { dot: 'error', label: 'Deleted', detail: 'This page has been deleted.', needsYou: false };
  const unknown =
    inputsComplete && unknownCount > 0 ? ` ${plural(unknownCount, 'source')} couldn't be checked.` : '';
  if (currentness === 'changed')
    return {
      dot: 'warn',
      label: 'Edited after this build',
      detail: `Curator's sections were changed by you or another tool. Rebuilding rewrites them.${
        inputsComplete && attentionCount > 0
          ? ` ${plural(attentionCount, 'source has', 'sources have')} also changed.`
          : ''
      }${unknown}${erased}`,
      needsYou: true,
    };
  if (!inputsComplete) {
    if (state.outputPages.some((p) => p.loading))
      return { dot: 'muted', label: 'Checking its sources…', detail: `${built}${erased}`, needsYou: false };
    return {
      dot: 'muted',
      label: checkedCount > 0 ? `Checked ${plural(checkedCount, 'source')} so far` : 'Not checked yet',
      detail: `${built} Load the rest under Sources to check them all.${erased}`,
      needsYou: false,
    };
  }
  if (attentionCount === 0)
    return {
      dot: 'ok',
      label: 'Up to date',
      detail: `${built} None of its ${plural(checkedCount, 'source')} have changed.${unknown}${erased}`,
      needsYou: false,
    };
  return {
    dot: 'warn',
    label: `${plural(attentionCount, 'source')} changed`,
    detail: `${built} This page doesn't reflect ${attentionCount === 1 ? 'it' : 'them'} yet.${unknown}${erased}`,
    needsYou: true,
  };
}

const roleKicker: Record<'home' | 'page', { icon: IconName; text: string }> = {
  home: { icon: 'b-house', text: 'Wiki home' },
  page: { icon: 'b-book-open', text: 'Wiki page' },
};

export function ProvenanceInspector(props: ProvenanceInspectorProps) {
  const state = useProvenanceInspector({
    ...props,
    checkRebuild: !!props.onRefreshHome || !!props.onRebuildWiki,
    findWiki: props.onRebuildWiki ? props.findWiki : undefined,
    dossierKind: props.dossierKind,
  });
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  /** Read the wiki's Curator status again on Check again. */
  const [wikiKey, setWikiKey] = useState(0);
  /** Which sections are open. It outlives a change of note, as Obsidian's own panes do. */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const navigationEpoch = useRef(0);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navigationEpoch.current++;
    setNavigationError(null);
    return () => {
      navigationEpoch.current++;
    };
  }, [props.target?.nodeId, props.connectionKey]);
  const open = async (id: string) => {
    const epoch = ++navigationEpoch.current;
    setNavigationError(null);
    try {
      await props.onOpenNode(id, () => epoch === navigationEpoch.current);
    } catch (error) {
      if (epoch === navigationEpoch.current)
        setNavigationError(
          error instanceof Error ? error.message : 'Cannot open note',
        );
    }
  };
  const isOpen = (id: string, fallback: boolean) => opened[id] ?? fallback;
  const toggle = (id: string, next: boolean) => setOpened((all) => ({ ...all, [id]: next }));
  useEffect(() => {
    if (!props.focusImpact) return;
    setOpened((all) => ({ ...all, impact: true }));
    // Wait for the section to open before bringing it into view.
    const timer = setTimeout(() => {
      rootRef.current?.querySelector('#vp-section-impact')?.scrollIntoView?.({ block: 'start' });
    }, 0);
    return () => clearTimeout(timer);
  }, [props.focusImpact]);

  const wiki = state.wiki;
  const live = useWikiStatus(
    props.wikiApi,
    wiki,
    wikiKey + (props.statusKey ?? 0),
    state.reloadWiki,
  );
  const dossier = state.dossier;
  // A build the panel saw running has ended: read the note again, so a first build's new page shows.
  const dossierLive = useDossierStatus(props.dossierApi, dossier, wikiKey + (props.statusKey ?? 0), () => state.refresh());
  // A dossier dialog closing (the host changes statusKey) may have written a new build: read it all again.
  const showsDossier = useRef(false);
  showsDossier.current = !!dossier;
  useEffect(() => {
    if (props.statusKey && showsDossier.current) state.refresh();
    // Only a change of key matters; the hook object is new on every render.
  }, [props.statusKey]);

  const outputs = state.history.flatMap((p) => p.data?.outputs ?? []);
  const latest = state.history[0]?.data?.outputs[0]?.receipt.output_revision_id;
  const selected = state.outputPages[0]?.data;
  const selectedId = selected?.output.receipt.output_revision_id ?? null;
  const isLatest = !!selectedId && selectedId === latest;
  const inputs: ProvenanceInputMetadata[] = state.outputPages.flatMap(
    (p) => p.data?.inputs ?? [],
  );
  const lastHistory = state.history.at(-1);
  const lastOutput = state.outputPages.at(-1);
  const moreHistory = (
    lastHistory?.loading ? state.history.at(-2) : lastHistory
  )?.data?.next_cursor;
  const moreInputs = (
    lastOutput?.loading ? state.outputPages.at(-2) : lastOutput
  )?.data?.next_cursor;
  const inputsLoading = state.outputPages.some((p) => p.loading);
  const inputsComplete =
    !!selected && !moreInputs && !inputsLoading && !state.outputPages.some((p) => p.error);
  const loading = state.history.some((p) => p.loading) || inputsLoading;

  const groups = groupSources(inputs, props.target?.nodeId ?? null);
  const traceable = [
    ...groups.read,
    ...groups.mentioned,
    ...groups.memories,
    ...groups.past,
    ...groups.corrections,
    ...groups.pages,
  ];
  const attention = traceable.filter(
    (row) => row.status === 'changed' || row.status === 'missing',
  );
  const unknown = traceable.filter((row) => row.status === 'unknown');
  const previous = state.previous.data;
  const diff =
    previous && previous.complete && inputsComplete && selectedId
      ? diffBuilds(inputs, previous.inputs)
      : null;
  const previousOutput = previous
    ? outputs.find((o) => o.receipt.output_revision_id === previous.outputId)
    : undefined;
  const replacedBy = selectedId
    ? outputs.find((o) => o.receipt.replaces_output_revision_id === selectedId)
    : undefined;
  const highlighted = new Set(props.highlightInputIds ?? []);
  const isMatched = (row: SourceRow) => row.inputs.some((i) => highlighted.has(i.id));
  const hasMatch = (rows: SourceRow[]) => rows.some(isMatched);

  // Changed memories are listed up top, so fetch their text without a click.
  const attentionMemoryIds = attention
    .filter((row) => row.kind === 'memory')
    .map((row) => row.primary.id)
    .join('\n');
  useEffect(() => {
    if (attentionMemoryIds) state.loadSnippets(attentionMemoryIds.split('\n'));
    // The ids (per selected build) drive this effect, not the hook object.
  }, [attentionMemoryIds, selectedId]);
  useEffect(() => setExpandedRow(null), [selectedId, props.target?.nodeId]);

  const toggleRow = (row: SourceRow) => {
    if (expandedRow === row.key) {
      setExpandedRow(null);
      if (state.selectedInputId) state.selectInput(null);
      return;
    }
    setExpandedRow(row.key);
    const readsText = row.uses.some(readsSource);
    if (readsText) state.selectInput(row.primary.id);
    else {
      if (state.selectedInputId) state.selectInput(null);
      state.loadSnippets(row.inputs.map((i) => i.id));
    }
  };
  const renderRows = (rows: SourceRow[], expandable = true) => (
    <ul className="vp-rows">
      {rows.map((row) => (
        <SourceRowView
          key={row.key}
          row={row}
          state={state}
          isNew={!!diff?.newKeys.has(row.key) && !row.isTarget}
          matched={isMatched(row)}
          open={
            row.source?.namespace === state.namespace
              ? (id) => void open(id)
              : null
          }
          expanded={expandedRow === row.key}
          onToggle={expandable ? () => toggleRow(row) : null}
        />
      ))}
    </ul>
  );

  const committed = selected?.output.receipt.committed_at;
  // Memories recorded about the subject since the latest build, which it didn't read (#714).
  const readMemories =
    dossier?.role === 'page' && isLatest && inputsComplete
      ? new Set(inputs.flatMap((i) => (i.source?.kind === 'memory' ? [i.source.native_id] : [])))
      : null;
  const news = useDossierNews(dossier, isLatest ? committed ?? null : null, readMemories, wikiKey + (props.statusKey ?? 0));
  const omissionCodes = [...new Set(selected?.omissions.map((o) => o.code) ?? [])];
  const historyLoaded = !!state.history[0]?.data;
  const noBuilds = historyLoaded && outputs.length === 0;
  /** A page of a registered wiki with no build to trace, or the wiki's own root note. */
  const untraced = noBuilds && wiki ? wiki : null;
  /** Not part of a wiki: get-node found no `wiki_for`, and no wiki is registered with this note as root. */
  const plainNote = noBuilds && state.wikiChecked && !wiki && state.wikiPage === false && !state.wikiLookupFailed;
  /** No build record, and no wiki the panel can name. */
  const unknownNote = noBuilds && !wiki && !plainNote && state.wikiChecked;
  const refresh = () => {
    setWikiKey((key) => key + 1);
    state.refresh();
  };
  const ready = !!props.target && state.capability === 'ready';
  const impactAvailable = ready && !!props.hasImpactTool;
  const sectionIds = ['wiki', 'dossier', 'changed', 'sources', 'impact', 'history'];
  const collapseAll = () =>
    setOpened(Object.fromEntries(sectionIds.map((id) => [id, false])));

  // ---- identity ----
  const title =
    props.target?.title ?? props.target?.path ?? props.target?.nodeId ?? 'Wiki panel';
  let kicker: { icon: IconName; text: string } | null = null;
  let crumb: ReactNode = null;
  const kindFlair = wiki && (
    <span className="vp-flair">{wiki.kind === 'project' ? 'Project' : 'Topic'}</span>
  );
  const webFlair = live.status?.kind === 'topic' && live.status.source === 'vault+web' && (
    <span className="vp-flair"><Icon name="b-globe" />Web</span>
  );
  if (dossier?.role === 'page') {
    kicker = { icon: 'b-contact', text: 'Dossier' };
    crumb = (
      <>
        Dossier for{' '}
        <button
          className="vp-crumb-link"
          title="Open the note this dossier is about"
          onClick={() => void open(dossier.subjectId)}
        >
          {dossier.subjectTitle}
        </button>{' '}
        <span className="vp-flair">{dossier.kind.label}</span>
      </>
    );
  } else if (dossier?.role === 'subject') {
    kicker = { icon: kindIcon(dossier.kind), text: dossier.kind.label };
    crumb = dossier.pageId ? (
      <>
        Has a dossier:{' '}
        <button className="vp-crumb-link" title="Open its dossier" onClick={() => void open(dossier.pageId!)}>
          {dossier.pageTitle ?? 'Open it'}
        </button>
      </>
    ) : (
      <>No dossier yet</>
    );
  } else if (wiki?.role === 'page' || wiki?.role === 'home') {
    kicker = roleKicker[wiki.role];
    const linkTo = wiki.role === 'page' ? wiki.homeId : wiki.rootId;
    const name = linkTo ? (
      <button
        className="vp-crumb-link"
        title={wiki.role === 'page' ? 'Open the wiki home' : 'Open the note this wiki is about'}
        onClick={() => void open(linkTo)}
      >
        {wiki.name}
      </button>
    ) : (
      <span>{wiki.name}</span>
    );
    crumb =
      wiki.role === 'page' ? (
        <>Page in {name} wiki {kindFlair} {webFlair}</>
      ) : (
        <>Home of the wiki for {name} {kindFlair} {webFlair}</>
      );
  } else if (wiki?.role === 'root') {
    kicker = { icon: 'b-file', text: wiki.kind === 'project' ? 'Project note' : 'Topic note' };
    crumb = (
      <>
        Has a wiki {kindFlair} {webFlair}
        {wiki.homeId && (
          <button className="vp-crumb-link" onClick={() => void open(wiki.homeId!)}>
            Open its home
          </button>
        )}
      </>
    );
  } else if (selected || outputs.length > 0) {
    kicker = roleKicker.page;
    if (state.rebuildProject) crumb = <>Built by Curator for the {state.rebuildProject} wiki</>;
  } else if (plainNote) {
    kicker = { icon: 'b-file', text: 'Note' };
    crumb = <>Not part of a wiki</>;
  } else if (unknownNote) {
    kicker = { icon: 'b-file', text: 'Note' };
  }

  // ---- status board ----
  const rows: ReactNode[] = [];
  const onRebuildPage =
    isLatest && state.rebuildEligible && props.onRefreshHome && state.namespace
      ? () => props.onRefreshHome!(selectedId!, state.namespace!)
      : null;
  const pageRow = selected
    ? pageState({
        state,
        isLatest,
        committed,
        currentness: selected.output.currentness,
        availability: selected.output.availability,
        inputsComplete,
        checkedCount: traceable.length,
        attentionCount: attention.length,
        unknownCount: unknown.length,
        replacedAt: replacedBy?.receipt.committed_at ?? null,
      })
    : null;
  // A note with no dossier yet whose first build is in flight or failed: its row, not the offer to build.
  const firstBuildState = dossier?.role === 'subject' && !dossier.pageId && props.dossierApi ? dossierState(dossier, dossierLive) : null;
  const firstBuild = firstBuildState && (firstBuildState.dot === 'busy' || firstBuildState.dot === 'error') ? firstBuildState : null;
  if (dossier) {
    // A dossier (#554) has one page, so one row says how it stands: its build, and what Curator knows.
    const onBuild = props.onBuildDossier && props.dossierApi
      ? () => props.onBuildDossier!({ nodeId: dossier.subjectId, title: dossier.subjectTitle })
      : null;
    const unavailable: RowState = {
      dot: 'muted',
      label: 'Status unavailable',
      detail: 'Connect Curator in the plugin settings to see this dossier’s status and rebuild it.',
    };
    if (dossier.role === 'page') {
      const counted = isLatest && inputsComplete && !news.loading && !news.error
        ? { sources: attention.length, memories: news.memories.length, allMemories: news.complete }
        : null;
      const known = dossierState(dossier, dossierLive, counted);
      let row: RowState;
      if (pageRow && !isLatest) row = pageRow;
      else if (!props.dossierApi) row = pageRow ?? unavailable;
      else if (known.dot === 'busy' || known.dot === 'error') row = known;
      else if (pageRow && (pageRow.label === 'Deleted' || pageRow.label === 'Edited after this build')) row = pageRow;
      else if (known.dot === 'warn') row = known;
      else if (pageRow?.dot === 'ok' && counted && news.complete)
        row = { ...pageRow, detail: `${pageRow.detail} Nothing new has been recorded about ${dossier.subjectTitle}.` };
      else row = pageRow ?? known;
      rows.push(
        <StatusRow
          key="dossier"
          label="This dossier"
          state={row}
          alert={row.dot === 'error'}
          action={
            pageRow && !isLatest && latest ? (
              <button className="vp-row-action" onClick={state.selectLatest} aria-label="Show the latest build">
                <Icon name="b-undo" />
                Latest
              </button>
            ) : onBuild && row.dot !== 'busy' ? (
              <PaidButton
                label={row.dot === 'error' ? 'Retry the dossier build…' : 'Rebuild this dossier…'}
                cta={row.dot === 'warn'}
                onClick={onBuild}
              />
            ) : null
          }
        />,
      );
    } else if (firstBuild) {
      // No page yet: a first build in flight, or one that failed, shows here in place of the offer to build.
      rows.push(
        <StatusRow
          key="dossier"
          label="Dossier"
          state={firstBuild}
          alert={firstBuild.dot === 'error'}
          action={onBuild && firstBuild.dot === 'error' ? <PaidButton label="Retry the dossier build…" onClick={onBuild} /> : null}
        />,
      );
    } else if (dossier.pageId) {
      const row = props.dossierApi ? dossierState(dossier, dossierLive) : unavailable;
      rows.push(
        <StatusRow
          key="dossier"
          label="Dossier"
          state={row}
          alert={row.dot === 'error'}
          action={
            onBuild && row.dot !== 'busy' ? (
              <PaidButton
                label={row.dot === 'error' ? 'Retry the dossier build…' : 'Rebuild the dossier…'}
                onClick={onBuild}
              />
            ) : null
          }
        />,
      );
    }
  } else {
    if (selected && pageRow) {
      const page = pageRow;
      rows.push(
        <StatusRow
          key="page"
          label="This page"
          state={page}
          action={
            !isLatest && latest ? (
              <button className="vp-row-action" onClick={state.selectLatest} aria-label="Show the latest build">
                <Icon name="b-undo" />
                Latest
              </button>
            ) : onRebuildPage ? (
              <PaidButton label="Rebuild this page…" cta={page.needsYou} onClick={onRebuildPage} />
            ) : null
          }
        />,
      );
    } else if (untraced && untraced.role !== 'root') {
      rows.push(
        <StatusRow
          key="page"
          label="This page"
          state={
            untraced.kind === 'topic'
              ? {
                  dot: 'paused',
                  label: 'No build of its own',
                  detail: 'Topic wikis rebuild as a whole, so their pages don’t keep separate build records.',
                }
              : {
                  dot: 'muted',
                  label: 'No build record',
                  detail:
                    'The wiki hasn’t been built yet, or this page was written before build records were kept.',
                }
          }
        />,
      );
    } else if (unknownNote) {
      rows.push(
        <StatusRow
          key="page"
          label="This note"
          state={{
            dot: 'muted',
            label: 'No build record',
            detail:
              state.history[0]?.data?.current_provenance === 'unknown_legacy'
                ? 'It is either a regular note or a page written before build records were kept.'
                : currentProvenanceLabels[state.history[0]!.data!.current_provenance],
          }}
        />,
      );
    }
    const onRebuildWiki = props.onRebuildWiki;
    if (wiki && props.wikiApi) {
      const w = wikiState(wiki, live);
      rows.push(
        <StatusRow
          key="wiki"
          label="Wiki"
          state={w}
          alert={w.dot === 'error'}
          action={
            onRebuildWiki && w.dot !== 'busy' ? (
              <PaidButton
                label={w.dot === 'error' ? 'Retry the wiki build…' : 'Rebuild the whole wiki…'}
                onClick={() => onRebuildWiki(wiki.name)}
              />
            ) : null
          }
        />,
      );
    } else if (!props.wikiApi && (wiki || state.wikiPage)) {
      rows.push(
        <StatusRow
          key="wiki"
          label="Wiki"
          state={{
            dot: 'muted',
            label: 'Status unavailable',
            detail: 'Connect Curator in the plugin settings to see this wiki’s status and rebuild it.',
          }}
        />,
      );
    } else if (isLatest && state.rebuildProject && onRebuildWiki && !state.wikiLookupFailed) {
      rows.push(
        <StatusRow
          key="wiki"
          label="Wiki"
          state={{ dot: 'muted', label: state.rebuildProject, detail: 'Its status isn’t available here.' }}
          action={
            <PaidButton
              label="Rebuild the whole wiki…"
              onClick={() => onRebuildWiki(state.rebuildProject!)}
            />
          }
        />,
      );
    }
  }
  const comparedAt = isLatest ? selected?.compared_at ?? null : null;

  return (
    <section className="vp-inspector" aria-label="Wiki panel" ref={rootRef}>
      <div className="vp-nav" role="toolbar" aria-label="Wiki panel actions">
        {props.onTogglePin && (
          <button
            className="vp-icon-button"
            aria-pressed={!!props.pinned}
            aria-label={props.pinned ? 'Pinned to this note' : 'Pin to this note'}
            title={props.pinned ? 'Pinned to this note. Click to follow the active note again.' : 'Pin to this note'}
            onClick={props.onTogglePin}
          >
            <Icon name="b-pin" />
          </button>
        )}
        <button
          className="vp-icon-button"
          aria-label="Check again"
          title="Check again"
          onClick={refresh}
          disabled={state.capability === 'loading' || !props.target}
        >
          <Icon name="b-rotate-cw" />
        </button>
        {impactAvailable && (
          <button
            className="vp-icon-button"
            aria-label="Pages built from this note"
            title="Pages built from this note"
            onClick={() => {
              toggle('impact', true);
              setTimeout(() => rootRef.current?.querySelector('#vp-section-impact')?.scrollIntoView?.({ block: 'start' }), 0);
            }}
          >
            <Icon name="b-layers" />
          </button>
        )}
        <button
          className="vp-icon-button"
          aria-label="Collapse all"
          title="Collapse all"
          onClick={collapseAll}
          disabled={!ready}
        >
          <Icon name="b-collapse-all" />
        </button>
      </div>
      {props.backTo && props.onBack && (
        <button className="vp-back" onClick={props.onBack}>
          <Icon name="b-chevron-left" />
          Back to {props.backTo}
        </button>
      )}
      {props.targetError && <p role="alert">{props.targetError}</p>}
      {navigationError && <p role="alert">{navigationError}</p>}
      {!props.target && !props.targetError && (
        <div className="vp-empty">
          <Icon name="b-book-open" />
          <h3>Open a note to see its wiki</h3>
          <p>
            This panel follows the note you’re viewing. On a wiki page it shows
            whether the page is current, what it was built from, and lets you
            rebuild it.
          </p>
        </div>
      )}
      {props.target && (
        <div className="vp-identity">
          {kicker && (
            <div className="vp-kicker">
              <Icon name={kicker.icon} />
              {kicker.text}
            </div>
          )}
          <h2>
            <button className="vp-title" title="Open this note" onClick={() => void open(props.target!.nodeId)}>
              {title}
            </button>
          </h2>
          {crumb && <div className="vp-crumb">{crumb}</div>}
        </div>
      )}
      {state.capability === 'loading' && props.target && (
        <p role="status" className="vp-hint">Checking what Engine supports…</p>
      )}
      {state.capability === 'unsupported' && (
        <div className="vp-empty">
          <h3>Update Vault Engine to use this panel</h3>
          <p>This Engine version doesn’t keep wiki build records.</p>
        </div>
      )}
      {state.capability === 'error' && (
        <p role="alert">{state.capabilityError}</p>
      )}
      {ready && (
        <>
          {state.history[0] && (
            <ReadNotice page={state.history[0]} loadingText="Loading build history…" />
          )}
          {state.wikiLookupFailed && (
            <p role="alert" className="vp-hint">
              Couldn’t reach Curator to find this note’s wiki. Check the Curator connection, then choose Check again.
            </p>
          )}
          {rows.length > 0 && (
            <div className="vp-status" role="group" aria-label="Status">
              {rows}
              {comparedAt && (
                <div className="vp-status-foot">
                  <Icon name="b-clock" />
                  Checked {friendlyTime(comparedAt)}
                </div>
              )}
            </div>
          )}

          {dossier?.role === 'subject' && !dossier.pageId && !firstBuild && props.onBuildDossier && (
            <div className="vp-card">
              <h3>
                <Icon name="b-contact" />
                Build a dossier
              </h3>
              <p className="vp-hint">
                One page about {dossier.subjectTitle}, written from the memories and notes about them. Each line says
                where it came from and the day it became true. You see what it reads and costs before anything is spent.
              </p>
              <div className="vp-actions">
                <button onClick={() => props.onBuildDossier!({ nodeId: dossier.subjectId, title: dossier.subjectTitle })}>
                  Build dossier…
                </button>
              </div>
            </div>
          )}

          {plainNote && !dossier && (props.onCreateProjectWiki || props.onCreateTopicWiki) && (
            <div className="vp-card">
              <h3>
                <Icon name="b-library" />
                Start a wiki from this note
              </h3>
              <p className="vp-hint">
                {props.onCreateProjectWiki
                  ? 'Curator plans the wiki’s pages and keeps them current. You confirm before anything is spent.'
                  : 'Curator suggests a topic from this note, then builds a wiki from related notes, and from the web if you choose.'}
              </p>
              <div className="vp-actions">
                {props.onCreateProjectWiki && (
                  <button onClick={props.onCreateProjectWiki}>Create project wiki…</button>
                )}
                {props.onCreateTopicWiki && (
                  <button onClick={props.onCreateTopicWiki}>Create topic wiki…</button>
                )}
              </div>
            </div>
          )}

          {wiki && props.wikiApi && (
            <Section id="wiki" title="Wiki" open={isOpen('wiki', true)} onToggle={toggle}>
              <WikiSection wiki={wiki} live={live} onOpenHome={(id) => void open(id)} />
            </Section>
          )}

          {dossier && dossier.pageId && props.dossierApi && (
            <Section id="dossier" title="Dossier" open={isOpen('dossier', true)} onToggle={toggle}>
              <DossierSection
                dossier={dossier}
                live={dossierLive}
                onSetRebuild={state.setDossierRebuild}
                busy={state.dossierRebuildBusy}
                error={state.dossierRebuildError}
                onOpen={(id) => void open(id)}
              />
            </Section>
          )}

          {selected && isLatest && (attention.length > 0 || news.memories.length > 0) && (
            <Section
              id="changed"
              title="Changed since this build"
              count={attention.length + news.memories.length}
              open={isOpen('changed', true)}
              onToggle={toggle}
            >
              {news.memories.length > 0 && (
                <ul className="vp-rows" aria-label="New memories">
                  {news.memories.map((memory) => (
                    <li key={memory.id} className="vp-row vp-row--attention">
                      <div className="vp-row-head">
                        <span className="vp-memory">{memory.content}</span>
                        <span className="vp-chip vp-chip--new">New</span>
                      </div>
                      <div className="vp-row-meta">
                        {[memory.category ?? 'memory', `recorded ${shortDay(memory.created_at)}`].join(' · ')}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {attention.length > 0 && renderRows(attention, false)}
              <p className="vp-hint">
                Behind doesn’t mean wrong. Curator just hasn’t read {dossier ? 'them' : 'the newer versions'} yet.
                {news.memories.length > 0 && dossier && ` New memories are ones recorded about ${dossier.subjectTitle} since this build.`}
              </p>
            </Section>
          )}
          {news.error && selected && isLatest && <p className="vp-hint">{news.error}</p>}

          {selected && (
            <Section
              id="sources"
              title={isLatest ? 'Sources' : 'Sources in this build'}
              count={`${traceable.length}${moreInputs ? '+' : ''}`}
              open={isOpen('sources', true)}
              onToggle={toggle}
            >
              {state.outputPages.map((p, i) => (
                <ReadNotice key={i} page={p} loadingText="Loading sources…" />
              ))}
              <p className="vp-hint">
                What Curator was given for this build. It shows what was read,
                not which sentence came from where.
              </p>
              {diff && (
                <WhatsNew
                  diff={diff}
                  since={previousOutput ? friendlyTime(previousOutput.receipt.committed_at) : null}
                />
              )}
              {state.previous.loading && (
                <p className="vp-hint" role="status">Comparing with the previous build…</p>
              )}
              {state.previous.error && (
                <p className="vp-hint">Couldn’t compare with the previous build: {state.previous.error}</p>
              )}
              {previous && !previous.complete && (
                <p className="vp-hint">
                  The previous build used too many sources to compare here.
                </p>
              )}
              <Group
                title="Read"
                count={groups.read.length}
                hint={
                  dossier
                    ? 'Curator read the text of these notes: the note itself, and the newest meetings and notes that link to it (the beginning of long ones).'
                    : 'Curator read the text of these notes (the beginning of long ones).'
                }
                defaultOpen
              >
                {renderRows(groups.read)}
              </Group>
              <Group
                title="Listed"
                count={groups.mentioned.length}
                hint={
                  dossier
                    ? 'Seen only as a title in a list: the meetings and notes that link to it, its tasks, and the people and companies around it. Their text wasn’t read.'
                    : 'Seen only as a title or a few fields in a list: the timeline, task list or most-active ranking. Their text wasn’t read.'
                }
                defaultOpen={hasMatch(groups.mentioned)}
              >
                {renderRows(groups.mentioned)}
              </Group>
              <Group
                title="Memories"
                count={groups.memories.length}
                hint={
                  inBuildOrder(groups.memories)
                    ? 'Facts and preferences from your memory store, in the order Curator was given them.'
                    : 'Facts and preferences from your memory store, newest first.'
                }
                defaultOpen={hasMatch(groups.memories)}
                onOpen={() => state.loadSnippets(groups.memories.map((row) => row.primary.id))}
              >
                {renderRows(groups.memories)}
              </Group>
              <Group
                title="Past facts"
                count={groups.past.length}
                hint="Memories a newer one contradicted, given to Curator as what used to be true, for the dossier’s History."
                defaultOpen={hasMatch(groups.past)}
                onOpen={() => state.loadSnippets(groups.past.map((row) => row.primary.id))}
              >
                {renderRows(groups.past)}
              </Group>
              <Group
                title="Your corrections"
                count={groups.corrections.length}
                hint="Corrections you gave Curator for this wiki."
                defaultOpen
              >
                {renderRows(groups.corrections)}
              </Group>
              <Group
                title="Wiki context"
                count={groups.pages.length}
                hint="This page’s own previous text and the titles of its sibling pages, so Curator updates rather than starts over."
                defaultOpen={hasMatch(groups.pages)}
              >
                {renderRows(groups.pages)}
              </Group>
              <Group
                title="Instructions & format"
                count={groups.internal.length}
                hint="Instructions, the required format and list headings. They aren’t tied to one note, so they can’t be checked for changes."
              >
                <ul className="vp-rows">
                  {groups.internal.map((input) => (
                    <li key={input.id} className="vp-row">
                      <div className="vp-row-head">
                        <span className="vp-row-title">{internalInputLabel(input.selection)}</span>
                      </div>
                      {selected.output.availability === 'retained' && (
                        <div className="vp-row-meta">
                          <button
                            className="vp-text-toggle"
                            aria-expanded={state.selectedInputId === input.id}
                            onClick={() =>
                              state.selectInput(state.selectedInputId === input.id ? null : input.id)
                            }
                          >
                            {state.selectedInputId === input.id
                              ? 'Hide captured text'
                              : 'Show captured text'}
                          </button>
                        </div>
                      )}
                      <FullText state={state} inputId={input.id} />
                    </li>
                  ))}
                </ul>
              </Group>
              {moreInputs && !inputsLoading && (
                <div className="vp-actions">
                  <button disabled={loading} onClick={state.loadMoreInputs}>
                    {state.outputPages.at(-1)?.error ? 'Retry loading sources' : 'Load more sources'}
                  </button>
                </div>
              )}
              {omissionCodes.map((code) => (
                <p key={code} className="vp-hint">
                  {omissionLabels[code] ?? `Some inputs were left out (${code}).`}
                </p>
              ))}
            </Section>
          )}

          {impactAvailable && props.target && (
            <Section
              id="impact"
              title="Pages built from this note"
              open={isOpen('impact', plainNote || unknownNote || wiki?.role === 'root' || dossier?.role === 'subject')}
              onToggle={toggle}
              lazy
            >
              <PagesBuiltFrom
                target={props.target}
                connectionKey={props.connectionKey}
                hasInspectionTool={props.hasInspectionTool}
                hasImpactTool={!!props.hasImpactTool}
                onOpen={(id) => void open(id)}
                onReview={props.onReviewBuild}
              />
            </Section>
          )}

          {outputs.length > 0 && (
            <Section
              id="history"
              title="History"
              count={`${plural(outputs.length, 'build')}${moreHistory ? '+' : ''}`}
              open={isOpen('history', !isLatest && !!selected)}
              onToggle={toggle}
            >
              <ol className="vp-history" aria-label="Build history">
                {outputs.map((o) => (
                  <li
                    key={o.receipt.output_revision_id}
                    className={o.receipt.output_revision_id === latest ? 'is-latest' : undefined}
                  >
                    <button
                      className="vp-generation"
                      aria-pressed={o.receipt.output_revision_id === state.selectedOutputId}
                      onClick={() => state.selectOutput(o.receipt.output_revision_id)}
                    >
                      <span>{friendlyTime(o.receipt.committed_at)}</span>
                      {o.receipt.output_revision_id === latest && <span className="vp-flair">Latest</span>}
                    </button>
                  </li>
                ))}
              </ol>
              {state.history.slice(1).map((page, i) => (
                <ReadNotice key={i} page={page} loadingText="Loading older builds…" />
              ))}
              {moreHistory && (
                <div className="vp-actions">
                  <button disabled={loading} onClick={state.loadOlder}>
                    {state.history.at(-1)?.error ? 'Retry older builds' : 'Show older builds'}
                  </button>
                </div>
              )}
            </Section>
          )}

          {selected && (
            <div className="vp-section-body">
              <details className="vp-technical">
                <summary>Technical details</summary>
                <p>Version ID: <code>{selected.output.receipt.output_revision_id}</code></p>
                <p>Created {selected.output.receipt.committed_at}</p>
                {selected.compared_at && <p>Sources compared {selected.compared_at}</p>}
                <p>Saved source text: {selected.output.availability}</p>
                <p>Recorded inputs loaded: {inputs.length}</p>
                <p>{dependencyCoverageLabels[selected.dependency_coverage]}</p>
                {omissionCodes.length > 0 && <p>Omissions: {omissionCodes.join(', ')}</p>}
              </details>
            </div>
          )}
        </>
      )}
    </section>
  );
}
