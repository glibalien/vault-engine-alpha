import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '../helpers/db.js';
import { fullIndex } from '../../src/indexer/indexer.js';

// #464: a first index used to scan the node table for each link to a note not
// indexed yet, so its time grew with the square of the note count. Generated
// notes (no real vault needed): eight links each, to random notes, some by
// another spelling or to nothing.
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function generate(notes: number): string {
  const vault = mkdtempSync(join(tmpdir(), 'first-index-growth-'));
  dirs.push(vault);
  let seed = notes;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const title = (i: number) => `Generated Note ${i}`;
  for (const dir of ['Notes', 'Meetings', 'People', 'Archive']) mkdirSync(join(vault, dir));
  for (let i = 0; i < notes; i++) {
    const links = Array.from({ length: 8 }, (_, k) => {
      const target = title(rand(notes));
      return k === 5 ? `[[${target.toLowerCase()}]]` : k === 6 ? `[[Missing ${rand(100)}]]` : `[[${target}]]`;
    });
    const dir = ['Notes', 'Meetings', 'People', 'Archive'][i % 4];
    writeFileSync(join(vault, dir, `${title(i)}.md`),
      `---\ntypes: [note]\nowner: "${links[0]}"\n---\n# ${title(i)}\n\n${'Generated text for a note body. '.repeat(20)}\n\n${links.slice(1).join(' and ')}\n`);
  }
  return vault;
}

function timeFirstIndex(notes: number): number {
  const vault = generate(notes);
  const db = createTestDb();
  const start = performance.now();
  const stats = fullIndex(vault, db);
  const elapsed = performance.now() - start;
  expect(stats).toMatchObject({ indexed: notes, errors: 0 });
  db.close();
  console.log(`First index of ${notes} generated notes: ${Math.round(elapsed)} ms (${Math.round(notes / (elapsed / 1000))} notes/s)`);
  return elapsed;
}

describe('first index growth', () => {
  it('grows about linearly with the note count', () => {
    timeFirstIndex(300); // warm-up: JIT and module loading
    const small = timeFirstIndex(1_000);
    const large = timeFirstIndex(4_000);
    // Linear is about 4x (4,000 notes in about 3 s on a desktop); one table scan
    // per link made it about 12x (31 s).
    expect(large / small).toBeLessThan(6);
  });
});
