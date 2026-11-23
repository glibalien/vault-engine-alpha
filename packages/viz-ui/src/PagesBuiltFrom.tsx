import { useState, type ReactNode } from 'react';
import type { ProvenanceImpactOutput } from '@vault/query-core';
import { useSourceImpactReview } from './use-source-impact-review.js';
import { Icon } from './icon.js';
import {
  comparisonLabels,
  dependencyCoverageLabels,
  inputRoleLabels,
  type InspectorTarget,
  type ReadState,
} from './provenance-inspector.js';
import { friendlyTime, plural } from './provenance-sources.js';
import type {
  ImpactCandidate,
  ImpactReviewPage,
} from './use-source-impact-review.js';

export type PagesBuiltFromProps = {
  target: InspectorTarget;
  connectionKey: number;
  hasInspectionTool: boolean;
  hasImpactTool: boolean;
  /** Open a note in the editor. */
  onOpen: (nodeId: string) => void;
  /** Show the build a page was built from, with this note's inputs highlighted. */
  onReview?: (candidate: ImpactCandidate, namespace: string | null) => void;
};

type Comparison = ProvenanceImpactOutput['inputs'][number]['comparison'];

/** How the note's own state compares with the version a page was built from. */
const noteStatusLabels: Record<Comparison, string> = {
  changed: 'note changed since',
  missing: 'note deleted since',
  unavailable: "can't check",
  comparison_unknown: "can't check",
  expected_self_transition: 'rewritten in that build',
  unchanged: 'unchanged',
};
const statusRank: Record<Comparison, number> = {
  unchanged: 0,
  expected_self_transition: 1,
  unavailable: 2,
  comparison_unknown: 2,
  changed: 3,
  missing: 4,
};
const listVerbs: Record<string, string> = {
  source_material: 'read',
  engine_projection: 'listed',
};
const otherUses: Record<string, string> = {
  generated_context: 'used it as wiki context',
  human_correction: 'used it as a correction',
};

function noteStatus(impact: ProvenanceImpactOutput): Comparison {
  return impact.inputs.reduce<Comparison>(
    (worst, input) =>
      statusRank[input.comparison] > statusRank[worst] ? input.comparison : worst,
    'unchanged',
  );
}

