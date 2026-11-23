// What a paid call was for, in the Engine's spend ledger. The Engine's record-usage tool accepts only
// these values, so every service that reports spend takes its purposes from this list. A label missing
// here would be rejected and the call's spend dropped from reports and the daily budget.
export const USAGE_PURPOSES = [
  'conversation',
  'wiki-synthesis',
  'vision-extraction',
  'audio-transcription',
  'memory-consolidation',
  'memory-sweep',
  'conversation-sweep',
  'conversation-capture-planner',
  'conversation-capture-coverage',
  'conversation-capture-composer',
  'field-guess',
  'org-sweep',
  'reconcile',
  'topic-refresh-assessment',
  'viz-interpret',
  'journal',
  'title-generation',
  'web-search',
  // On-demand rebuilds of one wiki page and the paid golden wiki cases (#372).
  'project-home-refresh',
  'project-page-refresh',
  'eval-wiki',
  // The topic a note implies, proposed before a topic wiki is made from it (#387).
  'topic-inference',
  // An on-demand field-filling run over a chosen set of notes, paid from its own limit (#644).
  'field-fill-run',
  // An on-demand typing run over a chosen set of untyped notes, paid from its own limit (#644).
  'type-notes-run',
  // An on-demand run naming who or what memories with no subjects are about, paid from its own limit (#554).
  'memory-subjects-run',
  // An on-demand run extracting memories from a chosen set of notes, paid from its own limit (#659).
  'memory-extraction-run',
  // The Engine's consolidation check of a memory such a run wrote: paid from the run's limit, not the daily cap (#659).
  'memory-consolidation-run',
  // A person's or a company's dossier, built on request and paid from the Curator's daily cap (#554).
  'entity-dossier',
  // The check of a dossier's lines against its subject's rules on what may be said, after the page call (#721).
  'entity-dossier-rules',
] as const;

export type UsagePurpose = (typeof USAGE_PURPOSES)[number];
