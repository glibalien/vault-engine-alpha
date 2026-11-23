import { describe, it, expect } from 'vitest';
import { parseFrontmatter, parseFrontmatterMapping, splitFrontmatter } from '../../src/parser/frontmatter.js';
import { parseMarkdown } from '../../src/parser/parse.js';

describe('parseFrontmatter', () => {
  describe('types array filtering', () => {
    it('filters out mappings from types array, and keeps a number or boolean as its text (#482)', () => {
      const raw = '---\ntypes:\n  - meeting\n  - date: 2026-04-13\n  - true\n  - 42\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual(['meeting', 'true', '42']);
    });

    it('strips [[wikilink]] brackets from type strings', () => {
      const raw = '---\ntypes:\n  - "[[person]]"\n  - meeting\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual(['person', 'meeting']);
    });

    it('strips [[wikilink]] brackets from scalar type string', () => {
      const raw = '---\ntypes: "[[person]]"\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual(['person']);
    });

    it('handles types array with only non-string elements', () => {
      const raw = '---\ntypes:\n  - date: 2026-04-13\n  - status: active\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual([]);
    });
  });

  describe('unquoted wikilink handling', () => {
    it('extracts wikilink from quoted [[target]] string', () => {
      const raw = '---\nband: "[[The Police]]"\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('band')).toBe('The Police');
      expect(result.wikiLinks).toEqual([
        { target: 'The Police', alias: null, context: 'band' },
      ]);
    });

    it('detects unquoted [[target]] (YAML nested array) as a wikilink', () => {
      // YAML parses unquoted [[The Police]] as flow notation → [["The Police"]]
      const raw = '---\nband: [[The Police]]\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('band')).toBe('The Police');
      expect(result.wikiLinks).toEqual([
        { target: 'The Police', alias: null, context: 'band' },
      ]);
    });

    it('detects unquoted date-like wikilink [[2023-09-09]]', () => {
      const raw = '---\ndate: [[2023-09-09]]\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('date')).toBe('2023-09-09');
      expect(result.wikiLinks).toEqual([
        { target: '2023-09-09', alias: null, context: 'date' },
      ]);
    });

    it('still handles normal arrays without false-positive wikilink detection', () => {
      const raw = '---\ntags:\n  - music\n  - rock\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('tags')).toEqual(['music', 'rock']);
      expect(result.wikiLinks).toEqual([]);
    });
  });
});

describe('parseFrontmatterMapping', () => {
  it('returns every top-level key without assigning types semantics', () => {
    const parsed = parseFrontmatterMapping('---\nkind: meeting\ntypes: legacy\ncount: 3\n---\nBody\n');
    expect(parsed).toMatchObject({ hasFrontmatter: true, parseError: null, body: 'Body\n' });
    expect(parsed.data).toEqual({ kind: 'meeting', types: 'legacy', count: 3 });
  });

  it('distinguishes missing, empty, malformed, and non-mapping frontmatter', () => {
    expect(parseFrontmatterMapping('Body').hasFrontmatter).toBe(false);
    expect(parseFrontmatterMapping('---\n---\n').data).toEqual({});
    expect(parseFrontmatterMapping('---\nkey: [\n---\n').parseError).toEqual(expect.any(String));
    expect(parseFrontmatterMapping('---\n- one\n---\n').parseError)
      .toBe('Frontmatter is not a YAML mapping');
  });

  it('keeps duplicate-key compatibility while returning the final value', () => {
    const parsed = parseFrontmatterMapping('---\nkind: note\nkind: project\n---\n');
    expect(parsed.data).toEqual({ kind: 'project' });
  });
});

describe('CRLF line endings and a leading BOM (#261)', () => {
  const lf = '---\ntypes: meeting\npeople: ["[[A]]", "[[B]]"]\n---\nbody\n';
  const crlf = lf.replaceAll('\n', '\r\n');
  const BOM = '\uFEFF';

  it('parses CRLF frontmatter whose last line is a flow list', () => {
    const result = parseFrontmatterMapping(crlf);
    expect(result).toMatchObject({ hasFrontmatter: true, parseError: null, data: { types: 'meeting', people: ['[[A]]', '[[B]]'] } });
    expect(result.body).toBe('body\r\n');
  });

  it('parses a CRLF scalar last line without a stray carriage return', () => {
    const result = parseFrontmatterMapping('---\r\npeople: ["[[A]]"]\r\npriority: 1\r\n---\r\nbody\r\n');
    expect(result.data).toEqual({ people: ['[[A]]'], priority: 1 });
    const types = parseFrontmatter('---\r\ntypes: meeting\r\n---\r\n');
    expect(types.types).toEqual(['meeting']);
  });

  it('reads frontmatter after a byte-order mark, with LF or CRLF', () => {
    for (const raw of [BOM + '---\ntypes: task\nstatus: todo\n---\nbody\n', BOM + '---\r\ntypes: task\r\nstatus: todo\r\n---\r\nbody\r\n']) {
      const result = parseFrontmatterMapping(raw);
      expect(result).toMatchObject({ hasFrontmatter: true, parseError: null, data: { types: 'task', status: 'todo' } });
      expect(result.body.startsWith('body')).toBe(true);
    }
  });

  it('splits empty CRLF frontmatter', () => {
    expect(splitFrontmatter('---\r\n---\r\nbody')).toEqual({ yaml: '', body: 'body' });
  });

  it('drops a byte-order mark from a note without frontmatter', () => {
    expect(splitFrontmatter(BOM + '# Title\n')).toEqual({ yaml: null, body: '# Title\n' });
  });

  it('keeps LF splitting exactly as before', () => {
    expect(splitFrontmatter(lf)).toEqual({ yaml: 'types: meeting\npeople: ["[[A]]", "[[B]]"]', body: 'body\n' });
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ yaml: '', body: 'body' });
    expect(splitFrontmatter('---\ntypes: x\n')).toEqual({ yaml: null, body: '---\ntypes: x\n' });
    expect(splitFrontmatter('no frontmatter\n---\n')).toEqual({ yaml: null, body: 'no frontmatter\n---\n' });
  });

  it('a CRLF note parses to the same fields, links and body text as its LF twin', () => {
    const fromLf = parseMarkdown(lf, 'Meetings/Sync.md');
    const fromCrlf = parseMarkdown(BOM + crlf, 'Meetings/Sync.md');
    expect(fromCrlf.parseError).toBeNull();
    expect(fromCrlf.types).toEqual(fromLf.types);
    expect(Object.fromEntries(fromCrlf.fields)).toEqual(Object.fromEntries(fromLf.fields));
    expect(fromCrlf.wikiLinks).toEqual(fromLf.wikiLinks);
    expect(fromCrlf.body.replaceAll('\r\n', '\n')).toBe(fromLf.body);
  });
});
