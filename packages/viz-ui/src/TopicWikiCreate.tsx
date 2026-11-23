import { useEffect, useRef } from 'react';
import type { TopicProposal, TopicWikiMatch } from '@vault/query-core';
import { useTopicWikiCreate, type TopicWikiCreateProps, type TopicWikiEnd, type TopicWikiTarget } from './use-topic-wiki-create.js';
import { budgetLine, plainWikiDetail, usd, waitingInLane } from './wiki-build-text.js';

/** Scheduled sweeps refresh a wiki only while Curator's wikiReconciliationMode is live (its default is
 *  off), so resuming one promises no build without saying so (#544). */
const WHILE_SWEEPS = 'while scheduled wiki sweeps are on (Curator status shows wiki_reconciliation_mode)';

const CONFIDENCE: Record<TopicProposal['confidence'], string> = {
  high: 'Curator is fairly sure this is what the note is about.',
  medium: 'Curator is somewhat sure this is what the note is about.',
  low: 'Curator isn\'t sure this is what the note is about, so check it.',
};

/** What the proposal found already in place. */
function matchText(match: TopicWikiMatch, canAdd: boolean): string {
  const paused = match.paused ? ' (paused)' : '';
  if (match.kind === 'project')
    return `This looks like the subject of the project wiki "${match.title}"${paused}. A project wiki is built from its project's notes, so this note can't be added to it. You can still create a separate topic wiki.`;
  if (match.note_is_source) return `This note is already a source of the topic wiki "${match.title}"${paused}.`;
  if (canAdd) return `This looks like the subject of the topic wiki "${match.title}"${paused}. You can add this note to it as a source, or create a new wiki anyway.`;
  return `This looks like the subject of the topic wiki "${match.title}"${paused}, which already has the most sources a wiki can take (20), so this note can't be added to it.`;
}

function outcome(ended: TopicWikiEnd | null, target: TopicWikiTarget | null): string {
  if (!ended || !target) return '';
  const { title } = target;
  if (ended.kind === 'unchanged') return `Nothing changed: this note is already a source of "${title}".`;
  const { run } = ended;
  if (!run) return 'It finished with no build on record. Curator status may say more.';
  const create = target.action === 'create';
  const cost = run.cost_usd === null ? '' : `, for an estimated ${usd(run.cost_usd)}`;
  const spent = run.cost_usd ? ` It spent an estimated ${usd(run.cost_usd)} first.` : '';
  // A paused wiki doesn't build again by itself: nothing retries a failed build. A rebuild on request does.
  const after = create
    ? ' The wiki is registered and paused, so it won\'t try again by itself. To build it, ask Vault Chat to rebuild it; it stays paused. '
      + `Resuming it lets the nightly sweep build it only ${WHILE_SWEEPS}.`
    : ` This note is a source of "${title}" now, but the wiki still shows its last build.`;
  const what = create ? 'first build' : 'rebuild';
  switch (run.outcome) {
    case 'written':
      return create
        ? `The wiki "${title}" was built${cost}. It's paused now, so it changes only when you add a note to it or rebuild it on request. `
          + `Resumed, the nightly sweep also refreshes it, but only ${WHILE_SWEEPS}.`
        : `This note was added to "${title}", and the wiki was rebuilt${cost}.`;
    case 'skipped_budget': return `Today's Curator budget is spent, so the ${what} didn't run.${spent}${after}`;
    case 'error': return `The ${what} failed${run.error ? `: ${plainWikiDetail(title, run.error).replace(/\.$/, '')}.` : '.'}${spent}${after}`;
    default: return `The ${what} finished without writing the wiki.${spent}${after}`;
  }
}

