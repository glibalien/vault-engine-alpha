import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TopicProposal, TopicWikiApi, TopicWikiArgs, TopicWikiMatch, TopicWikiNote, WikiRebuildRun, WikiRebuildStatus,
} from '@vault/query-core';
import { baselineRun, POLL_MS } from './use-wiki-rebuild.js';
import { topicRefusal } from './wiki-build-text.js';

export type TopicWikiCreateProps = {
  api: TopicWikiApi;
  /** The note's file name, shown until Engine names the note. */
  noteTitle: string;
  /** What Engine resolves to the note: its path, so a namesake in another folder can't be taken for it. */
  noteRef: string;
  onClose: () => void;
  /** Open a wiki's home page, "<title> Wiki". */
  onOpenWiki?: (title: string) => void;
};

export type TopicWikiPhase =
  | 'checking'
  /** A check, the suggestion or the Curator says it can't go on. */
  | 'blocked'
  /** The free check passed: suggesting a topic is the paid step offered. */
  | 'ready'
  | 'proposing'
  /** The suggestion is shown to accept or edit. */
  | 'proposal'
  | 'starting'
  /** The build is queued or running. */
  | 'running'
  /** The create request got no clear reply: it may or may not have started. */
  | 'unconfirmed'
  | 'finished';

/** The wiki the panel is building: a new one, or the matched one the note is added to. */
export type TopicWikiTarget = { action: 'create' | 'add'; title: string };

/** How it ended: the build's run (null when none is on record), or no build because nothing changed. */
export type TopicWikiEnd = { kind: 'run'; run: WikiRebuildRun | null } | { kind: 'unchanged' };

/** Refusals that change nothing and that another name fixes: the panel goes back to the proposal. */
const NAME_REFUSALS = new Set(['WIKI_EXISTS', 'WIKI_IS_A_PROJECT', 'TOPIC_IS_A_WIKI_PAGE']);
const NO_SIGN_YET = 'No sign of it yet: no build is running and none is recorded. Check again shortly. To try again, close this window and run the command again.';

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Compares wiki names loosely, as the Curator's propose-topic-wiki does (its `wikiTitleKey`): case,
 *  accents, punctuation, a leading "The" and a trailing "Wiki" don't count. The Curator leaves out a
 *  ready create for such a name, since create-or-update-wiki matches titles exactly and would make a
 *  near-duplicate wiki. */
export function wikiTitleKey(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .replace(/^the\s+/, '').replace(/\s+wiki$/, '').trim();
}

/** Why the wiki can't be created under `topic`, checked before any call; null when it can. The topic
 *  wiki gets a topic note of its own, so it can't take the note's title, nor a matched wiki's name,
 *  loosely compared. */
export function topicNameProblem(topic: string, note: string, match: TopicWikiMatch | null): string | null {
  if (!topic.trim()) return 'Enter a name for the wiki.';
  if (sameName(topic, note))
    return 'A topic wiki gets a note of its own, so it needs a name other than this note\'s title. Pick another topic below or write a fuller name.';
  if (match && wikiTitleKey(topic) === wikiTitleKey(match.title))
    return `"${topic.trim()}" is the same name as the wiki "${match.title}". Choose a different name for a new wiki.`;
  return null;
}

/**
 * "Create topic wiki from this note" (#387). Free checks first; then one small paid call suggests the
 * topic, which the person accepts or edits; then create-or-update-wiki registers the wiki (or adds the
 * note to a matched one) and queues its build, which the panel follows by status under the wiki's title.
 * No paid call is ever repeated automatically, and a lost reply is settled by reading status.
 */