/** "read and listed this note · used it as a correction" */
function usesText(impact: ProvenanceImpactOutput): string | null {
  const roles = [...new Set(impact.inputs.map((input) => input.role ?? ''))];
  const verbs = roles.map((role) => listVerbs[role]).filter(Boolean);
  const parts = [
    ...(verbs.length > 0 ? [`${verbs.join(' and ')} this note`] : []),
    ...roles.map((role) => otherUses[role]).filter(Boolean),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
}

function pageTitle(candidate: ImpactCandidate): string {
  return (
    candidate.target.title ??
    candidate.target.path ??
    (candidate.impact.currentness === 'missing' ? 'A deleted page' : 'Untitled page')
  );
}

function PageNotice({ page }: { page: ReadState<ImpactReviewPage> }) {
  return (
    <>
      {page.loading && <p role="status" className="vp-hint">Checking Curator's build records…</p>}
      {page.error && <p role="alert">{page.error}</p>}
      {page.warnings.map((warning, index) => (
        <p key={index} role="status" className="vp-hint">
          {warning.message}
        </p>
      ))}
      {page.data?.hydrationError && (
        <p role="alert" className="vp-hint">
          Page titles are unavailable: {page.data.hydrationError}. You can
          still open each build's record.
        </p>
      )}
    </>
  );
}

function TechnicalDetails({
  impacts,
  page,
}: {
  impacts: { impact: ProvenanceImpactOutput; page: ReadState<ImpactReviewPage> | null }[];
  page?: ReadState<ImpactReviewPage>;
}) {
  return (
    <details className="vp-technical">
      <summary>Technical details</summary>
      {impacts.map(({ impact, page: own }) => {
        const source = own ?? page ?? null;
        return (
          <div key={impact.receipt.output_revision_id}>
            <p>Page ID: {impact.receipt.output_node_id}</p>
            <p>Version ID: {impact.receipt.output_revision_id}</p>
            <p>Created {impact.receipt.committed_at}</p>
            {source && <p>Review snapshot {source.data?.impact.as_of}</p>}
            {source && <p>Read {source.readAt}</p>}
            {impact.inputs.map((input) => (
              <div key={input.input_id}>
                <p>{comparisonLabels[input.comparison]}</p>
                <p>Role: {input.role ? inputRoleLabels[input.role] : 'Unknown'}</p>
                <p>Reason: {input.reason}</p>
              </div>
            ))}
            {impact.inputs_truncated && (
              <p>Some matching source records were left out of this result.</p>
            )}
            <p>{dependencyCoverageLabels[impact.dependency_coverage]}</p>
          </div>
        );
      })}
    </details>
  );
}

function PageRow({
  candidate,
  page,
  onReview,
  onOpen,
}: {
  candidate: ImpactCandidate;
  page: ReadState<ImpactReviewPage>;
  onReview: (() => void) | null;
  onOpen: (() => void) | null;
}) {
  const { impact } = candidate;
  const title = pageTitle(candidate);
  const status = noteStatus(impact);
  const uses = usesText(impact);
  return (
    <li className="vp-row vp-row--attention">
      <div className="vp-row-head">
        {onOpen ? (
          <button className="vp-link" title="Open this page" onClick={onOpen}>
            {title}
          </button>
        ) : (
          <span className="vp-row-title">{title}</span>
        )}
        {status !== 'unchanged' && (
          <span className={`vp-chip vp-chip--${status === 'missing' ? 'missing' : status === 'changed' ? 'changed' : 'unknown'}`}>
            {noteStatusLabels[status]}
          </span>
        )}
      </div>
      <div className="vp-row-meta">
        Built {friendlyTime(impact.receipt.committed_at)}
        {uses ? ` · ${uses}` : ''}
        {onReview && (
          <>
            {' · '}
            <button className="vp-text-toggle" onClick={onReview}>
              See what it was built from
            </button>
          </>
        )}
      </div>
      {status === 'expected_self_transition' && (
        <p className="vp-hint">
          This captured source changed as part of publishing this generation.
        </p>
      )}
      <TechnicalDetails impacts={[{ impact, page }]} />
    </li>
  );
}

/** Older builds grouped by page: nightly builds of one page are one row, not thirty. */
function OlderBuildRow({
  builds,
  onReview,
  onOpen,
}: {
  builds: { candidate: ImpactCandidate; page: ReadState<ImpactReviewPage> }[];
  onReview: ((candidate: ImpactCandidate) => void) | null;
  onOpen: (() => void) | null;
}) {
  const sorted = [...builds].sort((a, b) =>
    b.candidate.impact.receipt.committed_at.localeCompare(
      a.candidate.impact.receipt.committed_at,
    ),
  );
  const newest = sorted[0]!.candidate;
  const oldest = sorted.at(-1)!.candidate;
  const title = pageTitle(newest);
  const deleted = newest.impact.currentness === 'missing';
  return (
    <li className="vp-row">
      <div className="vp-row-head">
        {onOpen && !deleted ? (
          <button className="vp-link" title="Open this page" onClick={onOpen}>
            {title}
          </button>
        ) : (
          <span className="vp-row-title">{title}</span>
        )}
        {deleted && <span className="vp-chip">page deleted</span>}
      </div>
      <div className="vp-row-meta">
        {sorted.length === 1
          ? `Build from ${friendlyTime(newest.impact.receipt.committed_at)}`
          : `${plural(sorted.length, 'build')}, ${friendlyTime(oldest.impact.receipt.committed_at)} to ${friendlyTime(newest.impact.receipt.committed_at)}`}
        {onReview && (
          <>
            {' · '}
            <button className="vp-text-toggle" onClick={() => onReview(newest)}>
              {sorted.length === 1 ? 'See what it was built from' : 'See the newest one'}
            </button>
          </>
        )}
      </div>
      <TechnicalDetails
        impacts={sorted.map(({ candidate, page }) => ({ impact: candidate.impact, page }))}
      />
    </li>
  );
}

function Callout({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'neutral';
  children: ReactNode;
}) {
  return <div className={`vp-callout vp-callout--${tone}`} role="status">{children}</div>;
}

/** Wiki pages built from an earlier version of this note: the reverse question to "what was this page
 *  built from". A section of the wiki panel (#545); it reads only when it is open. */
export function PagesBuiltFrom(props: PagesBuiltFromProps) {
  const state = useSourceImpactReview(props);
  const [olderOpen, setOlderOpen] = useState(false);

  const withPages = (pages: ReadState<ImpactReviewPage>[]) =>
    pages.flatMap((page) =>
      (page.data?.impact.outputs ?? []).map((impact) => {
        const data = page.data!;
        const candidate: ImpactCandidate = {
          impact,
          target: data.targets[impact.receipt.output_node_id] ?? {
            nodeId: impact.receipt.output_node_id,
            title: null,
            path: null,
          },
          checkedAt: page.readAt ?? data.impact.as_of,
        };
        return { candidate, page };
      }),
    );
  const current = withPages(state.currentPages);
  const older = withPages(state.historicalPages);
  const olderByPage = new Map<string, typeof older>();
  for (const build of older) {
    const key = build.candidate.impact.receipt.output_node_id;
    olderByPage.set(key, [...(olderByPage.get(key) ?? []), build]);
  }

  const currentMore = state.currentPages.at(-1)?.data?.impact.next_cursor;
  const historicalMore = state.historicalPages.at(-1)?.data?.impact.next_cursor;
  const currentBusy = state.currentPages.some((page) => page.loading);
  const historicalBusy = state.historicalPages.some((page) => page.loading);
  const currentDone =
    state.currentPages.length > 0 &&
    !currentMore &&
    !currentBusy &&
    !state.currentPages.some((page) => page.error);
  const historicalDone =
    state.historicalPages.length > 0 &&
    !historicalMore &&
    !historicalBusy &&
    !state.historicalPages.some((page) => page.error);
  const checkedUses = state.currentPages.reduce(
    (sum, page) => sum + (page.data?.impact.comparisons ?? 0),
    0,
  );
  const review = props.onReview
    ? (candidate: ImpactCandidate) => props.onReview!(candidate, state.namespace)
    : null;

  let callout: ReactNode = null;
  if (current.length > 0)
    callout = (
      <Callout tone="warn">
        <p>
          <strong>
            {plural(current.length, 'wiki page is', 'wiki pages are')} behind on
            this note{currentMore ? ' so far' : ''}
          </strong>
        </p>
        <p>
          {current.length === 1 ? 'It was' : 'They were'} built from an earlier
          version, and will reflect your edits after{' '}
          {current.length === 1 ? 'its' : 'their'} next build.
        </p>
      </Callout>
    );
  else if (currentDone)
    callout =
      checkedUses === 0 ? (
        <Callout tone="neutral">
          <p>
            <strong>No recorded build has used this note.</strong>
          </p>
          <p>Curator hasn't read or listed it for any wiki page since build records began.</p>
        </Callout>
      ) : (
        <Callout tone="ok">
          <p>
            <strong>No wiki page is behind on this note.</strong>
          </p>
          <p>
            Every current page that used it was built from its latest version.
            Checked {plural(checkedUses, 'recorded use')}.
          </p>
        </Callout>
      );
  else if (!currentBusy && currentMore && current.length === 0)
    callout = (
      <Callout tone="neutral">
        <p>Nothing found yet. There are more build records to check.</p>
      </Callout>
    );

  if (state.capability === 'loading')
    return <p role="status" className="vp-hint">Checking what Engine supports…</p>;
  if (state.capability === 'unsupported')
    return <p className="vp-hint">This Engine version can't look up the pages built from a note.</p>;
  if (state.capability === 'error')
    return <p role="alert" className="vp-hint">{state.capabilityError}</p>;

  return (
    <div className="vp-impact">
      {callout}
      {state.currentPages.map((page, index) => (
        <div key={index}>
          <PageNotice page={page} />
          {page.error && (
            <button onClick={() => state.retryCurrentPage(index)}>Try again</button>
          )}
        </div>
      ))}
      {current.length > 0 && (
        <ul className="vp-rows">
          {current.map(({ candidate, page }) => (
            <PageRow
              key={candidate.impact.receipt.output_revision_id}
              candidate={candidate}
              page={page}
              onReview={review ? () => review(candidate) : null}
              onOpen={
                candidate.impact.currentness === 'missing'
                  ? null
                  : () => props.onOpen(candidate.target.nodeId)
              }
            />
          ))}
        </ul>
      )}
      {currentMore && (
        <div className="vp-actions">
          <button disabled={currentBusy} onClick={state.loadMoreCurrent}>
            Keep checking
          </button>
        </div>
      )}
      <details
        className="vp-group"
        open={olderOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setOlderOpen(open);
          if (open) state.loadHistorical();
        }}
      >
        <summary>
          <Icon name="b-chevron-down" className="vp-chev" />
          <span>Older builds that used it</span>
          {olderByPage.size > 0 && <span className="vp-count">{olderByPage.size}</span>}
        </summary>
        <p className="vp-hint">
          Builds that are no longer what's on the page (replaced, edited or
          deleted) and used an earlier version of this note.
        </p>
        {state.historicalPages.map((page, index) => (
          <div key={index}>
            <PageNotice page={page} />
            {page.error && (
              <button onClick={() => state.retryHistoricalPage(index)}>Try again</button>
            )}
          </div>
        ))}
        {olderByPage.size > 0 && (
          <ul className="vp-rows">
            {[...olderByPage.entries()].map(([nodeId, builds]) => (
              <OlderBuildRow
                key={nodeId}
                builds={builds}
                onReview={review}
                onOpen={() => props.onOpen(nodeId)}
              />
            ))}
          </ul>
        )}
        {historicalMore && (
          <div className="vp-actions">
            <button disabled={historicalBusy} onClick={state.loadMoreHistorical}>
              Show more older builds
            </button>
          </div>
        )}
        {historicalDone && older.length === 0 && (
          <p className="vp-hint">No older build used an earlier version of this note.</p>
        )}
      </details>
      {state.currentPages.length > 0 && (
        <p className="vp-hint">
          Only builds with saved records are checked. Being built from an
          earlier version doesn't mean a page is wrong.
        </p>
      )}
    </div>
  );
}
