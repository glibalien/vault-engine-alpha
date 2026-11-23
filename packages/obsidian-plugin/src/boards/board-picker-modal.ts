import { App, SuggestModal } from 'obsidian';
import type { BoardSummary } from '@vault/board-core';

// ---------------------------------------------------------------------------
// Choice shape — discriminated union for existing board vs. create-new
// ---------------------------------------------------------------------------

export type BoardChoice =
  | { kind: 'existing'; id: string; name: string }
  | { kind: 'new'; name: string };

/** Injectable seam: present the "all boards" picker and resolve the user's choice (or null if dismissed). */
export type ChooseBoard = (boards: BoardSummary[]) => Promise<BoardChoice | null>;

// ---------------------------------------------------------------------------
// BoardPickerModal — centered Obsidian SuggestModal for the all-boards / link-a-board flows
//
// Shows all existing boards, plus a "Create board …" entry when the user
// types a name that does not exactly match an existing board.
// ---------------------------------------------------------------------------

export class BoardPickerModal extends SuggestModal<BoardChoice> {
  constructor(
    app: App,
    private readonly boards: BoardSummary[],
    private readonly onPick: (choice: BoardChoice) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose a board or type a name to create one…');
  }

  getSuggestions(query: string): BoardChoice[] {
    const q = query.toLowerCase();
    const matches = this.boards.filter((b) => b.name.toLowerCase().includes(q));
    const suggestions: BoardChoice[] = matches.map((b) => ({ kind: 'existing', id: b.id, name: b.name }));

    // Offer a "create new" entry when the query is non-empty and no existing
    // board has exactly that name (case-insensitive).
    const trimmed = query.trim();
    if (trimmed && !this.boards.some((b) => b.name.toLowerCase() === trimmed.toLowerCase())) {
      suggestions.push({ kind: 'new', name: trimmed });
    }

    return suggestions;
  }

  renderSuggestion(choice: BoardChoice, el: HTMLElement): void {
    el.setText(choice.kind === 'new' ? `Create board "${choice.name}"` : choice.name);
  }

  onChooseSuggestion(choice: BoardChoice): void {
    this.onPick(choice);
  }
}

/**
 * Promise wrapper around BoardPickerModal for the BoardView "Show all boards…" escape.
 * Resolves the chosen board (existing or create-new), or null if the modal is dismissed.
 */
export function makeChooseBoard(app: App): ChooseBoard {
  return (boards) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (choice: BoardChoice | null): void => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      const modal = new BoardPickerModal(app, boards, settle);
      // Resolve null on dismiss-without-pick so callers don't hang. BUT Obsidian fires the modal's
      // onClose as PART OF selecting a suggestion, and in current versions that close runs BEFORE
      // onChooseSuggestion — so resolving null synchronously here would beat the real pick and
      // discard it (every selection looked like a dismiss → the chosen board never opened). Defer
      // the dismiss-resolution by one macrotask so an imminent onChooseSuggestion settles first.
      const close = modal.onClose?.bind(modal);
      modal.onClose = () => {
        close?.();
        setTimeout(() => settle(null), 0);
      };
      modal.open();
    });
}