export function useTopicWikiCreate(props: TopicWikiCreateProps) {
  const { api, noteRef } = props;
  const [phase, setPhase] = useState<TopicWikiPhase>('checking');
  const [note, setNote] = useState<TopicWikiNote | null>(null);
  /** The model the suggestion runs on, from the free check. */
  const [model, setModel] = useState<string | null>(null);
  const [proposal, setProposal] = useState<TopicProposal | null>(null);
  const [topic, setTopic] = useState('');
  const [brief, setBrief] = useState('');
  const [target, setTarget] = useState<TopicWikiTarget | null>(null);
  /** The latest status read: today's budget before starting, the build's progress after. */
  const [status, setStatus] = useState<WikiRebuildStatus | null>(null);
  const [ended, setEnded] = useState<TopicWikiEnd | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  /** Why the last confirm went back to the proposal, with nothing created. */
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  /** The newest run of the target wiki before this build: a newer one is its result. */
  const baseline = useRef(0);
  const noteTitle = note?.title ?? props.noteTitle;

  const block = (text: string): void => { setBlocked(text); setPhase('blocked'); };

  const follow = useCallback((next: WikiRebuildStatus, turn: number): void => {
    if (turn !== epoch.current) return;
    setStatus(next);
    if (next.in_progress) { setPhase('running'); return; }
    const latest = next.latest_run;
    setEnded({ kind: 'run', run: latest && latest.id > baseline.current ? latest : null });
    setPhase('finished');
  }, []);

  useEffect(() => {
    const turn = ++epoch.current;
    setPhase('checking'); setNote(null); setModel(null); setProposal(null); setTopic(''); setBrief(''); setTarget(null);
    setStatus(null); setEnded(null); setBlocked(null); setFormError(null); setError(null);
    void (async () => {
      let found: TopicWikiNote;
      try {
        found = await api.note(noteRef);
      } catch {
        if (turn === epoch.current)
          block('Engine can\'t find this note. If you just created or renamed it, wait a moment for Engine to index it, then try again; otherwise check the Engine connection.');
        return;
      }
      if (turn !== epoch.current) return;
      setNote(found);
      try {
        // Any title's status carries today's budget, shown before the paid steps.
        const [check, current] = await Promise.all([api.check(found.id), api.status(found.title)]);
        if (turn !== epoch.current) return;
        setStatus(current);
        if (check.status === 'refused') { block(topicRefusal(check.code, check.message, found.title)); return; }
        setModel(check.model);
        setPhase('ready');
      } catch {
        if (turn === epoch.current) block('Cannot check this note. Check the Curator connection, token scopes and version.');
      }
    })();
    return () => { epoch.current++; };
  }, [api, noteRef]);

  useEffect(() => {
    if (phase !== 'running' || error || !target) return;
    const turn = epoch.current;
    const timer = setTimeout(() => {
      void api.status(target.title).then(next => follow(next, turn)).catch(() => {
        if (turn === epoch.current) setError('Cannot read its status. It may still be running.');
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [api, target, phase, status, error, follow]);

  /** The one paid call that suggests the topic. */
  const suggest = async (): Promise<void> => {
    if (phase !== 'ready' || !note) return;
    const turn = epoch.current;
    setPhase('proposing');
    try {
      const result = await api.propose(note.id);
      if (turn !== epoch.current) return;
      if (result.status === 'refused') { block(topicRefusal(result.code, result.message, note.title)); return; }
      setProposal(result); setTopic(result.topic); setBrief(result.brief); setFormError(null);
      setPhase('proposal');
    } catch {
      if (turn === epoch.current)
        block('No reply came back from Curator, so no topic was suggested and nothing was created. Check the Curator connection, then run the command again.');
    }
  };

  /** An alternative fills in the topic, and its brief when it has one. */
  const pick = (alternative: { topic: string; brief: string }): void => {
    if (phase !== 'proposal') return;
    setTopic(alternative.topic);
    if (alternative.brief.trim()) setBrief(alternative.brief);
    setFormError(null);
  };

  const nameProblem = proposal ? topicNameProblem(topic, noteTitle, proposal.existing_wiki) : null;

  /** Create the wiki under the edited topic and brief, or add the note to the matched wiki. */
  const confirm = async (action: 'create' | 'add'): Promise<void> => {
    if (phase !== 'proposal' || !proposal || !note) return;
    let args: TopicWikiArgs;
    if (action === 'add') {
      if (!proposal.next.add_source) return;
      args = proposal.next.add_source;
    } else {
      if (nameProblem) return;
      // The proposal's ready arguments when it has them; the same arguments otherwise (its topic was the note's title).
      const base: TopicWikiArgs = { ...(proposal.next.create ?? { topic: '', source: 'vault+web', source_node_ids: [note.id], paused: true }) };
      delete base.brief;
      const edited = brief.trim();
      args = { ...base, topic: topic.trim(), ...(edited ? { brief: edited } : {}) };
    }
    const turn = epoch.current;
    setTarget({ action, title: args.topic }); setPhase('starting'); setFormError(null); setError(null); setEnded(null);
    try {
      const before = await api.status(args.topic);
      if (turn !== epoch.current) return;
      setStatus(before);
      baseline.current = baselineRun(before);
    } catch {
      if (turn !== epoch.current) return;
      setFormError('Cannot reach Curator, so nothing was created. Check the connection and try again.');
      setPhase('proposal');
      return;
    }
    try {
      const started = await api.start(args);
      if (turn !== epoch.current) return;
      switch (started.status) {
        case 'refused': {
          const text = topicRefusal(started.code, started.message, note.title, args.topic);
          if (NAME_REFUSALS.has(started.code)) { setFormError(text); setPhase('proposal'); return; }
          block(text); return;
        }
        case 'answered':
          // Nothing needed a build (the note was already a source); otherwise an older Curator built it before replying.
          if (started.outcome === 'skipped') { setEnded({ kind: 'unchanged' }); setPhase('finished'); return; }
          setPhase('running'); return;
        case 'queued': case 'in_progress': setPhase('running'); return;
      }
    } catch {
      if (turn !== epoch.current) return;
      setError('Couldn\'t confirm it started. Check its status before trying again.');
      setPhase('unconfirmed');
    }
  };

  /** Read status by hand: after a failed poll, or to settle a start with no clear reply. */
  const retryStatus = async (): Promise<void> => {
    if (!target) return;
    const turn = epoch.current;
    setError(null);
    try {
      const next = await api.status(target.title);
      if (turn !== epoch.current) return;
      setStatus(next);
      if (next.in_progress) { setPhase('running'); return; }
      if ((next.latest_run?.id ?? 0) > baseline.current) { follow(next, turn); return; }
      // No sign of it doesn't prove it never started, so a paid start isn't offered again from here.
      if (phase === 'unconfirmed') { setError(NO_SIGN_YET); return; }
      follow(next, turn);
    } catch {
      if (turn === epoch.current) setError('Cannot read its status. It may still be running.');
    }
  };

  return {
    phase, note, noteTitle, model, proposal, topic, brief, target, status, ended, blocked, formError, error, nameProblem,
    setTopic: (value: string) => { setTopic(value); setFormError(null); }, setBrief, pick, suggest, confirm, retryStatus,
  };
}
