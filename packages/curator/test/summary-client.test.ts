import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Engine, type EngineClientFactory } from '../src/engine.js';
import type { Config } from '../src/config.js';
const config = { engineUrl: 'http://localhost:3334', engineToken: 't' } as Config;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/summarize-nodes/${name}.json`, import.meta.url), 'utf8'));
function setup(response: unknown, transportFailure = false) {
  let calls = 0, builds = 0;
  const request = fixture('request');
  const factory: EngineClientFactory = () => {
    builds++;
    return { transport: { close: async () => {} }, client: {
      connect: async () => {},
      callTool: async call => {
        calls++;
        expect(call).toEqual({ name: 'summarize-nodes', arguments: request });
        if (transportFailure && calls === 1) throw new Error('transport closed');
        return { content: [{ type: 'text', text: JSON.stringify(response) }] };
      },
    } };
  };
  return { engine: new Engine(config, factory), request, counts: () => ({ calls, builds }) };
}
it('preserves data, explicit nulls, absent fields and both warnings', async () => {
  const response = fixture('success');
  const { engine, request } = setup(response);
  expect(await engine.summarizeNodes(request)).toEqual({ data: response.data, warnings: response.warnings });
  await engine.close();
});
it('preserves error details without retrying domain failures', async () => {
  const response = fixture('failure');
  const { engine, request, counts } = setup(response);
  await expect(engine.summarizeNodes(request)).rejects.toMatchObject({ code: response.error.code, details: response.error.details });
  expect(counts()).toEqual({ calls: 1, builds: 1 });
  await engine.close();
});
it('retains the existing single reconnect for transport failures', async () => {
  const response = fixture('success');
  const { engine, request, counts } = setup(response, true);
  expect(await engine.summarizeNodes(request)).toEqual({ data: response.data, warnings: response.warnings });
  expect(counts()).toEqual({ calls: 2, builds: 2 });
  await engine.close();
});


it('preserves percentage components and effective calendar context',async()=>{
 const request=fixture('percentage-dates-request'), response=fixture('percentage-dates-success');
 const engine=new Engine(config,()=>({transport:{close:async()=>{}},client:{connect:async()=>{},callTool:async call=>{
 expect(call).toEqual({name:'summarize-nodes',arguments:request});return {content:[{type:'text',text:JSON.stringify(response)}]};
 }}}));
 expect(await engine.summarizeNodes(request)).toEqual({data:response.data,warnings:response.warnings});
 await engine.close();
});
it('preserves an expression and does not weaken it after a domain error',async()=>{
 const response=fixture('failure');const {engine,request,counts}=setup(response);
 request.filter={where:{any:[{types:['project']},{title_eq:'A'}]}};
 await expect(engine.summarizeNodes(request)).rejects.toMatchObject({code:response.error.code});
 expect(counts()).toEqual({calls:1,builds:1});await engine.close();
});
