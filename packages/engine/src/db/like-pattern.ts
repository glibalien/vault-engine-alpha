/**
 * SQL `LIKE` patterns that match caller text literally. In a bare `LIKE`, `%` and `_` in the
 * text are wildcards, so a folder named `Export_A` also matches `ExportBA`. Use every pattern
 * from here with `ESCAPE '\\'` (`LIKE_ESCAPE`).
 */

/** Appended to a `LIKE ?` whose parameter comes from this module. */
export const LIKE_ESCAPE = `ESCAPE '\\'`;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/** Matches `text` anywhere. */
export function literalContainsPattern(text: string): string {
  return `%${escapeLike(text)}%`;
}

/** Matches values that start with `prefix`. */
export function literalPrefixPattern(prefix: string): string {
  return `${escapeLike(prefix)}%`;
}
