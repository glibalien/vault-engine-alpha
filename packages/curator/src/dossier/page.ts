import { withRulesSection } from '../page-rules.js';
import type { DossierKind, DossierLineOutput } from '../prompts/dossier.js';
import type { Memory } from '../types.js';
import type { DossierRef } from './evidence.js';
import { isPastFact, pastFactEnd, pastFactStart } from './past.js';

/**
 * The dossier page as code writes it from the model's lines (#554). Each line becomes
 * `- text · since 2026-03-04 · [[Kickoff call]] <!-- memory:812 -->`: the day comes from the
 * newest memory it cites (a History line shows the bare day; a line citing only a meeting, the
 * meeting's day; a line citing only notes, the day the model read in one of them, when code finds
 * it there: `statedDay`) and the source from each cited memory's note ("from a chat" for a chat
 * memory) or each cited note. A line that cites nothing the build showed is dropped and counted.
 */

export interface DossierPageInput {
  readonly kind: DossierKind;
  /** The sections the model filled, in page order (#716). A section named History is sorted by day. */
  readonly sections: readonly string[];
  readonly lines: readonly DossierLineOutput[];
  readonly memories: ReadonlyMap<number, Memory>;
  readonly refs: ReadonlyMap<string, DossierRef>;
  /** Note titles by id, for a memory's source link. */
  readonly sourceTitles: ReadonlyMap<string, string>;
  readonly rules: readonly Memory[];
  readonly lastContact: { readonly title: string; readonly date: string } | null;
  /** With no last contact: how many of the newest linked meetings were read, when more exist. */
  readonly contactSearched?: number | null;
  /** The last-contact line broke a rule on what may be said (#721): the section is left out. */
  readonly contactWithheld?: boolean;
  /** The italic line at the top: when it was built and from how much. */
  readonly header: string;
  /** The day an ISO time falls on, as memory lines show it (`memoryDay`). */
  readonly day: (iso: string) => string;
  /** The build's local day: a day the model gives after it is not kept. */
  readonly today: string;
}

/** Why code left a model's line out. */
export type DossierDropReason = 'no_text' | 'unknown_section' | 'cites_nothing_shown' | 'past_outside_history';

const DROP_WORDS: Record<DossierDropReason, (n: number) => string> = {
  no_text: n => `${n} had no text`,
  unknown_section: n => `${n} named a section the page doesn't have`,
  cites_nothing_shown: n => `${n} cited no memory or note it was shown`,
  past_outside_history: n => `${n} put a past fact outside History`,
};

/** "6 cited no memory or note it was shown, 3 named a section the page doesn't have". */
export function droppedPhrase(why: Readonly<Partial<Record<DossierDropReason, number>>>): string {
  return (Object.keys(DROP_WORDS) as DossierDropReason[]).flatMap(reason => (why[reason] ?? 0) > 0 ? [DROP_WORDS[reason](why[reason]!)] : []).join(', ');
}

export interface DossierPage {
  readonly content: string;
  readonly kept: number;
  /** Lines left out: they cited nothing the build showed, had no text, or named no known section. */
  readonly dropped: number;
  /** The dropped lines by why (after a build on production dropped all of its 9 lines, 2026-11-21). */
  readonly droppedWhy: Readonly<Partial<Record<DossierDropReason, number>>>;
  /** The first few dropped lines as the model gave them, for the log. */
  readonly droppedExamples: ReadonlyArray<DossierLineOutput & { readonly reason: DossierDropReason }>;
  /** Kept lines that show no day: no memory, meeting or note gave one that code could confirm. */
  readonly undated: number;
}

/** A link to a note by its exact title. Titles are file names, so this resolves as Obsidian reads it. */
export function noteLink(title: string): string {
  return `[[${title}]]`;
}

/** The model's text as one clean line: no list marker, no section markers, dollar signs escaped. */
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/<!--|-->/g, '')
    .replace(/(?<!\\)\$/g, '\\$')
    .trim();
}

/** Where a memory came from, as its line shows it. */
function memorySource(memory: Memory, titles: ReadonlyMap<string, string>): string {
  if (memory.source === 'owner') return 'from you';
  if (memory.evidence_kind === 'conversation') return 'from a chat';
  if (memory.evidence_kind === 'curation-run') return 'from a wiki build';
  const title = memory.evidence_node_id ? titles.get(memory.evidence_node_id) : undefined;
  if (title) return noteLink(title);
  return 'from a note';
}

function memoryTime(memory: Memory): number {
  const ms = Date.parse(memory.valid_at ?? memory.created_at);
  return Number.isFinite(ms) ? ms : 0;
}

interface RenderedLine { readonly section: string; readonly line: string; readonly sortDay: string | null }

/** Short and common words, which say nothing about which entry of a note a line came from. */
const COMMON_WORDS = new Set(['about', 'after', 'again', 'also', 'been', 'before', 'being', 'both', 'does', 'from', 'have',
  'here', 'into', 'just', 'more', 'most', 'only', 'other', 'over', 'said', 'says', 'some', 'such', 'than', 'that', 'their',
  'them', 'then', 'there', 'they', 'this', 'those', 'very', 'were', 'what', 'when', 'where', 'which', 'while', 'will',
  'with', 'would', 'your', 'yours']);

