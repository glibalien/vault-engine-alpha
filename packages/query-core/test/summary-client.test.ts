import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { makeClient } from '../src/client.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/summarize-nodes/${name}.json`, import.meta.url), 'utf8'));
it.each(['success', 'failure'])('preserves the summary %s envelope and dispatches the request unchanged', async name => {
  const request = fixture('request');
  const response = fixture(name);
  const client = makeClient(async call => {
    expect(call).toEqual({ name: 'summarize-nodes', arguments: request });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  });
  expect(await client.summarizeNodes(request)).toEqual(response);
});


it('preserves percentage components and effective calendar context',async()=>{
 const request=fixture('percentage-dates-request'), response=fixture('percentage-dates-success');
 const client=makeClient(async call=>{expect(call).toEqual({name:'summarize-nodes',arguments:request});return {content:[{type:'text',text:JSON.stringify(response)}]};});
 expect(await client.summarizeNodes(request)).toEqual(response);
});
it('forwards nested population and percentage filters without flattening',async()=>{
 const request=fixture('percentage-dates-request'),response=fixture('percentage-dates-success');
 request.filter={where:{any:[{types:['project']},{title_eq:'A'}]}};
 request.relations[0].filter={where:{any:[{fields:{status:{eq:'open'}}},{fields:{estimate:{gt:1}}}]}};
 const client=makeClient(async call=>{expect(call.arguments).toEqual(request);return {content:[{type:'text',text:JSON.stringify(response)}]};});
 expect(await client.summarizeNodes(request)).toEqual(response);
});
