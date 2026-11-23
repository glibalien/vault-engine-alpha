export type ComposerSigil = '@';
export const COMPOSER_SIGILS: readonly ComposerSigil[] = ['@'];

export interface ComposerTrigger {
  sigil: ComposerSigil;
  from: number; // index of the sigil char in `text`
  to: number; // caret index (end of the query)
  query: string; // chars between the sigil and the caret (no whitespace)
}

function isSigil(ch: string): ch is ComposerSigil {
  return ch === '@';
}

/**
 * Detect the autocomplete trigger ending at `caret`. A trigger is a sigil
 * (@) at a word start — index 0 or immediately after whitespace — followed
 * by zero or more non-whitespace, non-sigil query chars up to the caret.
 * Returns null when no trigger is active. The word-start rule keeps emails
 * ("a@b") from false-triggering.
 */
export function composerTrigger(text: string, caret: number): ComposerTrigger | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i]!) && !isSigil(text[i]!)) i--;
  if (i < 0) return null;
  const ch = text[i]!;
  if (!isSigil(ch)) return null;
  if (i > 0 && !/\s/.test(text[i - 1]!)) return null; // word-start gate
  return { sigil: ch, from: i, to: caret, query: text.slice(i + 1, caret) };
}

/** Wrap-around active-index move for ↑/↓ keyboard nav. */
export function nextActive(active: number, len: number, dir: 1 | -1): number {
  if (len <= 0) return 0;
  return (active + dir + len) % len;
}
