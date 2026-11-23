import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Engine,type EngineClientFactory} from '../src/engine.js';
import type {Config} from '../src/config.js';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`../../../tests/fixtures/classification/${name}.json`,import.meta.url),'utf8'));
it.each(['success','failure'])('preserves classification %s without retrying domain failures',async name=>{
 let calls=0;const request=fixture('request'),response=fixture(name);
 const factory:EngineClientFactory=()=>({transport:{close:async()=>{}},client:{connect:async()=>{},callTool:async call=>{calls++;expect(call).toEqual({name:'classify-nodes',arguments:request});return {content:[{type:'text',text:JSON.stringify(response)}]};}}});
 const engine=new Engine({engineUrl:'http://localhost:3334',engineToken:'test'} as Config,factory);
 if(name==='success') expect(await engine.classifyNodes(request)).toEqual({data:response.data,warnings:[]});
 else await expect(engine.classifyNodes(request)).rejects.toMatchObject({code:'CLASSIFICATION_INVALID_CONFIG'});
 expect(calls).toBe(1);await engine.close();
});
