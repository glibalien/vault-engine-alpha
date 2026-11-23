import { isJournalNoteTitle } from './journal/render.js';

/** Monthly notes created by journal/writer.ts are operational output, not
 * implicit topic evidence. Explicit source IDs remain the caller's choice.
 * The journal's marker keeps it out of the searches; this title check is the backstop (#600). */
export function isCuratorJournalTitle(title: string | null | undefined): boolean {
  return isJournalNoteTitle(title);
}
