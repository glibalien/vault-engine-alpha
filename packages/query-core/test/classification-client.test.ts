import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {makeClient} from '../src/client.js';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`../../../tests/fixtures/classification/${name}.json`,import.meta.url),'utf8'));
it.each(['success','failure'])('preserves classification %s and ordered request arguments without fallback',async name=>{
 const request=fixture('request'),response=fixture(name);
 const client=makeClient(async call=>{expect(call).toEqual({name:'classify-nodes',arguments:request});return {content:[{type:'text',text:JSON.stringify(response)}]};});
 expect(await client.classifyNodes(request)).toEqual(response);
});