export function TopicWikiCreate(props: TopicWikiCreateProps) {
  const state = useTopicWikiCreate(props);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const { phase, noteTitle, model, proposal, target, status, ended, blocked, formError, error, nameProblem } = state;
  const match = proposal?.existing_wiki ?? null;
  const canAdd = !!proposal?.next.add_source;
  const editing = phase === 'proposal';
  const built = phase === 'finished' && ended?.kind === 'run' && ended.run?.outcome === 'written';
  const budget = status ? budgetLine(status) : null;
  return <section className="vp-home-refresh" aria-label="Create topic wiki">
    <h3 ref={heading} tabIndex={-1}>Create a topic wiki from this note</h3>
    <p><strong>{noteTitle}</strong></p>
    <p>Curator suggests the subject this note is about. Once you accept or edit it, Curator builds a wiki on that subject
      from your vault and the web, with this note as a source. The wiki builds once, then stays paused. Your notes aren't changed.</p>
    {phase === 'checking' && <p role="status">Checking…</p>}
    {error && <p role="alert">{error}</p>}
    {phase === 'blocked' && blocked && <p role="alert">{blocked}</p>}
    {phase === 'ready' && <div>
      <p>This check was free. Suggesting a topic makes one small paid call ({model}) and creates nothing.
        It counts against today's Curator budget.{budget ? ` ${budget}` : ''}</p>
      <button onClick={() => void state.suggest()}>Suggest a topic (paid)</button>
    </div>}
    {phase === 'proposing' && <p role="status">Suggesting a topic…</p>}
    {proposal && (editing || phase === 'starting') && <div>
      <p>Accept the suggested topic or edit it. Nothing is created until you confirm. {CONFIDENCE[proposal.confidence]}</p>
      <label className="vp-topic-field">Topic
        <input type="text" value={state.topic} disabled={!editing} onChange={e => state.setTopic(e.target.value)} />
      </label>
      <label className="vp-topic-field">Brief
        <textarea rows={3} value={state.brief} disabled={!editing} onChange={e => state.setBrief(e.target.value)} />
      </label>
      {proposal.alternatives.length > 0 && <div>
        <p>Other topics it could be:</p>
        <ul className="vp-topic-alternatives">
          {proposal.alternatives.map(alternative => <li key={alternative.topic}>
            <button disabled={!editing} onClick={() => state.pick(alternative)}>{alternative.topic}</button>
            {alternative.brief && <span> {alternative.brief}</span>}
          </li>)}
        </ul>
      </div>}
      {match && <p>{matchText(match, canAdd)}</p>}
      {formError && <p role="alert">{formError}</p>}
      {nameProblem && <p>{nameProblem}</p>}
      <p>Creating it adds a topic note and the wiki's pages, at no cost. Its first build then runs once, with web research,
        which is paid and counts against today's Curator budget.{budget ? ` ${budget}` : ''}
        {canAdd ? ` Adding this note to "${match!.title}" instead rebuilds that wiki once, which is paid too.` : ''}</p>
      <div className="vp-actions">
        {canAdd && <button disabled={!editing} onClick={() => void state.confirm('add')}>Add this note to "{match!.title}" (paid)</button>}
        <button disabled={!editing || nameProblem !== null} onClick={() => void state.confirm('create')}>
          {canAdd ? 'Create a new wiki anyway (paid)' : 'Create topic wiki (paid)'}
        </button>
      </div>
    </div>}
    {phase === 'starting' && <p role="status">Starting…</p>}
    {phase === 'running' && <p role="status">{waitingInLane(status, target!.title)
      ? 'Queued: it starts when the curation ahead of it finishes.'
      : status?.in_progress
        ? `${target!.action === 'create' ? 'Building' : 'Rebuilding'} "${target!.title}". With web research this usually takes a few minutes.`
        : 'Queued. The build usually takes a few minutes.'}</p>}
    {(phase === 'unconfirmed' || (phase === 'running' && error)) && <button onClick={() => void state.retryStatus()}>Check status now</button>}
    {phase === 'finished' && <div role="status">
      <p>{outcome(ended, target)}</p>
      {built && props.onOpenWiki && <div className="vp-actions"><button onClick={() => props.onOpenWiki!(target!.title)}>Open the wiki</button></div>}
    </div>}
    <p>Closing this doesn't stop a build that has already started.</p>
    <button onClick={props.onClose}>Close</button>
  </section>;
}
