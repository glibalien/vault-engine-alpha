import { describe, expect, it } from 'vitest';
import { EngineToolError, type EngineCall } from '../src/engine-client.js';
import { SORTING_REQUEST } from '../src/sorting.js';
import { summarizeSurvey, untypedSummary, type Survey } from '../src/survey-summary.js';

type Shares = Record<string, number>;

/** One survey group; each feature list is given as `{ name: share }`. */
function group(id: number, notes: number, example: string, shared: {
  folders?: Shares; titles?: Shares; lines?: Shares; headings?: Shares; fields?: Shares;
}): Survey['groups'][number] {
  const list = (shares: Shares = {}) => Object.entries(shares).map(([name, share]) => ({ name, share }));
  return {
    group: id,
    notes,
    samples: [{ title: example }],
    shared: {
      folders: list(shared.folders),
      title_patterns: list(shared.titles),
      label_lines: list(shared.lines),
      headings: list(shared.headings),
      fields: list(shared.fields),
    },
  };
}

function survey(groups: Survey['groups'], extra: { ungrouped?: number; notIndexed?: number; truncated?: boolean } = {}): Survey {
  const grouped = groups.reduce((sum, entry) => sum + entry.notes, 0) + (extra.ungrouped ?? 0);
  return {
    scope: { notes: grouped + (extra.notIndexed ?? 0), surveyed: grouped, not_indexed: extra.notIndexed ?? 0, truncated: extra.truncated ?? false },
    groups,
    ungrouped: { notes: extra.ungrouped ?? 0 },
  };
}

const MEETING = { 'Attendees': 1, 'Company': 1, 'Date': 1 };
const BOOK = { 'Author': 1, 'Finished': 1, 'Rating': 1 };

