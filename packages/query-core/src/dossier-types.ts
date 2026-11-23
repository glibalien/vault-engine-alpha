import type { WikiCreateRefusal } from './wiki-create-types.js';
import type { WikiRebuildStatus } from './wiki-rebuild-types.js';

/**
 * A dossier's build, as the Obsidian plugin's "Build dossier" command drives it (#715): the free
 * dry run of build-dossier, then the paid build on confirm, followed by curator-status under the
 * page's title. The same tools an AI caller has.
 */

/** What the free dry run says the build would do. */
export type DossierPreview = {
  status: 'ready';
  /** The page's title: "<Name> Dossier". */
  page_title: string;
  /** A first build, or a rebuild of the page the note already has. */
  action: 'create' | 'rebuild';
  subject_kind: 'person' | 'company';
  reads: {
    /** Live memories about the note; null when the Engine gave no total. */
    memories: number | null;
    memories_shown: number;
    /** Earlier facts a newer memory contradicted (#717), shown to the model as past facts. */
    past: number;
    /** The note's rules on what may be said; each build checks its lines against them. */
    rules: number;
    notes: number;
    meetings: number;
    /** Meetings and notes read in full. */
    read_in_full: number;
  };
  /** The page's sections, in page order (#716): the note's kind's list, from the setting or built in. */
  sections: string[];
  model: string;
  /** Paid calls: the page, and its rule check when the note has rules. */
  calls: number;
  estimated_usd: number | null;
  worst_case_usd: number | null;
  /** Whether the worst case fits what is left of today's cap, and the budget's words when not. */
  fits: boolean;
  refusal: string | null;
  remaining_usd: number | null;
  cap_usd: number | null;
  /** How the dossier is kept: `on-change` when the note asks for nightly rebuilds. */
  rebuild: 'manual' | 'on-change';
};

export type DossierCheck = DossierPreview | WikiCreateRefusal;

export type DossierStart =
  /** Queued, or a build of this dossier was already queued or running. */
  | { status: 'queued' | 'in_progress'; page_title: string }
  /** The Curator answered at once with the build's outcome (no background builds). */
  | { status: 'answered'; page_title: string; outcome: string; detail: string }
  | WikiCreateRefusal;

export type DossierApi = {
  /** Status under the page's title: whether a build is running, and its newest run. */
  status(pageTitle: string): Promise<WikiRebuildStatus>;
  /** Free: the dry run. */
  check(nodeId: string): Promise<DossierCheck>;
  /** The paid build, queued. `rebuild` sets how it is kept, on the note, before the build reads it (#714). */
  start(nodeId: string, rebuild?: 'manual' | 'on-change'): Promise<DossierStart>;
};
