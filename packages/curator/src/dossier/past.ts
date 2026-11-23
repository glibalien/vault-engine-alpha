import type { Memory } from '../types.js';

/**
 * Past facts (#717; owner, 2026-11-21): memories about a dossier's subject that a newer one
 * replaced, shown in History only, with the days they were true.
 */

/** Why a memory another replaced counts as a past fact: a contradiction only (owner, 2026-11-21).
 *  An update verdict means the newer memory says everything the older one did and more, so the
 *  older fact may still be true, and a hand edit through update-memory records the same
 *  `superseded-by-update`; a duplicate or a deletion is no past fact either. */
export const PAST_FACT_REASONS = ['contradicted'] as const;

/** A memory another replaced, by its expiry: a past fact. */
export function isPastFact(memory: Memory): boolean {
  return typeof memory.expired_at === 'string' && (PAST_FACT_REASONS as readonly string[]).includes(memory.expire_reason ?? '');
}

/** When a past fact stopped being true: the Engine's `invalid_at`, else the day the memory that
 *  replaced it became true (the Curator's reconcile sets no `invalid_at`), else when it was replaced. */
export function pastFactEnd(memory: Memory, replacement?: Memory): string | null {
  return memory.invalid_at ?? (replacement ? replacement.valid_at ?? replacement.created_at : null) ?? memory.expired_at ?? null;
}

/**
 * The day a past fact became true, when its memory knows it: a date from its note (#706) or a
 * verdict's, never the day it was recorded (`valid_at` equal to `created_at`). Most memories from
 * before #706's note dates were dated by their recording (owner, 2026-11-21, after a side agent's
 * point: 37 of the 50 changes on production would have shown that day as "from").
 */
export function pastFactStart(memory: Memory): string | null {
  return memory.valid_at && memory.valid_at !== memory.created_at ? memory.valid_at : null;
}