describe('summarizeSurvey', () => {
  it('lists one kind once, though the survey split it by the app it came from', () => {
    const lines = summarizeSurvey(survey([
      group(1, 20, 'Northwind sync on pricing', { folders: { 'Evernote Export': 1 }, lines: MEETING }),
      group(2, 18, 'Signal and Tide notes', { folders: { 'Bear Notes': 1 }, lines: BOOK, headings: { Highlights: 0.9 } }),
      group(3, 12, 'Acme sync on rollout', { folders: { 'Bear Notes': 1 }, lines: MEETING, headings: { Discussion: 0.9 } }),
      group(4, 10, 'Small Engines notes', { folders: { Notion: 1 }, lines: BOOK }),
    ]), 'ready');

    expect(lines).toEqual([
      '60 notes have no kind. Grouped by how alike they are (no AI model), they share:',
      // The groups' folders differ, and a heading only one of them has is left out.
      '  32 notes: "Attendees:", "Company:" and "Date:" lines, e.g. "Northwind sync on pricing"',
      '  28 notes: "Author:", "Finished:" and "Rating:" lines, e.g. "Signal and Tide notes"',
      `To sort them, ask Claude Code: "${SORTING_REQUEST}"`,
    ]);
  });

  it('names only what sets a row apart, and joins rows that then read the same', () => {
    const lines = summarizeSurvey(survey([
      group(1, 600, 'Pricing review - 2030-04-02 - Update', {
        folders: { Notes: 1 }, titles: { '… <date> …': 0.99 }, fields: { date: 1, context: 0.96 },
      }),
      group(2, 400, 'Product charter', { folders: { Notes: 1 }, fields: { date: 1, project: 0.8 } }),
      group(3, 300, 'Weekly Summary 2030-03-03 to 2030-03-09', {
        folders: { 'Notes/Weekly Summaries': 1 }, titles: { '… <date> … <date>': 1 }, headings: { 'Threads to watch': 0.9 }, fields: { date: 1, tags: 1 },
      }),
      group(4, 250, 'Product roadmap', { folders: { Notes: 0.98 }, fields: { date: 1, project: 0.85 } }),
      group(5, 60, 'Weekly Summary 2029-05-06 to 2029-05-12', {
        folders: { 'Notes/Weekly Summaries': 1 }, titles: { '… <date> … <date>': 1 }, headings: { 'Threads to watch': 0.6 }, fields: { date: 1, tags: 1 },
      }),
      group(6, 340, 'Stray thought', { folders: { Notes: 1 }, fields: { date: 0.9 } }),
    ], { ungrouped: 50 }), 'ready');

    expect(lines).toEqual([
      '2,000 notes have no kind. Grouped by how alike they are (no AI model), they share:',
      // Groups 2 and 4 both read "field project" once the folder and date field most notes have are left out.
      '  650 notes: field project, e.g. "Product charter"',
      '  600 notes: titles like "… <date> …"; field context, e.g. "Pricing review - 2030-04-02 - Update"',
      // Same title shape in the same folder: one row, with only what both groups have.
      '  360 notes: titles like "… <date> … <date>"; in Notes/Weekly Summaries/; field tags, e.g. "Weekly Summary 2030-03-03 to 2030-03-09"',
      '  390 notes with nothing that sets them apart',
      `To sort them, ask Claude Code: "${SORTING_REQUEST}"`,
    ]);
  });

  it('reads a label or heading the same whatever its case, and shows the first spelling', () => {
    const lines = summarizeSurvey(survey([
      group(1, 20, 'Northwind sync', { lines: { Attendees: 1, Date: 1 } }),
      group(2, 15, 'Acme sync', { lines: { attendees: 1, date: 1 } }),
      group(3, 40, 'Journal one', { lines: { Date: 1, Mood: 1 }, headings: { Thoughts: 1 } }),
      group(4, 50, 'Journal two', { lines: { date: 0.9, Weather: 1 }, headings: { thoughts: 1 } }),
    ]), 'ready');

    // "Date:" is on nearly every note and "Thoughts" on every journal, so neither sets a row apart.
    expect(lines.slice(1, -1)).toEqual([
      '  50 notes: "Weather:" line, e.g. "Journal two"',
      '  40 notes: "Mood:" line, e.g. "Journal one"',
      '  35 notes: "Attendees:" line, e.g. "Northwind sync"',
    ]);
  });

  it('joins groups by title shape only in the same folder', () => {
    const spread = { 'Evernote Export': 0.5, 'Bear Notes': 0.5 };
    const lines = summarizeSurvey(survey([
      group(1, 30, '2030-01-02 Planning', { folders: spread, titles: { '<date> …': 1 }, headings: { Discussion: 0.9 } }),
      group(2, 30, '2030-01-03 Evening', { folders: spread, titles: { '<date> …': 1 }, headings: { Reflection: 0.9 } }),
    ]), 'ready');

    expect(lines.slice(1, -1)).toEqual([
      '  30 notes: heading "Discussion", e.g. "2030-01-02 Planning"',
      '  30 notes: heading "Reflection", e.g. "2030-01-03 Evening"',
    ]);
  });

  it('counts the rows past the sixth on one line', () => {
    const labels = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
    const lines = summarizeSurvey(survey(labels.map((label, index) => group(index + 1, 20 - index, `${label} note`, { lines: { [label]: 1 } }))), 'ready');

    expect(lines).toHaveLength(9);
    expect(lines[6]).toBe('  15 notes: "Foxtrot:" line, e.g. "Foxtrot note"');
    expect(lines[7]).toBe('  27 notes in 2 smaller groups');
  });

  it('says the top folder in words', () => {
    const lines = summarizeSurvey(survey([
      group(1, 30, 'Loose idea', { folders: { '/': 1 } }),
      group(2, 30, 'Filed idea', { folders: { Archive: 1 } }),
    ]), 'ready');

    expect(lines.slice(1, 3)).toEqual(['  30 notes: in the top folder, e.g. "Loose idea"', '  30 notes: in Archive/, e.g. "Filed idea"']);
  });

  it('says so when no group stands out, and what it left out', () => {
    const lines = summarizeSurvey(survey([
      group(1, 30, 'One thing', { folders: { Notes: 1 } }),
      group(2, 30, 'Another thing', { folders: { Notes: 1 } }),
    ], { notIndexed: 4, truncated: true }), 'ready');

    expect(lines).toEqual([
      '64 notes have no kind. Grouped by how alike they are (no AI model), no group shares anything that sets it apart.',
      '  4 notes not in the search index are left out.',
      '  Only the first 60 were surveyed.',
      `To sort them, ask Claude Code: "${SORTING_REQUEST}"`,
    ]);
  });

  it('waits for search, and says when semantic search is off', () => {
    const embedding = survey([group(1, 12, 'Half done', { lines: MEETING })], { notIndexed: 30 });
    const off = { scope: { notes: 40, surveyed: 0, not_indexed: 40, truncated: false }, groups: [], ungrouped: { notes: 0 } };

    expect(summarizeSurvey(embedding, 'indexing')[0]).toBe('42 notes have no kind. What they have in common is listed here once search has embedded them.');
    expect(summarizeSurvey(off, 'indexing')[0]).toBe('40 notes have no kind. What they have in common is listed here once search has embedded them.');
    expect(summarizeSurvey(off, 'disabled')[0]).toBe('40 notes have no kind. Listing what they have in common needs semantic search, which is off.');
  });

  it('prints nothing for fewer than ten notes with no kind', () => {
    expect(summarizeSurvey(survey([group(1, 9, 'Few', { lines: MEETING })]), 'ready')).toEqual([]);
  });
});

describe('untypedSummary', () => {
  it('reads the index state, then surveys with a long wait', async () => {
    const calls: Array<{ tool: string; args?: Record<string, unknown>; options?: unknown }> = [];
    const call: EngineCall = async <T>(tool: string, args?: Record<string, unknown>, options?: unknown): Promise<T> => {
      calls.push({ tool, args, options });
      if (tool === 'vault-stats') return { search_index: { status: 'ready' } } as T;
      return survey([group(1, 12, 'Northwind sync', { lines: MEETING })]) as T;
    };

    expect((await untypedSummary(call))[1]).toBe('  12 notes: "Attendees:", "Company:" and "Date:" lines, e.g. "Northwind sync"');
    expect(calls.map(entry => entry.tool)).toEqual(['vault-stats', 'survey-nodes']);
    expect(calls[1]).toEqual({ tool: 'survey-nodes', args: {}, options: { timeoutMs: 300_000 } });
  });

  it('is one line when the survey fails', async () => {
    const call: EngineCall = async <T>(tool: string): Promise<T> => {
      if (tool === 'vault-stats') return { search_index: { status: 'ready' } } as T;
      throw new EngineToolError('INTERNAL_ERROR', 'survey-nodes failed: Unable to survey notes.');
    };

    expect(await untypedSummary(call)).toEqual(['Notes with no kind could not be surveyed: survey-nodes failed: Unable to survey notes.']);
  });
});
