import { describe, expect, it } from 'vitest';
import { marked, type Token, type Tokens } from 'marked';
import { moveCalloutTextToBody, renderHomeItems, renderHomeSections } from '../src/home-items.js';
import { HOME_SECTIONS_SCHEMA, HOME_SECTIONS_TOOL } from '../src/prompts/page.js';
import { synthesizeHomeOverview } from '../src/page-synthesis.js';
import type { LlmClient } from '../src/llm/types.js';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

function blocks(markdown: string): Token[] {
  return marked.lexer(markdown).filter(token => token.type !== 'space');
}

describe('moveCalloutTextToBody', () => {
  it('moves the text of a callout with nothing under it into the body', () => {
    expect(moveCalloutTextToBody('> [!summary] The whole summary sentence is here.'))
      .toBe('> [!summary]\n> The whole summary sentence is here.');
  });

  it('leaves a real title with a body under it', () => {
    const titled = '> [!warning] Renewal at risk\n> The contract lapses on Friday.';
    expect(moveCalloutTextToBody(titled)).toBe(titled);
    const spaced = '> [!warning] Renewal at risk\n>\n> The contract lapses on Friday.';
    expect(moveCalloutTextToBody(spaced)).toBe(spaced);
  });

  it('leaves the expected form and a blockquote that is not a callout', () => {
    const expected = '> [!summary]\n> The summary.';
    expect(moveCalloutTextToBody(expected)).toBe(expected);
    expect(moveCalloutTextToBody('> Someone said [!summary] once.')).toBe('> Someone said [!summary] once.');
  });

  it('keeps the fold marker and the nesting', () => {
    expect(moveCalloutTextToBody('> [!note]- Folded text')).toBe('> [!note]-\n> Folded text');
    expect(moveCalloutTextToBody('> > [!note] Nested text')).toBe('> > [!note]\n> > Nested text');
  });

  it('counts a blank quoted line as no body', () => {
    expect(moveCalloutTextToBody('> [!summary] The summary.\n>\n\nA paragraph.'))
      .toBe('> [!summary]\n> The summary.\n>\n\nA paragraph.');
  });

  it('fixes each callout in a section and leaves code fences alone', () => {
    const fenced = '```\n> [!summary] An example of the syntax\n```';
    expect(moveCalloutTextToBody(`${fenced}\n\n> [!note] Real one`))
      .toBe(`${fenced}\n\n> [!note]\n> Real one`);
  });

  it('stays inside a fence until a matching one closes it', () => {
    const example = '> [!summary] Literal example';
    const longer = `\`\`\`\`md\n\`\`\`\n${example}\n\`\`\`\n${example}\n\`\`\`\``;
    expect(moveCalloutTextToBody(longer)).toBe(longer);
    const mixed = `\`\`\`\n~~~\n${example}\n\`\`\``;
    expect(moveCalloutTextToBody(mixed)).toBe(mixed);
    const withInfo = `\`\`\`\n\`\`\`js\n${example}\n\`\`\``;
    expect(moveCalloutTextToBody(withInfo)).toBe(withInfo);
  });

  it('leaves a quoted fence inside a code block alone', () => {
    const fenced = '```md\n> ```\n> [!summary] Literal example\n\n```';
    expect(moveCalloutTextToBody(fenced)).toBe(fenced);
    const inQuote = '> ```\n> > [!summary] Literal example\n> ```';
    expect(moveCalloutTextToBody(inQuote)).toBe(inQuote);
  });

  it('leaves a callout in a list item alone', () => {
    const listed = '- Item\n\n  > [!note] Text';
    expect(moveCalloutTextToBody(listed)).toBe(listed);
  });

  it('keeps the text around a fixed callout byte for byte', () => {
    expect(moveCalloutTextToBody('Intro  \n\n\n> [!note] Text\n\n* a\n* b\n'))
      .toBe('Intro  \n\n\n> [!note]\n> Text\n\n* a\n* b\n');
  });

  it('leaves an indented code block alone', () => {
    for (const code of [
      'Example:\n\n    > [!summary] Literal example',
      'Example:\n\n\t> [!summary] Literal example',
      '>     > [!summary] Literal example',
    ]) {
      expect(moveCalloutTextToBody(code)).toBe(code);
    }
  });

  it('allows up to three spaces of indent', () => {
    expect(moveCalloutTextToBody('   > [!note] Text')).toBe('   > [!note]\n   > Text');
    expect(moveCalloutTextToBody('>   [!note] Text')).toBe('>   [!note]\n>   Text');
  });

  it('does not open a fence on an indented code line', () => {
    expect(moveCalloutTextToBody('    ```\n\n> [!note] Real one')).toBe('    ```\n\n> [!note]\n> Real one');
  });

  it('resumes after a closing fence', () => {
    expect(moveCalloutTextToBody('```js\ncode\n```\n\n> [!note] After'))
      .toBe('```js\ncode\n```\n\n> [!note]\n> After');
  });

  it('parses as a quote holding the text, not a long first line with no body', () => {
    const [quote] = blocks(moveCalloutTextToBody('> [!summary] The summary.')) as [Tokens.Blockquote];
    expect(quote.type).toBe('blockquote');
    expect(quote.text).toBe('[!summary]\nThe summary.');
  });
});

