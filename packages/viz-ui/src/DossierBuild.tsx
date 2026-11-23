import { useEffect, useRef, useState } from 'react';
import type { DossierPreview, WikiRebuildStatus } from '@vault/query-core';
import { useDossierBuild, type DossierBuildEnd, type DossierBuildPhase, type DossierBuildProps } from './use-dossier-build.js';
import { Icon } from './icon.js';
import { aheadInLane, usd, waitingInLane } from './wiki-build-text.js';

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A list in words: "a, b and c". */
function words(items: readonly string[]): string {
  return items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}

/** What the build reads, in one sentence. */
function readsLine(p: DossierPreview): string {
  const { memories, memories_shown: shown, past, notes, meetings, read_in_full: full } = p.reads;
  const memoryPart = memories !== null && memories > shown
    ? `${shown.toLocaleString()} of the ${plural(memories, 'memory', 'memories')} about it (rules and preferences first, then the newest)`
    : `${plural(shown, 'memory', 'memories')} about it`;
  const linking = [...(notes > 0 ? [plural(notes, 'note')] : []), ...(meetings > 0 ? [plural(meetings, 'meeting')] : [])];
  const parts = [memoryPart, ...(past > 0 ? [plural(past, 'past fact')] : []),
    ...(linking.length > 0 ? [`the ${words(linking)} that link to it${full > 0 ? `, the newest ${full} in full` : ''}`] : [])];
  return `It reads ${words(parts)}. A line that cites nothing it read is left out.`;
}

function outcome(ended: DossierBuildEnd | null, title: string): string {
  if (!ended) return '';
  if (ended.kind === 'answered') return ended.outcome === 'written' ? `"${title}" was written. ${ended.detail}` : ended.detail || `It ended: ${ended.outcome}.`;
  const { run } = ended;
  if (!run) return 'It finished with no build on record. Curator status may say more.';
  const cost = run.cost_usd === null ? '' : `, for an estimated ${usd(run.cost_usd)}`;
  switch (run.outcome) {
    case 'written': return `"${title}" was written${cost}.`;
    case 'skipped_budget': return 'Today\'s Curator budget is spent, so the build didn\'t run.';
    case 'error': return `The build failed${run.error ? `: ${run.error.replace(/\.$/, '')}.` : '.'}`;
    default: return `It finished without writing the page (${run.outcome}).`;
  }
}

/** The dialog's heading: the question until the build is sent, then what is happening to it (#715: a
 *  question left over a dialog with only Close read as a second, broken confirmation). */
function headingOf(phase: DossierBuildPhase, rebuild: boolean, page: string, title: string, waiting: boolean, written: boolean,
  ended: DossierBuildEnd | null): string {
  switch (phase) {
    case 'running': return waiting ? `“${page}” is queued` : `${rebuild ? 'Rebuilding' : 'Building'} “${page}”`;
    case 'unconfirmed': return 'Did the build start?';
    case 'finished':
      if (written) return `“${page}” is ready`;
      return ended?.kind === 'run' && !ended.run ? `No new build of “${page}” is on record` : `“${page}” wasn’t ${rebuild ? 'rebuilt' : 'written'}`;
    case 'blocked': return rebuild ? `Can’t rebuild “${page}”` : `Can’t build a dossier for ${title}`;
    default: return rebuild ? `Rebuild “${page}”?` : `Build a dossier for ${title}?`;
  }
}

/** Where a build in flight stands, in a sentence. */
function runningLine(status: WikiRebuildStatus | null, page: string): string {
  if (waitingInLane(status, page)) {
    const ahead = aheadInLane(status, page);
    return `Curator is finishing ${ahead ? `“${ahead}”` : 'other work'} first. This build starts after it.`;
  }
  return status?.in_progress
    ? 'Curator is writing it now. This usually takes a minute or two.'
    : 'Sent to Curator. This usually takes a minute or two.';
}

/** What a build changes on the page, from the dry run. */
function rewrites(p: DossierPreview): string[] {
  return [
    p.sections.length > 0 ? words(p.sections) : 'The dossier’s sections',
    'Last contact',
    ...(p.reads.rules > 0 ? ['Rules on what to say'] : []),
    'Its task and related-note lists',
    'One new Log entry',
  ];
}

/** What a nightly-mode choice does, said next to the box. */
function nightlyHint(p: DossierPreview, nightly: boolean, subject: string): string {
  if (nightly && p.rebuild === 'manual') return `Saved on ${subject} as dossier: on-change when the build starts, so the nightly sweep rebuilds it when it falls behind (at most 5 dossiers a night).`;
  if (!nightly && p.rebuild === 'on-change') return `Taken off ${subject} when the build starts: it is then rebuilt only when you ask.`;
  return nightly
    ? 'The nightly sweep rebuilds it when it falls behind, at most 5 dossiers a night, from the daily budget.'
    : 'It is rebuilt only when you ask. The wiki panel shows when it has fallen behind.';
}

/**
 * "Build dossier" (#715): build-dossier's free check, the paid build on confirm, then its status and the
 * page to open. The wiki panel and the Build dossier command show it in a dialog, as the page and wiki
 * rebuilds are; closing it doesn't stop a build that has already started.
 */
