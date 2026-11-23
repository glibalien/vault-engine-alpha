import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { makeTraversalDb } from '../helpers/traversal-fixture.js';
import { seedRel } from '../helpers/summary-fixture.js';
import { traverseNodes } from '../../src/traversal/service.js';
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../tests/fixtures/traverse-nodes/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
it('matches the frozen client fixture including nulls, absence and both warning scopes', () => {
  const db = makeTraversalDb([
    ['A', 'B'],
    ['B', 'C'],
  ]);
  try {
    seedRel(db, 'A', 'Missing', null, 'blockedBy');
    expect(
      JSON.parse(traverseNodes(db, fixture('request')).content[0].text),
    ).toEqual(fixture('success'));
  } finally {
    db.close();
  }
});
