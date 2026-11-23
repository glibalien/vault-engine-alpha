import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { assertPageMarkdown, pageNarrativeContext, unescapeWikilinkQuotes } from '../src/page-markdown.js';

describe('unescapeWikilinkQuotes', () => {
  it.each([
    ['[[Alex - Sam Enterprise \\"Demo\\"]]', '[[Alex - Sam Enterprise "Demo"]]'],
    ['[[A \\"B\\"|the \\"B\\" note]] and [[C \\\\\\"D\\\\\\"#Heading]]', '[[A "B"|the "B" note]] and [[C "D"#Heading]]'],
    ['| [[Note\\|alias]] | x |', '| [[Note\\|alias]] | x |'],
    ['He said \\"hi\\" about [[Plain]].', 'He said \\"hi\\" about [[Plain]].'],
    ['[[Unclosed \\"link\n\\"]]', '[[Unclosed \\"link\n\\"]]'],
  ])('%s', (input, expected) => {
    expect(unescapeWikilinkQuotes(input)).toBe(expected);
  });
});

describe('assertPageMarkdown', () => {
  it.each(['- | -', '-- | --', ':- | -:', ':--: | --:', '- | ---'])(
    'rejects collapsed tables with parser-supported short delimiters: %s', delimiter => {
      const table = `Name | Role\n${delimiter}\nAlex | Owner`;
      const collapsed = `Name | Role | ${delimiter} | Alex | Owner`;
      expect(marked.lexer(table)[0]?.type).toBe('table');
      expect(() => assertPageMarkdown(table)).not.toThrow();
      expect(() => assertPageMarkdown(collapsed)).toThrow(/collapsed Markdown table/);
      expect(() => assertPageMarkdown(`- ${collapsed}`)).toThrow(/collapsed Markdown table/);
      expect(() => assertPageMarkdown('`' + collapsed + '`')).not.toThrow();
      expect(() => assertPageMarkdown('```md\n' + collapsed + '\n```')).not.toThrow();
      expect(() => assertPageMarkdown(collapsed.replaceAll('|', '\\|'))).not.toThrow();
    },
  );

  it.each(['-', '--', ':-:'])(
    'preserves structural safeguards with short delimiters: %s', delimiter => {
      expect(() => assertPageMarkdown(`| Status || ${delimiter} || Open |`)).toThrow(/collapsed Markdown table/);
      expect(() => assertPageMarkdown(`Status | ${delimiter} | Open`)).not.toThrow();
      expect(() => assertPageMarkdown(`Name | Role | ${delimiter}`)).not.toThrow();
      expect(() => assertPageMarkdown(`Name | Role | ${delimiter} is a pause | ${delimiter} is another pause`)).not.toThrow();
    },
  );

  const formattedHeaders = [
    ['Name', '`Role`'], ['`Name | Alias`', 'Role\\*'],
    ['---', 'Status'], ['Name', '---'], ['---', '`Role`'], ['---', '---'],
  ];
  const collapsedCases = formattedHeaders.flatMap(header => [' | ', ' || '].flatMap(boundary =>
    ['', 'Alex', 'Alex | Owner'].flatMap(data => ['', '- '].map(prefix => ({
      body: `${prefix}| ${header.join(' | ')}${boundary}--- | ---${data === '' ? '' : boundary + data} |`,
    }))),
  ));
  it.each(collapsedCases)('rejects formatted/delimiter-shaped headers across row variants: $body', ({ body }) => {
    expect(() => assertPageMarkdown(body)).toThrow(/collapsed Markdown table/);
  });

  it.each(formattedHeaders.map(header => ({ header: header.join(' | ') })))(
    'preserves real tables and code examples with formatted headers: $header', ({ header }) => {
      const table = `| ${header} |\n| --- | --- |\n| Alex | Owner |`;
      const collapsed = `| ${header} || --- | --- || Alex | Owner |`;
      expect(() => assertPageMarkdown(table)).not.toThrow();
      expect(() => assertPageMarkdown('``' + collapsed + '``')).not.toThrow();
      expect(() => assertPageMarkdown('```md\n' + collapsed + '\n```')).not.toThrow();
    },
  );

  it.each([
    '- ', '> ', '- [ ] ', '> - ', '> # Nested heading',
    '- <!-- empty -->', '```\n\n```',
  ])('rejects empty narrative containers: %s', content => {
    expect(() => assertPageMarkdown(`# Timeline\n\n${content}`)).toThrow(/no narrative/);
  });

  it.each([
    'Summary **important**## Timeline', 'Summary *important* ## Timeline',
    'Summary [important](https://example.com)## Timeline',
    '- Summary **important**## Timeline', '> Summary **important**## Timeline',
    'Summary **important**# Timeline',
    'Summary text ## Timeline', 'Summary text# Timeline',
    '- Summary text ## Timeline', '- Summary text# Timeline',
    'Summary text. # Timeline', 'Summary text\t### Timeline',
  ])('rejects recognizable collapsed heading joins: %s', body => {
    expect(() => assertPageMarkdown(body)).toThrow(/collapsed Markdown headings/);
  });

  it.each([
    'Name | Role |--- | --- |Alex | Owner |',
    'Name | Role |--- | --- |Alex | Owner',
    '| Name | Role |--- | --- |Alex | Owner',
    '| Name | Role || --- | --- || Alex | Owner |',
    'Name | Role | :--- | ---: | Alex | Owner',
    'Name | Role | --- | ---',
    'Name | Role |--- | --- |Alex',
    '| Name | Role || --- | --- || Alex |',
    'Name | Role | Status |--- | --- | --- |Alex | Owner',
    '- Name | Role |--- | --- |Alex',
    '| Status || --- || Open |',
    '| Status || :---: || Open |',
    '| Status || --- |',
    '| Status || --- ||',
    '| || --- || Open |',
    '- | Status || --- || Open |',
    '**Name** | *Role* | --- | --- | Alex | Owner',
    '| Name | || --- | --- || Alex | Owner |',
    '| Name | | --- | --- | Alex | Owner |',
    '| | Role || --- | --- || Alex | Owner |',
    '| Name | | Role || --- | --- | --- || Alex | Active | Owner |',
    '| | || --- | --- || Alex | Owner |',
    '| Name | || --- | --- || | Owner |',
    '- Name | Role |--- | --- |Alex | Owner |',
    '1. Name | Role |--- | --- |Alex | Owner |',
    '- Outer\n  - Name | Role |--- | --- |Alex | Owner |',
    '> - Name | Role |--- | --- |Alex | Owner |',
  ])('rejects a collapsed table delimiter row: %s', body => {
    expect(() => assertPageMarkdown(body)).toThrow(/collapsed Markdown table rows/);
  });

  it.each([
    'Name | Role\n--- | ---\nAlex | Owner',
    'Name | Role\n--- | ---\nAlex',
    '| Name | Role |\n| --- | --- |\n| Alex |',
    'Use `Name | Role |--- | --- |Alex` as an example.',
    '| Status |\n| --- |\n| Open |',
    '| Status |\n| --- |',
    'Status | --- | Open',
    '| Status | --- | Open |',
    'Status || --- is a pause || Open',
    'Use `| Status || --- || Open |` as an example.',
    '```md\n| Status || --- || Open |\n```',
    '| Status \\|\\| --- \\|\\| Open |',
    '```md\nName | Role |--- | --- |Alex\n```',
    '| Name | Role |\n| :--- | ---: |\n| Alex | Owner |',
    'Alpha | Beta | --- is a pause | --- is another pause.',
    'Use pipes | --- | --- | for separators.',
    'Alpha | Beta | ---',
    'Name \\| Role \\|--- \\| --- \\|Alex \\| Owner \\|',
    '| Name | Role \\|\\| --- | --- | Alex | Owner |',
    '| Literal example: `| Name | Role || --- | --- || Alex | Owner |`',
    'Use `Name | Role |--- | --- |Alex | Owner |` as an example.',
    '```md\nName | Role |--- | --- |Alex | Owner |\n```',
    '```md\n| Name | Role || --- | --- || Alex | Owner |\n```',
    '| Name | |\n| --- | --- |\n| Alex | Owner |',
    '| | Role |\n| --- | --- |\n| Alex | Owner |',
    '| | |\n| --- | --- |\n| Alex | Owner |',
    'Use `| Name | || --- | --- || Alex | Owner |` as an example.',
    '```md\n| Name | || --- | --- || Alex | Owner |\n```',
    '- Use `Name | Role |--- | --- |Alex | Owner |` as an example.',
    '- Name \\| Role \\|--- \\| --- \\|Alex \\| Owner \\|',
    '- Example:\n\n  ```md\n  Name | Role |--- | --- |Alex | Owner |\n  ```',
    '- Name | Role\n  --- | ---\n  Alex | Owner',
    '| Example |\n| --- |\n| Name \\| Role \\|--- \\| --- \\|Alex \\| Owner \\| |',
  ])('preserves valid tables and literal pipe/dash content: %s', body => {
    expect(() => assertPageMarkdown(body)).not.toThrow();
  });

  it.each([
    '**Use** `text ## Heading` in examples.',
    '- **Use** `text# Heading` in examples.',
    '**Ordinary** text.\n\n## Timeline\n\nA real paragraph.',
    'The C# language is supported.', 'F# is also supported.',
    'Use # for a heading.', 'Discuss issue # 12.', 'The #team channel.',
    'Use `text# Heading` or `text ## Heading` in this example.',
    'Use \\#\\# Heading as literal text.',
    'Use \\### Heading as literal text.', '\\### Heading as literal text.',
    '- Use \\#### Heading as literal text.',
    'Use `##`### Heading as literal text.',
    '- Use `text ## Heading` in examples.', '- Use `text# Heading` in examples.',
    '- Use **C# language** in examples.',
    '- Use \\## Heading as literal text.',
    '- A real list item.', '> A real quote.', '- **Nested content.**',
    '```md\nSummary text ## Timeline\n```',
    '| Name | Role |\n| --- | --- |\n| Alex | Owner |',
  ])('preserves substantive content and legitimate hash notation: %s', body => {
    expect(() => assertPageMarkdown(`# Overview\n\n${body}`)).not.toThrow();
  });
});

describe('page log Markdown', () => {
  it.each(['Name | Role |--- | --- |Alex | Owner |', '- Name | Role |--- | --- |Alex | Owner |'])(
    'rejects collapsed tables in log notes: %s', log => {
      expect(() => assertPageMarkdown('Valid narrative.', log)).toThrow(/collapsed Markdown table/);
    },
  );
  it.each(['', ' ', '## Log', 'Updated.', '`Name | Role |--- | --- |Alex | Owner |`'])(
    'preserves permitted log content: %s', log => {
      expect(() => assertPageMarkdown('Valid narrative.', log)).not.toThrow();
    },
  );
});

describe('pageNarrativeContext', () => {
  it('accepts delimiter whitespace without treating it as name padding', () => {
    const body = '<!--\tve:managed:Summary\t-->\nNarrative.\n<!-- /ve:managed:Summary\n-->';
    expect(pageNarrativeContext(body)).toBe('Narrative.');
  });
});
