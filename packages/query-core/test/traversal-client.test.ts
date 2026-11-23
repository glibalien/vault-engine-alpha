import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { makeClient } from '../src/client.js';
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../tests/fixtures/traverse-nodes/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
it.each(['success', 'failure'])(
  'preserves the traversal %s envelope and dispatches the request unchanged',
  async (name) => {
    const request = fixture('request');
    const response = fixture(name);
    const client = makeClient(async (call) => {
      expect(call).toEqual({ name: 'traverse-nodes', arguments: request });
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    });
    expect(await client.traverseNodes(request)).toEqual(response);
  },
);
