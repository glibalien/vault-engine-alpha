import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SvgTextExtractor } from '../src/extraction/extractors/svg-text.js';
import { buildExtractors } from '../src/extraction/setup.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 've-svg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function svg(name: string, contents: string): string {
  const p = join(dir, name);
  writeFileSync(p, contents, 'utf-8');
  return p;
}

describe('SvgTextExtractor', () => {
  const ex = new SvgTextExtractor();

  it('extracts title, desc and text element content', async () => {
    const p = svg('a.svg', `<svg xmlns="http://www.w3.org/2000/svg"><title>Architecture</title><desc>System diagram</desc><text x="0" y="0">Frontend</text><text>Backend</text></svg>`);
    const r = await ex.extract(p);
    expect(r.text).toBe('Architecture\nSystem diagram\nFrontend\nBackend');
  });

  it('flattens nested tspans and collapses whitespace', async () => {
    const p = svg('b.svg', `<svg><text><tspan>Hello</tspan>\n  <tspan>World</tspan></text></svg>`);
    const r = await ex.extract(p);
    expect(r.text).toBe('Hello World');
  });

  it('decodes XML entities', async () => {
    const p = svg('c.svg', `<svg><title>A &amp; B &lt;tag&gt; &#65;</title></svg>`);
    const r = await ex.extract(p);
    expect(r.text).toBe('A & B <tag> A');
  });

  it('returns empty text for an SVG with no text elements (no throw)', async () => {
    const p = svg('d.svg', `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`);
    const r = await ex.extract(p);
    expect(r.text).toBe('');
  });

  it('does not throw on malformed SVG', async () => {
    const p = svg('e.svg', `<svg><title>unclosed`);
    const r = await ex.extract(p);
    expect(r.text).toBe('');
  });

  it('is registered always-on for .svg (no API key needed)', () => {
    const { registry } = buildExtractors({});
    expect(registry.getForExtension('.svg')?.id).toBe('svg-text');
    expect(registry.getUnavailableReason('.svg')).toBeNull();
  });
});
