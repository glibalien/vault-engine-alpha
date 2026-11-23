import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { makeClient } from '../src/client.js';
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../tests/fixtures/read-rollups/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
it.each(['success', 'failure'])(
  'preserves the rollup %s envelope and dispatches the request unchanged',
  async (name) => {
    const request = fixture('request');
    const response = fixture(name);
    const client = makeClient(async (call) => {
      expect(call).toEqual({ name: 'read-rollups', arguments: request });
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    });
    expect(await client.readRollups(request)).toEqual(response);
  },
);

it('opts into typed discovery while preserving the default describe call', async () => {
  const response = fixture('discovery'),
    calls: unknown[] = [];
  const client = makeClient(async (call) => {
    calls.push(call);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  });
  expect(
    await client.describeSchema('project', ['relationship_views']),
  ).toEqual(response);
  await client.describeSchema('project');
  expect(calls).toEqual([
    {
      name: 'describe-schema',
      arguments: { name: 'project', include: ['relationship_views'] },
    },
    { name: 'describe-schema', arguments: { name: 'project' } },
  ]);
});


it('preserves percentage components and effective calendar context',async()=>{
 const request=fixture('percentage-dates-request'), response=fixture('percentage-dates-success');
 const client=makeClient(async call=>{expect(call).toEqual({name:'read-rollups',arguments:request});return {content:[{type:'text',text:JSON.stringify(response)}]};});
 expect(await client.readRollups(request)).toEqual(response);
});
