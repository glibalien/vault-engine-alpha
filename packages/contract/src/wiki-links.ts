/**
 * A note's text as a wiki compares it: each `[[link]]` read as the words it shows, shared by the
 * Engine (project evidence, provenance) and the Curator (topic sources, page records). Adding or
 * removing a link around words already in a note, as the Curator's link sweep does, leaves this
 * text unchanged, so a wiki built from the note is not behind and is not rebuilt for it.
 *
 * `[[Target]]` reads as `Target`, `[[Target|shown]]` as `shown` (also `[[Target\|shown]]`, as a
 * table cell writes it). An embed (`![[...]]`) is left as written: it brings in another file's
 * content, so changing one is a real change. Links in code are reduced too; this text is only
 * compared, never shown.
 */
const WIKI_LINK = /(?<!!)\[\[([^[\]|\n]+?)(?:\\?\|([^[\]\n]*))?\]\]/g;

export function withoutWikiLinks(text: string): string {
  return text.replace(WIKI_LINK, (_match, target: string, shown: string | undefined) =>
    shown !== undefined && shown !== '' ? shown : target);
}