describe('renderHomeSections callouts', () => {
  const output = {
    now: '> [!summary] Now text.',
    focus: [{ title: 'Short warning', callout: 'warning' as const }],
    open_threads: [{ title: 'A thread' }],
    log_entry: '> [!note] Log text.',
    at_a_glance: '> [!summary] Glance text.',
    sources: '> [!note] Sources text.',
  };

  it('normalizes every free-markdown section', () => {
    const sections = renderHomeSections(output);
    expect(sections.at_a_glance).toBe('> [!summary]\n> Glance text.');
    expect(sections.now).toBe('> [!summary]\n> Now text.');
    expect(sections.sources).toBe('> [!note]\n> Sources text.');
    expect(sections.log_entry).toBe('> [!note]\n> Log text.');
  });

  it('leaves item callouts, whose title is laid out in code', () => {
    expect(renderHomeSections(output).focus).toBe('> [!warning] Short warning');
  });

  it('adds no optional section the model left out', () => {
    const { at_a_glance: _glance, sources: _sources, ...required } = output;
    const sections = renderHomeSections(required);
    expect('at_a_glance' in sections).toBe(false);
    expect('sources' in sections).toBe(false);
  });
});

describe('renderHomeItems', () => {
  it('puts every focus item on its own task line, whatever whitespace the model wrote', () => {
    // A project home merged its items with two spaces instead of newlines.
    const markdown = renderHomeItems([
      { title: 'Decide between sample data and live data', detail: 'Due today —\n gates the  Acme analysis.' },
      { title: 'Get Jordan to enable Sam/Riley on the pilot demo', detail: 'Due 10/29.' },
      { title: 'Talk with Morgan about rollout readiness' },
    ], true);

    expect(markdown).toBe([
      '- [ ] **Decide between sample data and live data** — Due today — gates the Acme analysis.',
      '- [ ] **Get Jordan to enable Sam/Riley on the pilot demo** — Due 10/29.',
      '- [ ] **Talk with Morgan about rollout readiness**',
    ].join('\n'));
    const [list] = blocks(markdown) as [Tokens.List];
    expect(list.type).toBe('list');
    expect(list.items.map(item => item.task)).toEqual([true, true, true]);
  });

  it('renders a callout item as its own block between the plain items', () => {
    const markdown = renderHomeItems([
      { title: 'Controls parity', detail: 'No answer yet; questionnaire due at month-end.', callout: 'warning' },
      { title: 'Pilot agreement still open' },
      { title: 'Selection timeline unknown' },
      { title: 'Pricing model', callout: 'question' },
    ], false);

    expect(markdown).toBe([
      '> [!warning] Controls parity\n> No answer yet; questionnaire due at month-end.',
      '- **Pilot agreement still open**\n- **Selection timeline unknown**',
      '> [!question] Pricing model',
    ].join('\n\n'));
    expect(blocks(markdown).map(token => token.type)).toEqual(['blockquote', 'list', 'blockquote']);
    expect((blocks(markdown)[1] as Tokens.List).items).toHaveLength(2);
  });

  it('removes layout the model wrote into a title and a leading dash from the detail', () => {
    expect(renderHomeItems([{ title: '- [ ] **Ship the deck**', detail: '— before Friday.' }], true))
      .toBe('- [ ] **Ship the deck** — before Friday.');
    expect(renderHomeItems([{ title: 'Ship **the** deck', detail: '   ' }], false)).toBe('- **Ship the deck**');
  });

  it('rejects an item whose title is only layout', () => {
    expect(() => renderHomeItems([{ title: '- [ ] ****' }], true)).toThrow(/empty title/);
  });
});