/** The words of a text that can tie a line to an entry: four letters or more, not common. */
function telling(text: string, ignore: ReadonlySet<string>): Set<string> {
  const words = text.normalize('NFC').toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter(word => word.length >= 4 && !/^\d+$/.test(word) && !COMMON_WORDS.has(word) && !ignore.has(word)));
}

const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])\s/;

/** A line's indent in columns, a tab counting four. */
function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
}

/**
 * A note's entries: each list item with everything indented deeper than it (across blank lines
 * too, as in a loose list), and each paragraph; a heading stands alone. An item at the same indent
 * as the entry's first, or less, starts a new entry, however far the list itself is indented
 * (Codex, #713, twice). A timeline entry ("- **2026-11-04:**" and its sub-bullets) is one entry,
 * so every fact under a dated bullet shares its day.
 */
export function noteEntries(text: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  let blank = false;
  const close = (): void => { if (current.length > 0) entries.push(current.join('\n')); current = []; };
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') { blank = current.length > 0; continue; }
    if (/^#{1,6}\s/.test(raw)) { close(); entries.push(raw); blank = false; continue; }
    const base = current.length > 0 && LIST_ITEM.test(current[0]!) ? indentOf(current[0]!) : null;
    const nested = base !== null && indentOf(raw) > base;
    if (LIST_ITEM.test(raw) ? !nested : blank && !nested) close();
    else if (blank) current.push('');
    blank = false;
    current.push(raw);
  }
  close();
  return entries;
}

/**
 * Whether a day the model gave a line is in the entry of a note the fact came from: the entry that
 * best matches the line's telling words, a word counting for more the fewer entries hold it (a
 * name on every entry tells little), over the root of the entry's size. A day anywhere else in the
 * note is a real date on another fact: a side agent's point (2026-11-21), and the owner chose "same
 * entry only". On a real person's note with a 30-date timeline, "any entry holding the day that
 * shares words with the line" let 4 of 13 wrong days through; this let none through and left out
 * 1 of 14 right ones.
 */
export function dayInSameEntry(noteText: string, day: string, lineText: string, ignore: ReadonlySet<string> = new Set()): boolean {
  const lineWords = telling(lineText, ignore);
  if (lineWords.size === 0) return false;
  const entries = noteEntries(noteText).map(text => ({ text, words: telling(text, ignore) }));
  const holding = new Map<string, number>();
  for (const entry of entries) for (const word of entry.words) holding.set(word, (holding.get(word) ?? 0) + 1);
  const scores = entries.map(entry => {
    let score = 0;
    for (const word of lineWords) if (entry.words.has(word)) score += Math.log(1 + entries.length / holding.get(word)!);
    return entry.words.size === 0 ? 0 : score / Math.sqrt(entry.words.size);
  });
  const best = Math.max(0, ...scores);
  return best > 0 && entries.some((entry, index) => scores[index]! >= best - 1e-9 && entry.text.includes(day));
}

/** The day the model gave a line, when a note the line cites holds it: a meeting on that day, a
 *  note whose title has it, or the subject's own note with it in the same entry as the fact. */
function statedDay(line: DossierLineOutput, text: string, notes: readonly DossierRef[], input: LineInput): string | null {
  const day = line.day;
  if (day === undefined || day > input.today) return null;
  const subject = [...input.refs.values()].find(ref => ref.what === 'subject');
  const ignore = telling(subject?.title ?? '', new Set());
  return notes.some(note => note.date === day || note.title.includes(day)
    || (note.text !== undefined && dayInSameEntry(note.text, day, text, ignore))) ? day : null;
}

/** What rendering one line needs. */
export type DossierLineInput = Pick<DossierPageInput, 'kind' | 'sections' | 'memories' | 'refs' | 'sourceTitles' | 'day' | 'today'>;
type LineInput = DossierLineInput;