export function DossierBuild(props: DossierBuildProps) {
  const state = useDossierBuild(props);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const { phase, title, preview, status, ended, blocked, error } = state;
  const [nightly, setNightly] = useState<boolean | null>(null);
  // The box starts at the note's own mode, once the check has read it.
  useEffect(() => { if (preview) setNightly(n => n ?? preview.rebuild === 'on-change'); }, [preview]);
  const rebuild = preview?.action === 'rebuild';
  const page = preview?.page_title ?? `${title} Dossier`;
  const written = phase === 'finished' && ((ended?.kind === 'run' && ended.run?.outcome === 'written')
    || (ended?.kind === 'answered' && ended.outcome === 'written'));
  const offer = preview && (phase === 'ready' || phase === 'starting') ? preview : null;
  const submitted = phase === 'starting' || phase === 'running' || phase === 'unconfirmed' || phase === 'finished';
  const cap = offer?.cap_usd ?? null;
  const left = offer?.remaining_usd ?? null;
  const share = cap && left !== null ? Math.max(0, Math.min(100, Math.round((left / cap) * 100))) : null;
  const on = nightly ?? preview?.rebuild === 'on-change';
  const waiting = phase === 'running' && waitingInLane(status, page);
  return <section className="vp-dialog" aria-label={rebuild ? 'Rebuild the dossier' : 'Build a dossier'}>
    <h2 ref={heading} tabIndex={-1}>{headingOf(phase, rebuild, page, title, waiting, written, ended)}</h2>
    {!submitted && <p className="vp-lede">
      {rebuild
        ? `Curator rewrites the dossier from what the vault knows about ${title} now. Each line says where it came from and the day it became true.`
        : `Curator writes one page about ${title} from what the vault knows about them. Each line says where it came from and the day it became true. Your notes aren't changed.`}
    </p>}
    {phase === 'checking' && <p role="status" className="vp-hint">Checking…</p>}
    {error && <p role="alert">{error}</p>}
    {phase === 'blocked' && blocked && <p role="alert">{blocked}</p>}
    {offer && <>
      <div className="vp-dialog-boxes">
        <div className="vp-dialog-box">
          <h3>{rebuild ? 'Rewrites' : 'Writes'}</h3>
          <ul>
            {!rebuild && <li>A new page, “{page}”</li>}
            {rewrites(offer).map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div className="vp-dialog-box">
          <h3>Leaves alone</h3>
          <ul>
            {rebuild && <li>Your own text on this page</li>}
            <li>{title} and your other notes</li>
            <li>The memories about {title}</li>
          </ul>
        </div>
      </div>
      <p className="vp-hint">{readsLine(offer)}</p>
      <div className="vp-cost">
        <dl>
          <dt>Cost</dt><dd>{offer.calls > 1 ? `${offer.calls} paid model calls` : '1 paid model call'}</dd>
          {offer.estimated_usd !== null && <>
            <dt>Estimate</dt>
            <dd>about {usd(offer.estimated_usd)}{offer.worst_case_usd !== null ? `, at most ${usd(offer.worst_case_usd)}` : ''}</dd>
          </>}
          <dt>Model</dt><dd><code>{offer.model}</code></dd>
          {cap !== null && left !== null && <><dt>Today’s Curator budget</dt><dd>{usd(left)} of {usd(cap)} left</dd></>}
        </dl>
        {share !== null && <span
          className={`vp-meter${share < 20 ? ' vp-meter--low' : ''}`}
          role="meter"
          aria-label="Today's Curator budget left"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share}
          style={{ display: 'block' }}
        ><span style={{ width: `${share}%` }} /></span>}
        {offer.calls > 1 && <p className="vp-hint">
          The page, then a check of its lines against {title}’s {plural(offer.reads.rules, 'rule')} on what may be said.
        </p>}
      </div>
      {!offer.fits && <p role="alert">{offer.refusal ?? 'It doesn\'t fit what is left of today\'s Curator budget.'}</p>}
      <label className="vp-check">
        <input type="checkbox" checked={on} disabled={phase !== 'ready'} onChange={e => setNightly(e.target.checked)} />
        Rebuild it nightly when it falls behind
      </label>
      <p className="vp-hint">{nightlyHint(offer, on, title)}</p>
      <p className="vp-free"><Icon name="b-circle-check" />This check was free. Nothing has been spent yet.</p>
    </>}
    {phase === 'starting' && <p role="status">Starting…</p>}
    {phase === 'running' && <p role="status" className="vp-lede">{runningLine(status, page)}</p>}
    {phase === 'finished' && <p role="status" className="vp-lede">{outcome(ended, page)}</p>}
    {submitted && phase !== 'finished' && <p className="vp-hint">It runs in Curator, so you can close this. The wiki panel shows how it stands.</p>}
    <div className="vp-dialog-buttons">
      {(phase === 'unconfirmed' || (phase === 'running' && error)) && <button onClick={() => void state.retryStatus()}>Check status now</button>}
      <button onClick={props.onClose}>{offer ? 'Cancel' : 'Close'}</button>
      {offer && <button className="mod-cta" disabled={phase !== 'ready' || !offer.fits} title="Uses Curator's budget"
        onClick={() => void state.confirm(on)}>
        <Icon name="b-coins" />{rebuild ? 'Rebuild dossier' : 'Build dossier'}
      </button>}
      {written && props.onOpenPage && <button className="mod-cta" onClick={() => props.onOpenPage!(page)}>Open the dossier</button>}
    </div>
  </section>;
}
