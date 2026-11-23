import { count } from './text.js';

/**
 * Pointing a fresh install at sorting the notes it left without a kind (#650). The request
 * below is one any assistant connected to Engine can act on: Engine's `cleanup-report` tool
 * answers it and returns the steps for working through what it finds, so nothing is
 * installed on the assistant's side.
 */
export const SORTING_REQUEST = 'What is still unorganized in my vault?';

/** Sorting leads the finish step when at least this share of the notes has no kind... */
export const SORTING_LEADS_AT = 0.25;
/** ...and at least this many do: a handful of loose notes is not a vault to sort, and a survey needs about ten notes to form a group. */
export const SORTING_LEADS_FROM = 10;

/**
 * The same session as a command in Claude Code: the Engine's `organize-vault` prompt, under
 * the server name the finish step's `claude mcp add` line registers (`vault-engine`).
 */
export const SORTING_COMMAND = '/mcp__vault-engine__organize-vault';

export interface UnsortedNotes {
  untyped: number;
  notes: number;
  /** Whether sorting comes before the wiki or search suggestion. */
  leads: boolean;
}

/**
 * The notes the plan leaves without a kind. Null when the plan did not read the notes (Vault
 * has used the folder before) or every note gets a kind.
 */
export function unsortedNotes(structure: { typed_notes: number; untyped_notes: number } | null | undefined): UnsortedNotes | null {
  if (!structure || structure.untyped_notes <= 0) return null;
  const notes = structure.typed_notes + structure.untyped_notes;
  const untyped = structure.untyped_notes;
  return { untyped, notes, leads: untyped >= SORTING_LEADS_FROM && untyped >= notes * SORTING_LEADS_AT };
}

/** "None of your 40 notes has a kind", or "12 of your 40 notes have no kind". */
export function unsortedWords(unsorted: UnsortedNotes): string {
  const { untyped, notes } = unsorted;
  return untyped === notes
    ? `None of your ${count(notes, 'note')} has a kind`
    : `${untyped} of your ${count(notes, 'note')} ${untyped === 1 ? 'has' : 'have'} no kind`;
}

/** The review screen's line after the count of notes that get no kind. */
export function sortingAfterInstall(untyped: number): string {
  return `Once Vault is installed, an AI assistant connected to it can sort ${untyped === 1 ? 'it' : 'them'} with you; the last screen says how.`;
}