function renderLine(line: DossierLineOutput, input: LineInput): RenderedLine | DossierDropReason {
  const section = input.sections.find(name => name.toLowerCase() === line.section.toLowerCase());
  const text = cleanText(line.text);
  if (text === '') return 'no_text';
  if (!section) return 'unknown_section';
  const memories = [...new Set(line.memory_ids)].flatMap(id => input.memories.get(id) ?? []);
  const notes = [...new Set(line.note_ids)].flatMap(ref => input.refs.get(ref) ?? []);
  if (memories.length === 0 && notes.length === 0) return 'cites_nothing_shown';
  // A past fact (#717) is never written as present: only in History, and a line resting on past
  // facts alone shows the days it was true.
  const past = memories.filter(isPastFact);
  if (past.length > 0 && section.toLowerCase() !== 'history') return 'past_outside_history';
  if (past.length > 0 && past.length === memories.length) {
    const last = past.reduce((a, b) => (pastFactEnd(b) ?? '') > (pastFactEnd(a) ?? '') ? b : a);
    const end = pastFactEnd(last);
    // Only the days the memory knows (owner, 2026-11-21): a start the vault only recorded is left
    // out, and so is one after the end, which no change has.
    const startAt = pastFactStart(last);
    const from = startAt ? input.day(startAt) : null;
    const to = end ? input.day(end) : null;
    const when = from && to && from < to ? `${from} to ${to}` : to ? `until ${to}` : from;
    const sources = [...new Set([...memories.map(memory => memorySource(memory, input.sourceTitles)), ...notes.map(note => noteLink(note.title))])];
    const markers = [...new Set(memories.map(memory => memory.id))].sort((a, b) => a - b).map(id => `<!-- memory:${id} -->`);
    const parts = [text, ...(when ? [when] : []), ...(sources.length > 0 ? [sources.join(', ')] : [])];
    return { section, line: `- ${parts.join(' · ')} ${markers.join(' ')}`, sortDay: to ?? from };
  }
  const newest = memories.length > 0 ? memories.reduce((a, b) => memoryTime(b) > memoryTime(a) ? b : a) : null;
  const memoryDayText = newest ? input.day(newest.valid_at ?? newest.created_at) : null;
  const meetingDay = notes.map(note => note.date).filter((date): date is string => date !== null).sort().at(-1) ?? null;
  const noteDay = memoryDayText === null && meetingDay === null ? statedDay(line, text, notes, input) : null;
  const trueSince = memoryDayText ?? noteDay;
  const sortDay = trueSince ?? meetingDay;
  const when = trueSince !== null ? (section === 'History' ? trueSince : `since ${trueSince}`) : meetingDay;
  const sources = [...new Set([...memories.map(memory => memorySource(memory, input.sourceTitles)), ...notes.map(note => noteLink(note.title))])];
  const markers = [...new Set(memories.map(memory => memory.id))].sort((a, b) => a - b).map(id => `<!-- memory:${id} -->`);
  const parts = [text, ...(when ? [when] : []), ...(sources.length > 0 ? [sources.join(', ')] : [])];
  return { section, line: `- ${parts.join(' · ')}${markers.length > 0 ? ` ${markers.join(' ')}` : ''}`, sortDay };
}

/** The "Last contact" line for a meeting: code's, so the rule check reads it with the model's lines. */
export function lastContactLine(contact: { readonly title: string; readonly date: string }): string {
  return `- ${noteLink(contact.title)} · ${contact.date}`;
}

/** What "Last contact" says when there is none: how far it looked, when it could not look at all. */
export function noContactLine(kind: DossierKind, searched: number | null = null): string {
  if (searched !== null) {
    return kind === 'person' ? `- None of the ${searched} newest meetings that link to them lists them as attending.`
      : `- None of the ${searched} newest meetings that link to it lists someone from it as attending.`;
  }
  return kind === 'person' ? '- No past meeting they attended is on record.'
    : '- No past meeting attended by someone from it is on record.';
}

/**
 * Each line as the page will write it, day and sources included, with the index of the model line
 * it came from; a line the page leaves out (it cites nothing the build showed) is not listed. The
 * rule check reads these (Codex, #729): code adds the day and the sources after the model, and a
 * rule may forbid either.
 */
export function renderDossierLines(input: LineInput & { readonly lines: readonly DossierLineOutput[] }):
  Array<{ readonly index: number; readonly section: string; readonly line: string }> {
  return input.lines.flatMap((line, index) => {
    const done = renderLine(line, input);
    return typeof done === 'string' ? [] : [{ index, section: done.section, line: done.line }];
  });
}

export function renderDossierPage(input: DossierPageInput): DossierPage {
  const rendered: RenderedLine[] = [];
  let dropped = 0;
  const droppedWhy: Partial<Record<DossierDropReason, number>> = {};
  const droppedExamples: Array<DossierLineOutput & { reason: DossierDropReason }> = [];
  for (const line of input.lines) {
    const done = renderLine(line, input);
    if (typeof done !== 'string') { rendered.push(done); continue; }
    dropped++;
    droppedWhy[done] = (droppedWhy[done] ?? 0) + 1;
    if (droppedExamples.length < 3) droppedExamples.push({ ...line, reason: done });
  }
  const blocks: string[] = [input.header];
  for (const section of input.sections) {
    let lines = rendered.filter(line => line.section === section);
    if (section === 'History') {
      // Newest first by the day each line shows; undated lines keep their order, after the dated.
      lines = [...lines].map((line, index) => ({ line, index }))
        .sort((a, b) => (b.line.sortDay ?? '').localeCompare(a.line.sortDay ?? '') || a.index - b.index)
        .map(({ line }) => line);
    }
    if (lines.length > 0) blocks.push(`## ${section}\n\n${lines.map(line => line.line).join('\n')}`);
  }
  if (!input.contactWithheld) {
    blocks.push(`## Last contact\n\n${input.lastContact ? lastContactLine(input.lastContact) : noContactLine(input.kind, input.contactSearched ?? null)}`);
  }
  return { content: withRulesSection(blocks.join('\n\n'), input.rules), kept: rendered.length, dropped, droppedWhy, droppedExamples,
    undated: rendered.filter(line => line.sortDay === null).length };
}
