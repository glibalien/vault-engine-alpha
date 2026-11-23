import { expect, it, vi } from 'vitest';
import OpenAIClient from 'openai';
import AnthropicClient from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { AnthropicLlmClient } from '../src/llm/anthropic.js';
import { UsageReporter } from '../src/usage-reporter.js';
import type { Engine } from '../src/engine.js';
import type { StructuredCallRequest } from '../src/llm/types.js';
import { StructuredCallFailure, projectFailClosedFailure } from '../src/llm/types.js';
import { buildWikiCallMetadata } from '../src/llm/diagnostics.js';
const context={stage:'page' as const,attempt:0,policyVersion:1 as const,maxTokens:32000,
  configuration:{provider:'openrouter' as const,reasoningEffort:'low'}};
const req:StructuredCallRequest={model:'auto',maxTokens:32000,system:'system',user:'source',toolName:'emit',
  toolDescription:'emit',schema:{},wikiContext:context,malformedOutputPolicy:'fail-closed-redacted'};
const response=(content:unknown, finish='stop')=>({id:'gen-1',model:'resolved',choices:[{finish_reason:finish,message:{content}}],
  usage:{prompt_tokens:10,completion_tokens:20,completion_tokens_details:{reasoning_tokens:15}}});
function fixture(responses:unknown[]) {
  const create=vi.fn();for(const r of responses)create.mockResolvedValueOnce(r);
  const raw=new OpenAiCompatLlmClient({chat:{completions:{create}}} as unknown as OpenAI,{provider:'openrouter',fireworksExtensions:false});
  const recordUsage=vi.fn().mockResolvedValue({});
  const reporter=new UsageReporter({recordUsage} as unknown as Engine,{provider:'openrouter',experiment:null,variant:null});
  reporter.setContext({project:'Atlas',runRef:'run'});
  return {llm:reporter.wrap(raw),create,recordUsage};
}
it('records stage and single-response identity without double-counting reasoning',async()=>{
  const f=fixture([response('{"body":"SECRET_RESPONSE"}')]);await f.llm.structuredCall(req);
  expect(f.recordUsage).toHaveBeenCalledTimes(1);
  const row=f.recordUsage.mock.calls[0]![0];
  expect(row).toMatchObject({model:'auto',output_tokens:20,request_id:'gen-1',metadata:{wiki_call:{version:1,stage:'page',
    outcome:'returned',usage_known:true,diagnostics:{adapterAttempts:1,sdkAttempts:1,responses:[{reportedModel:'resolved',reasoningTokens:15}]}}}});
  expect(JSON.stringify(row.metadata)).not.toContain('SECRET_RESPONSE');
  expect(f.create.mock.calls[0]![0]).not.toHaveProperty('wikiContext');
});
it.each([
  ['malformed_json',response('SECRET_INVALID')],
  ['truncated',response(null,'length')],
  ['invalid_content_type',response(null)],
  ['invalid_content_type',response([])],
  ['no_choices',{usage:{prompt_tokens:10,completion_tokens:20},choices:[]}],
  ['empty_content',response('')],
])('retains known usage and closed diagnostics on %s',async(reason,result)=>{
  const f=fixture([result]);await expect(f.llm.structuredCall(req)).rejects.toMatchObject({reason});
  expect(f.recordUsage.mock.calls[0]![0]).toMatchObject({output_tokens:20,metadata:{wiki_call:{outcome:'failed',reason}}});
});
it('keeps retry aggregates distinct from single provider responses',async()=>{
  const f=fixture([response('invalid'),{...response('{}'),id:'gen-2'}]);
  await f.llm.structuredCall({...req,malformedOutputPolicy:'retry-once-with-content-sample'});
  expect(f.recordUsage).toHaveBeenCalledTimes(1);
  const row=f.recordUsage.mock.calls[0]![0];
  expect(row.output_tokens).toBe(40);expect(row).not.toHaveProperty('request_id');
  expect(row.metadata.wiki_call.diagnostics).toMatchObject({adapterAttempts:2,sdkAttempts:null,responses:[{requestId:'gen-1'},{requestId:'gen-2'}]});
});
it.each([undefined,{prompt_tokens:-1,completion_tokens:NaN}])('leaves missing/invalid usage unknown',async usage=>{
  const f=fixture([{...response('{}'),usage}]);
  const result=await f.llm.structuredCall(req);
  expect(result.usageKnown).toBe(false);expect(f.recordUsage).not.toHaveBeenCalled();
});
it('bounds Unicode metadata and ignores hostile diagnostic data',()=>{
  const metadata=buildWikiCallMetadata({...context,target:'💠'.repeat(10000)},undefined,false,'returned');
  expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(4096);
  const hostile={get responses(){throw new Error('SECRET');}};
  expect(()=>buildWikiCallMetadata(context,hostile as never,false,'failed')).not.toThrow();
});
it('retains known retry subtotals while labeling aggregate usage incomplete',async()=>{
  const f=fixture([response('invalid'),{...response('{}'),usage:undefined}]);
  await f.llm.structuredCall({...req,malformedOutputPolicy:'retry-once-with-content-sample'});
  expect(f.recordUsage.mock.calls[0]![0]).toMatchObject({output_tokens:20,metadata:{wiki_call:{usage_known:false}}});
});
it('labels known subtotals incomplete after an uncertain retry transport failure',async()=>{
  const f=fixture([response('invalid')]);f.create.mockRejectedValueOnce(new Error('transport'));
  await expect(f.llm.structuredCall({...req,malformedOutputPolicy:'retry-once-with-content-sample'})).rejects.toThrow();
  expect(f.recordUsage.mock.calls[0]![0]).toMatchObject({output_tokens:20,metadata:{wiki_call:{usage_known:false}}});
});
it('does not mask provider failures when the reporting observer throws',async()=>{
  const f=fixture([response('invalid')]);f.recordUsage.mockImplementation(()=>{throw new Error('observer');});
  await expect(f.llm.structuredCall(req)).rejects.toMatchObject({reason:'malformed_json'});
});
it('ignores malformed optional provider metadata without changing accepted output',async()=>{
  const r=response('{}');Object.defineProperty(r,'id',{get(){throw new Error('PRIVATE');}});
  const f=fixture([r]);expect((await f.llm.structuredCall(req)).output).toEqual({});
  expect(f.recordUsage).toHaveBeenCalledTimes(1);
});
it('keeps fail-closed projection safe with hostile optional diagnostics and error proxies',()=>{
  const error = new StructuredCallFailure('PRIVATE');
  Object.defineProperty(error,'diagnostics',{get(){throw new Error('PRIVATE');}});
  const proxy = new Proxy({}, { getPrototypeOf(){throw new Error('PRIVATE');} });
  for (const value of [error, proxy]) expect(projectFailClosedFailure(value,'provider_transport_failed'))
    .toMatchObject({message:'structured call failed (reason=provider_transport_failed)',reason:'provider_transport_failed'});
});
it('preserves native tool content and handles missing native usage without invented billing',async()=>{
  const native=new AnthropicLlmClient({messages:{create:vi.fn().mockResolvedValue({id:'native',model:'claude',stop_reason:'tool_use',
    content:[{type:'tool_use',name:'emit',input:{body:'NATIVE_SECRET'}}]})}} as unknown as Anthropic);
  const result=await native.structuredCall({...req,wikiContext:{...context,configuration:{provider:'anthropic',reasoningEffort:null}}});
  expect(result).toMatchObject({output:{body:'NATIVE_SECRET'},usageKnown:false,diagnostics:{responses:[{contentKind:'array',usageKnown:false}]}});
  expect(JSON.stringify(result.diagnostics)).not.toContain('NATIVE_SECRET');
});
async function failedCallMetadata(thrown:unknown) {
  const f=fixture([]);f.create.mockRejectedValueOnce(thrown);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    await expect(f.llm.structuredCall(req)).rejects.toMatchObject({reason:'provider_transport_failed'});
    const line=warn.mock.calls.find(c=>c[0]==='[curator] wiki call usage unavailable');
    return {logged:String(line?.[1]),wikiCall:JSON.parse(String(line?.[1])).wiki_call};
  } finally { warn.mockRestore(); }
}
it('keeps the provider HTTP status and identifiers of a fail-closed call, never its message',async()=>{
  const error=new OpenAIClient.InternalServerError(502,{message:'SECRET_UPSTREAM',code:502,metadata:{provider_name:'OpenAI',raw:'SECRET_RAW'}},
    'SECRET_MESSAGE',new Headers({'x-request-id':'req_abc123'}));
  const {logged,wikiCall}=await failedCallMetadata(error);
  expect(wikiCall.diagnostics.failure).toEqual({attempt:0,kind:'http',status:502,errorType:'InternalServerError',
    code:'502',requestId:'req_abc123',upstream:'OpenAI'});
  expect(logged).not.toMatch(/SECRET/);
});
it('names a dropped connection by its underlying socket code',async()=>{
  const socket=Object.assign(new Error('SECRET other side closed'),{code:'UND_ERR_SOCKET'});
  const error=new OpenAIClient.APIConnectionError({message:'SECRET',cause:Object.assign(new TypeError('terminated'),{cause:socket})});
  const {logged,wikiCall}=await failedCallMetadata(error);
  expect(wikiCall.diagnostics.failure).toEqual({attempt:0,kind:'connection',errorType:'APIConnectionError',code:'UND_ERR_SOCKET'});
  expect(logged).not.toMatch(/SECRET/);
});
it('classifies SDK timeouts and unidentified throws',async()=>{
  expect((await failedCallMetadata(new OpenAIClient.APIConnectionTimeoutError())).wikiCall.diagnostics.failure)
    .toEqual({attempt:0,kind:'timeout',errorType:'APIConnectionTimeoutError'});
  expect((await failedCallMetadata(new SyntaxError('SECRET body'))).wikiCall.diagnostics.failure)
    .toEqual({attempt:0,kind:'other',errorType:'SyntaxError'});
});
it('drops free-text identifiers and survives hostile thrown values',async()=>{
  const error=new OpenAIClient.BadRequestError(400,{code:'SECRET text with spaces',metadata:{provider_name:'x'.repeat(65)}},'m',new Headers());
  expect((await failedCallMetadata(error)).wikiCall.diagnostics.failure).toEqual({attempt:0,kind:'http',status:400,errorType:'BadRequestError'});
  const proxy=new Proxy({},{getPrototypeOf(){throw new Error('SECRET');},get(){throw new Error('SECRET');}});
  const {logged,wikiCall}=await failedCallMetadata(proxy);
  expect(wikiCall.diagnostics).not.toHaveProperty('failure');expect(logged).not.toMatch(/SECRET/);
});
it('records native provider failures the same way',async()=>{
  const create=vi.fn().mockRejectedValue(new AnthropicClient.InternalServerError(529,{type:'overloaded_error',message:'SECRET'},'SECRET',
    new Headers({'request-id':'req_native'})));
  const native=new AnthropicLlmClient({messages:{create}} as unknown as Anthropic);
  const failure=await native.structuredCall({...req,wikiContext:{...context,configuration:{provider:'anthropic',reasoningEffort:null}}})
    .catch((error:StructuredCallFailure)=>error);
  expect(failure).toMatchObject({reason:'provider_transport_failed',diagnostics:{failure:{attempt:0,kind:'http',status:529,
    errorType:'InternalServerError',requestId:'req_native'}}});
  expect(JSON.stringify((failure as StructuredCallFailure).diagnostics)).not.toMatch(/SECRET/);
});
it('records a stage reasoning budget only when one is set (#429)',()=>{
  const plain=buildWikiCallMetadata(context,undefined,true,'returned') as {wiki_call:Record<string,unknown>};
  expect(plain.wiki_call).not.toHaveProperty('reasoning_budget');
  const budgeted=buildWikiCallMetadata({...context,configuration:{provider:'openrouter',reasoningEffort:null,reasoningBudget:6000}},
    undefined,true,'returned') as {wiki_call:Record<string,unknown>};
  expect(budgeted.wiki_call).toMatchObject({reasoning_effort:null,reasoning_budget:6000});
});
it('refuses a reasoning budget on the Anthropic adapter instead of dropping it (#429)',()=>{
  const llm=new AnthropicLlmClient({} as Anthropic);
  expect(llm.withConfiguration({provider:'anthropic',reasoningEffort:null})).toBe(llm);
  expect(()=>llm.withConfiguration({provider:'anthropic',reasoningEffort:null,reasoningBudget:2000})).toThrow('REASONING_BUDGET_UNSUPPORTED');
});
