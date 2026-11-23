import type { WikiRebuildStatus } from './wiki-rebuild-types.js';

/** A Curator refusal: its own code, kept for the wording, and its message. */
export type WikiCreateRefusal = { status: 'refused'; code: string; message: string };

/** Creating a project wiki on request (#384). Everything here comes from MCP tools an AI caller can
 *  also call: create-project-wiki (with and without dry_run) and curator-status with `project`. */
export type WikiCreateCheck =
  /** A build for the project is already queued or running. */
  | { status: 'in_progress' }
  /** The project already has a wiki. */
  | { status: 'exists' }
  /** The project was renamed and its wiki is still registered under its old title, `from`. Creating
   *  moves the registration to the current title. */
  | { status: 'renamed'; from: string }
  /** It can be created; `home_missing` says whether an empty home page would be written. */
  | { status: 'ready'; home_missing: boolean }
  | WikiCreateRefusal;

export type WikiCreateStart =
  /** Registered, and its first build is queued; or a build was already queued or running. */
  | { status: 'queued' | 'in_progress' }
  /** Registered, and no first build was needed: its pages were built before. */
  | { status: 'registered' }
  /** It already had a wiki and needed no build. After a `renamed` check, its registration has moved
   *  to the current title. */
  | { status: 'exists' }
  /** Registered, but the Curator answered the first build at once without running it (a paused wiki). */
  | { status: 'not_started'; outcome: string; detail: string | null }
  | WikiCreateRefusal;

export type WikiCreateApi = {
  /** By the project's title: the Curator keeps runs and builds under it. */
  status(project: string): Promise<WikiRebuildStatus>;
  /** Free: a dry run, with no writes or model calls. `ref` names the project note: its title, path
   *  or node id. A path or id can't be mistaken for a namesake in another folder. */
  check(ref: string): Promise<WikiCreateCheck>;
  /** Registers the wiki (free) and queues its first build (paid). A repeat while that build is
   *  queued or running starts nothing. */
  start(ref: string): Promise<WikiCreateStart>;
};

/** Making a topic wiki from a note (#387). Everything here comes from MCP tools an AI caller can also
 *  call: Engine's get-node, then the Curator's propose-topic-wiki (with and without dry_run),
 *  create-or-update-wiki and curator-status with `project`. */
export type TopicWikiNote = { id: string; title: string };

/** create-or-update-wiki arguments: a new paused vault+web wiki with the note as its source, or the
 *  note added to an existing topic wiki's sources. */
export type TopicWikiArgs = {
  topic: string;
  brief?: string;
  source?: 'vault+web';
  source_node_ids?: string[];
  add_source_node_ids?: string[];
  paused?: true;
};

/** A registered wiki the proposed topic names. */
export type TopicWikiMatch = {
  title: string;
  kind: 'topic' | 'project';
  /** 'title': the same name, loosely compared, so a new wiki needs another; 'model': the same subject. */
  matched_by: 'title' | 'model';
  paused: boolean;
  /** Topic wikis only: whether the note is already one of its sources. */
  note_is_source?: boolean;
};

/** The free check passed: suggesting a topic makes one call on `model`. */
export type TopicProposalCheck = { status: 'ready'; model: string } | WikiCreateRefusal;

export type TopicProposal = {
  status: 'proposed';
  topic: string;
  brief: string;
  confidence: 'high' | 'medium' | 'low';
  alternatives: Array<{ topic: string; brief: string }>;
  existing_wiki: TopicWikiMatch | null;
  /** Ready arguments: `create` is left out when the topic names an existing wiki or is the note's own
   *  title; `add_source` is there only for a matched topic wiki that can take the note. */
  next: { create?: TopicWikiArgs; add_source?: TopicWikiArgs };
};

export type TopicWikiStart =
  /** The build is queued, or a build of that wiki was already queued, which includes this change. */
  | { status: 'queued' | 'in_progress'; created: boolean }
  /** The Curator answered without queueing: the change needed no build (`outcome` "skipped"), or an
   *  older Curator ran the build before replying. */
  | { status: 'answered'; created: boolean; outcome: string; detail: string | null }
  | WikiCreateRefusal;

export type TopicWikiApi = {
  /** A wiki's status by its title; any title gives today's budget. */
  status(title: string): Promise<WikiRebuildStatus>;
  /** The note's Engine node, from `ref` (its path). */
  note(ref: string): Promise<TopicWikiNote>;
  /** Free: the note's checks, with no model call. */
  check(nodeId: string): Promise<TopicProposalCheck>;
  /** One small paid call that suggests the topic. Creates nothing. */
  propose(nodeId: string): Promise<TopicProposal | WikiCreateRefusal>;
  /** create-or-update-wiki: registers the wiki or adds the source (free), then queues its build (paid). */
  start(args: TopicWikiArgs): Promise<TopicWikiStart>;
};
