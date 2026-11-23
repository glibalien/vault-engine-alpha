import type { WikiRebuildRun, WikiRebuildStatus } from '@vault/query-core';

/** Wording shared by the whole-wiki panels: rebuild (#372), create (#384) and the wiki panel (#545). */

export const usd = (value: number): string => `$${value.toFixed(value < 1 ? 3 : 2)}`;

/** A run's day, in the reader's locale. */
export const runDay = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};

/** A day in short form, "Nov 14", with the year when it isn't this one: for the wiki panel (#545). */
export const shortDay = (iso: string, now = new Date()): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
};

/** The last full build: its day and estimated cost. */
export function lastBuildLine(run: WikiRebuildRun | null, none: string): string {
  if (!run) return none;
  return run.cost_usd === null
    ? `Last full build: ${runDay(run.ts)}, with no cost recorded.`
    : `Last full build: ${runDay(run.ts)}, an estimated ${usd(run.cost_usd)}.`;
}

export function budgetLine(status: WikiRebuildStatus): string | null {
  const { cap_usd: cap, remaining_usd: left } = status.daily_budget;
  return cap === null || left === null ? null : `Today's Curator budget: ${usd(left)} left of ${usd(cap)}.`;
}

/** A Curator detail in plain words where it leads with a code a person can't act on. */
export function plainWikiDetail(project: string, detail: string): string {
  if (/^NO_WIKI\b/.test(detail))
    return `"${project}" has no project wiki yet. Run Create project wiki on its project note to start one.`;
  return detail;
}

/** A create-project-wiki refusal in plain words. Curator messages are mostly plain already; the
 *  codes below are the ones whose message doesn't say what to do. */
export function createRefusal(project: string, code: string, message: string): string {
  switch (code) {
    case 'NOT_A_PROJECT': return `"${project}" isn't a project note, so it can't have a project wiki.`;
    case 'UNKNOWN_PROJECT':
      return `Curator can't find a project note called "${project}". If you just created or renamed it, wait a moment for Engine to index it, then try again.`;
    case 'TITLE_IN_USE':
      // The `<topic> Wiki` trap's sibling: one title, one wiki.
      return /renamed/.test(message)
        ? `The name "${project}" still belongs to the wiki of a project note that was renamed. Run Create project wiki on that note under its new name first, then try again.`
        : `A topic wiki already uses the name "${project}". Rename this project note, or remove that topic wiki first.`;
    case 'FORBIDDEN': return 'This Curator token can\'t create wikis. It needs the curate:read and curate:trigger scopes.';
    case 'NO_DB': return 'This Curator runs without its database, so it can\'t create wikis.';
    default: return message ? plainWikiDetail(project, message) : `Curator refused to create it (${code}).`;
  }
}

/** Whether a build in flight still waits in the Curator's one lane: it runs under its wiki's title,
 *  so a build whose title isn't the lane's current one is queued behind other work. */
export const waitingInLane = (status: WikiRebuildStatus | null, title: string): boolean =>
  !!status?.in_progress && !!status.queue && status.queue.current !== title;

/** The build ahead of this one in the Curator's lane, when its status names one. */
export function aheadInLane(status: WikiRebuildStatus | null, title: string): string | null {
  const current = status?.queue?.current;
  return waitingInLane(status, title) && current ? current : null;
}

/** A propose-topic-wiki or create-or-update-wiki refusal in plain words (#387). The Curator's own
 *  messages are written for AI callers and name tools, so every known code gets its own sentence.
 *  `note` is the note's title; `topic` the wiki name sent, when there was one. */
export function topicRefusal(code: string, message: string, note: string, topic?: string): string {
  if (/^DAILY_BUDGET/.test(code))
    return 'Curator\'s daily budget won\'t allow this call now (it may be spent), so nothing was called or created. Try again tomorrow.';
  switch (code) {
    case 'NODE_IS_A_WIKI_PAGE':
      return `"${note}" is a page of a wiki, not a note to start one from. Run this on a note the new wiki should be about.`;
    case 'NODE_HAS_A_WIKI': return `"${note}" is the topic note of a wiki that already exists, so it can't start another.`;
    case 'TOO_LITTLE_TEXT': return `"${note}" has too little text for Curator to suggest a topic from. Add to it and try again.`;
    case 'NODE_NOT_FOUND':
      return `Curator can't find "${note}" in Engine. If you just created or renamed it, wait a moment for Engine to index it, then try again.`;
    case 'ENGINE_UNAVAILABLE': case 'REGISTRY_UNAVAILABLE':
      return 'Curator couldn\'t read the note or its wikis just now, so nothing was called or created. Try again shortly.';
    case 'MODEL_UNAVAILABLE':
      return 'Curator\'s wiki planning model can\'t be used right now, so nothing was called. Check Curator\'s model settings.';
    case 'INFERENCE_FAILED': return 'Curator couldn\'t suggest a topic this time. Nothing was created; run the command again to retry.';
    case 'PROVIDER_SPEND_LIMIT':
      return 'The model provider\'s spend limit for Curator is reached, so nothing was called or created. Try again after it resets.';
    case 'CURATOR_SHUTTING_DOWN': case 'SHUTTING_DOWN': return 'Curator is restarting. Nothing was changed; try again in a minute.';
    case 'WIKI_EXISTS': return `A wiki called "${topic ?? ''}" already exists. Choose another name. Nothing was created.`;
    case 'WIKI_IS_A_PROJECT': return `"${topic ?? ''}" is the name of a project's wiki. Choose another name. Nothing was created.`;
    case 'TOPIC_IS_A_WIKI_PAGE':
      return `"${topic ?? ''}" is the name of an existing wiki's home page, so a new wiki can't take it. Choose another name. Nothing was created.`;
    case 'SELF_SOURCE_NODE': return `"${note}" is one of that wiki's own pages, so it can't be one of its sources. Nothing was changed.`;
    case 'INVALID_SOURCE_NODE': return `Engine no longer has "${note}", so it can't be a source. Nothing was changed.`;
    case 'TOO_MANY_SOURCE_NODES':
      return `"${topic ?? ''}" already has the most sources a wiki can take (20), so "${note}" can't be added. Nothing was changed.`;
    case 'FORBIDDEN': return 'This Curator token can\'t make wikis. It needs the curate:read and curate:trigger scopes.';
    case 'NO_DB': return 'This Curator runs without its database, so it can\'t make wikis.';
    case 'CREATE_FAILED': return `Curator couldn't make the change${message ? `: ${message.replace(/\.$/, '')}` : ''}.`;
    default: return message || 'Curator refused this. Nothing was changed.';
  }
}
