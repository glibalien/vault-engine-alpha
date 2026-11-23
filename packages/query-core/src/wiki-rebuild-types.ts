/** A whole-wiki rebuild on request (#372), of a project or topic wiki (#425). Everything here comes from
 *  MCP tools an AI caller can also call: curate-project-wiki and curator-status with `project`. */
export type WikiRebuildRun = {
  id: number; ts: string; outcome: string; error: string | null; cost_usd: number | null;
  input_tokens: number; output_tokens: number; duration_ms: number;
};
export type WikiRebuildStatus = {
  project: string;
  /** How the wiki is registered under this title: a project or topic wiki, or null when none is (#425).
   *  Absent from a Curator older than #425. */
  kind?: 'project' | 'topic' | null;
  /** The wiki's root note (the project or topic note), when registered with one. */
  root_node_id?: string | null;
  /** A topic wiki's evidence: its notes, or its notes plus web research. Null for a project wiki. */
  source?: 'vault' | 'vault+web' | null;
  in_progress: { since: string } | null;
  paused: boolean;
  models: { planning: string; page: string; home: string };
  latest_run: WikiRebuildRun | null;
  last_written: WikiRebuildRun | null;
  daily_budget: { cap_usd: number | null; spent_usd: number | null; remaining_usd: number | null };
  /** The Curator's one curation lane: `current` names the curation running now. A build runs under
   *  its project's title, so a build in progress whose title isn't `current` is still queued. */
  queue?: { running: boolean; depth: number; current?: string };
};
export type WikiRebuildCheck =
  | { in_progress: true }
  | { in_progress: false; outcome: string; detail: string | null; evidence_unchanged: boolean };
export type WikiRebuildStart = { status: 'queued' | 'in_progress' } | { status: 'refused'; detail: string };
export type WikiRebuildApi = {
  status(project: string): Promise<WikiRebuildStatus>;
  /** Free: makes no model call. */
  check(project: string): Promise<WikiRebuildCheck>;
  /** Paid. A repeat while one is queued or running starts nothing. */
  start(project: string): Promise<WikiRebuildStart>;
};

/** The wiki panel's own controls (#545), on the tools an AI caller has: curator-status with `project`
 *  to read a wiki's state, and set-wiki-paused to pause or resume it. Both are free. */
export type WikiControlApi = {
  status(project: string): Promise<WikiRebuildStatus>;
  /** Pause or resume a wiki's scheduled builds. Resolves to whether it is paused now. */
  setPaused(project: string, paused: boolean): Promise<{ paused: boolean }>;
};
