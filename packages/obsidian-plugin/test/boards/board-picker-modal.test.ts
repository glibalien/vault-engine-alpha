import { it, expect, afterEach } from 'vitest';
import type { App } from 'obsidian';
import { makeChooseBoard, BoardPickerModal, type BoardChoice } from '../../src/boards/board-picker-modal.js';
import type { BoardSummary } from '@vault/board-core';

// Capture the modal instance makeChooseBoard constructs so the test can drive Obsidian's
// suggestion-selection lifecycle (onChooseSuggestion / onClose) by hand.
let captured: BoardPickerModal | null = null;
const realOpen = (BoardPickerModal.prototype as { open?: () => void }).open;

function withCapturedOpen(): void {
  (BoardPickerModal.prototype as { open: () => void }).open = function (this: BoardPickerModal) { captured = this; };
}
afterEach(() => {
  (BoardPickerModal.prototype as { open?: () => void }).open = realOpen;
  captured = null;
});

const boards: BoardSummary[] = [{ id: 'b1', name: 'B1', updated_at: 1, card_count: 0 }];
const pick: BoardChoice = { kind: 'existing', id: 'b1', name: 'B1' };

it('resolves the chosen board even when onClose fires BEFORE onChooseSuggestion (real Obsidian order)', async () => {
  withCapturedOpen();
  const p = makeChooseBoard({} as App)(boards);
  // Obsidian closes the modal as part of selecting — in current versions onClose runs first.
  captured!.onClose();
  captured!.onChooseSuggestion(pick);
  await expect(p).resolves.toEqual(pick);
});

it('resolves the chosen board when onChooseSuggestion fires before onClose', async () => {
  withCapturedOpen();
  const p = makeChooseBoard({} as App)(boards);
  captured!.onChooseSuggestion(pick);
  captured!.onClose();
  await expect(p).resolves.toEqual(pick);
});

it('resolves null when the modal is dismissed without a choice', async () => {
  withCapturedOpen();
  const p = makeChooseBoard({} as App)(boards);
  captured!.onClose(); // dismissed — no onChooseSuggestion
  await expect(p).resolves.toBeNull();
});