describe('home sections schema', () => {
  it('asks for item arrays with a closed set of callout types', () => {
    const schema = HOME_SECTIONS_TOOL.schema as { properties: Record<string, { type?: string; items?: {
      properties: Record<string, { enum?: string[] }>; required: string[] } }> };
    expect(schema.properties.focus?.type).toBe('array');
    expect(schema.properties.open_threads?.type).toBe('array');
    expect(schema.properties.focus?.items?.required).toEqual(['title']);
    expect(schema.properties.focus?.items?.properties.callout?.enum).toEqual(['note', 'question', 'warning', 'danger', 'success']);
  });

  it('normalizes a callout type and drops an unknown one instead of failing the home', () => {
    const parsed = HOME_SECTIONS_SCHEMA.parse({ now: 'n', log_entry: 'l',
      focus: [{ title: 'a', callout: ' Warning ' }, { title: 'b', callout: 'info' }, { title: 'c', callout: null }],
      open_threads: [{ title: 'o' }] });
    expect(parsed.focus).toEqual([{ title: 'a', callout: 'warning' }, { title: 'b' }, { title: 'c' }]);
  });

  it('rejects a section written as one Markdown string', () => {
    expect(HOME_SECTIONS_SCHEMA.safeParse({ now: 'n', focus: '- [ ] a  - [ ] b', open_threads: [{ title: 'o' }], log_entry: 'l' }).success)
      .toBe(false);
  });

  it('renders topic focus items without task checkboxes', () => {
    const sections = renderHomeSections({ now: 'n', log_entry: 'l', focus: [{ title: 'Aspect' }], open_threads: [{ title: 'Gap' }] }, false);
    expect(sections).toEqual({ now: 'n', log_entry: 'l', focus: '- **Aspect**', open_threads: '- **Gap**' });
  });
});

describe('synthesizeHomeOverview item layout', () => {
  function llmReturning(output: unknown): LlmClient {
    return { structuredCall: async () => ({ output, usage }) };
  }

  it('writes and validates the rendered Markdown', async () => {
    const home = await synthesizeHomeOverview(llmReturning({ now: 'Now', log_entry: 'Log',
      focus: [{ title: 'First', detail: 'Why.' }, { title: 'Second', callout: 'danger' }],
      open_threads: [{ title: 'Thread' }] }), { model: 'test', evidence: '', pageIndex: [] });

    expect(home.sections.focus).toBe('- [ ] **First** — Why.\n\n> [!danger] Second');
    expect(home.validatedSections.focus).toBe(home.sections.focus);
    expect(home.sections.open_threads).toBe('- **Thread**');
  });

  it('renders plain bullets when focus items are not tasks', async () => {
    const home = await synthesizeHomeOverview(llmReturning({ now: 'Now', log_entry: 'Log',
      focus: [{ title: 'Aspect' }], open_threads: [{ title: 'Gap' }] }), { model: 'test', evidence: '', pageIndex: [], focusTasks: false });
    expect(home.sections.focus).toBe('- **Aspect**');
  });

  it('fails as an invalid result when an item title is only layout', async () => {
    await expect(synthesizeHomeOverview(llmReturning({ now: 'Now', log_entry: 'Log',
      focus: [{ title: '- [ ]' }], open_threads: [{ title: 'Gap' }] }), { model: 'test', evidence: '', pageIndex: [] }))
      .rejects.toMatchObject({ name: 'PageSynthesisError', invalidResult: true, usage });
  });
});
