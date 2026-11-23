/**
 * What the notes of one survey group have in common (#642): the shape of their titles and the
 * labelled lines and headings in their text. These describe a group to the caller; they are not
 * inputs to the grouping.
 */

/** Only the start of a note's text is read. */
export const BODY_HEAD_CHARS = 4000;

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** Replaced in order; each match becomes its token. */
const TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b[0-9a-f]{32}\b/gi, '<id>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
  [/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, '<date>'],
  [new RegExp(`\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`, 'gi'), '<date>'],
  [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTH}\\.?,? \\d{4}\\b`, 'gi'), '<date>'],
  [/\b(?:19|20)\d{6}\b/g, '<date>'],
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?: ?[ap]m)?\b/gi, '<time>'],
  [/\d+/g, '<n>'],
];

function tokenize(text: string): string {
  let out = text;
  for (const [pattern, token] of TOKENS) out = out.replace(pattern, token);
  return out;
}

/**
 * The shape of a title: dates, times, ids and numbers become tokens, and the words between
 * them become `…`. "2021-03-04 Weekly sync" and "2022-11-18 Planning" are both `<date> …`.
 * A title of plain words is `…`.
 */
export function titlePattern(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') return '';
  if (/^untitled\b/i.test(trimmed)) return 'Untitled';
  const parts = tokenize(trimmed).split(/(<(?:id|date|time|n)>)/);
  const shape: string[] = [];
  for (const part of parts) {
    if (/^<(?:id|date|time|n)>$/.test(part)) {
      shape.push(part);
    } else if (/[\p{L}]/u.test(part) && shape[shape.length - 1] !== '…') {
      shape.push('…');
    }
  }
  return shape.join(' ');
}

const LABEL_LINE = /^\s*(?:[-*+]\s+|>\s*)?(?:\*\*|__)?(\p{L}[\p{L}\p{N} /&'()-]{0,29}?)\s*(?:\*\*|__)?\s*::?\s*(?:\*\*|__)?\s*\S/u;
const HEADING_LINE = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const NOT_LABELS = new Set(['http', 'https', 'mailto', 'ftp', 'file']);

export interface BodyFeatures {
  /** Lowercased label -> the label as first written. One entry per distinct label in the note. */
  labels: Map<string, string>;
  /** Lowercased heading shape -> the heading as first written (dates and numbers tokenized). */
  headings: Map<string, string>;
}

/**
 * The `Label: value` lines and Markdown headings in the start of a note's text. Fenced code is
 * skipped. A label is at most three words at the start of a line (after a list marker or bold
 * markers), followed by `:` or `::` and a value.
 */
export function bodyFeatures(body: string): BodyFeatures {
  const labels = new Map<string, string>();
  const headings = new Map<string, string>();
  let fenced = false;
  for (const line of body.slice(0, BODY_HEAD_CHARS).split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const shape = tokenize(heading[1]!.replace(/[*_`]/g, '')).replace(/\s+/g, ' ').trim();
      if (shape !== '' && !headings.has(shape.toLowerCase())) headings.set(shape.toLowerCase(), shape);
      continue;
    }
    const label = LABEL_LINE.exec(line);
    if (!label) continue;
    const text = label[1]!.replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (text.split(' ').length > 3 || NOT_LABELS.has(key)) continue;
    if (!labels.has(key)) labels.set(key, text);
  }
  return { labels, headings };
}

export interface SharedCount {
  name: string;
  /** Fraction of the counted notes that have it, to two decimals. */
  share: number;
}

/** Counts how many notes each name appears in, keeping the first spelling seen. */
export class ShareCounter {
  private readonly counts = new Map<string, { name: string; notes: number }>();

  add(key: string, name: string): void {
    const entry = this.counts.get(key);
    if (entry) entry.notes += 1;
    else this.counts.set(key, { name, notes: 1 });
  }

  /** Names in at least `minShare` of `total` notes (and at least two notes), most common first. */
  top(total: number, minShare: number, limit: number): SharedCount[] {
    if (total === 0) return [];
    return [...this.counts.values()]
      .filter(entry => entry.notes >= 2 && entry.notes / total >= minShare)
      .sort((a, b) => b.notes - a.notes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, limit)
      .map(entry => ({ name: entry.name, share: Math.round((entry.notes / total) * 100) / 100 }));
  }
}
