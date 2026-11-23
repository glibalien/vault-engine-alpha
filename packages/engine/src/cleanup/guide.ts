/**
 * The organizing session (#650): how a caller works through the clean-up report with the user.
 * It is returned with every report, so any client gets it from a plain request ("what is still
 * unorganized in my vault?") with nothing installed on its side, and gets it again on each
 * later read, after an earlier copy may have left its context.
 *
 * Each line is one step, in order. Keep it short: it is sent on every call. It names tools and
 * arguments, so check them against the tools when either changes. `tests/mcp/cleanup-guide.test.ts`
 * reads every hyphenated word here as a tool name and fails when a signed-in client has no such
 * tool (so write "clean up", not a hyphenated form), and it follows the steps on a small vault.
 */
export const ORGANIZING_STEPS: readonly string[] = [
  'Tell the user what this report found, in plain words: each row\'s title and how many notes it affects, most first. Suggest starting with the first row, and let them choose.',
  'Work on one row at a time. The row\'s next holds the calls that start on it, and cleanup-report with row lists exactly the notes it counted.',
  'For notes with no kind, call survey-nodes and read each group\'s samples and shared features. Propose a kind for each group that clearly is one: a name, and the frontmatter fields its notes share. Groups with the same features are one kind. A "Label: value" line most of a group shares suggests a field too, but its values stay in the notes\' text until they are copied into the field. Before proposing that a kind claim a field, read its values with list-field-values: an exported field can describe the export, not the note (author: me on every note). Leave a group you cannot name as it is, or split it with within.',
  'Agree the kinds with the user before creating anything. Then, for each kind: create-schema (list-global-fields shows fields to reuse where they mean the same thing), and update-node with add_types and query: { node_ids } holding that group\'s ids from members_of. members_of pages at most 500 ids: type one page per update-node call.',
  'Preview every change to more than one note, tell the user how many notes it changes and name a few, and write only after they say yes. update-node with a query only previews until dry_run is false.',
  'After a write, tell the user it can be undone: list-undo-history shows it and undo-operations reverses it, for 24 hours unless the Engine is set to keep undo records for another length of time.',
  'Then call cleanup-report again and say what changed: a fixed row is smaller or has moved to clear. Go on to the next row, or stop when the user wants to. The vault holds the progress, so a later report starts from where they left off.',
  'not_checked lists checks that could not run. Each names the vault setting that turns it on: offer to set it with update-settings.',
];

/** What a report with no rows says instead: there is nothing to walk through. */
export const NOTHING_LEFT_STEPS: readonly string[] = [
  'Every check that ran found nothing to clean up. Tell the user so.',
  'If not_checked has entries, each names the vault setting that turns its check on. Offer to set it with update-settings, then call cleanup-report again.',
];

export function organizingGuide(rows: number): string[] {
  return [...(rows > 0 ? ORGANIZING_STEPS : NOTHING_LEFT_STEPS)];
}
