import { pageOutputFrame } from './page-output-fixtures.js';
import { expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { runReconciliationPipeline } from '../src/reconciliation-pipeline.js';
import type { Config } from '../src/config.js';
import type { ExistingWiki } from '../src/types.js';
import { EvidenceCollector } from '../src/provenance-evidence.js';
import { UsageReporter } from '../src/usage-reporter.js';
import type { PrepareRequest, StageRequest } from '../src/provenance-types.js';
import type { ResolvedWikiOutputPolicy } from '../src/wiki-output-policy.js';
import { DailyBudget, withDailyBudget } from '../src/budget.js';
import { ProviderLimits } from '../src/provider-limits.js';
const scope={v:1 as const,subject:'Atlas',facet:'Status'};
const wiki:ExistingWiki={home_id:'home',home:{id:'home',version:1},catalog_valid:true,topology_hash:'t',subpages:[
  {id:'page',title:'Atlas Status',version:1,file_path:'page.md',content_hash:'h',wiki_state:'active',wiki_kind:'freeform',
    wiki_origin:'automatic',wiki_pinned:true,wiki_scope:scope},
]};
const config={model:'auto',homeMaxTokens:100000,bodyCharCap:null,wikiPlanningMaxTokens:24000,wikiPageMaxTokens:32000,wikiHomeMaxTokens:16000,
  wikiPlanningReasoningEffort:'medium',wikiPageReasoningEffort:'low',wikiHomeReasoningEffort:'low'} as Config;
function fixture(fail?: 'page' | 'home' | 'capture' | 'publish' | 'markdown') {
  const prepares: PrepareRequest[] = [], stages: StageRequest[] = [];
  const create=vi.fn(async (req:any)=>{
    const name=req.response_format?.json_schema?.name;
    const stage=name==='emit_topology_plan'?'planner':name==='emit_wiki_sections'?'home':'page';
    if(stage===fail) return {choices:[{finish_reason:'length',message:{content:null}}],usage:{prompt_tokens:10,completion_tokens:20}};
    const output=name==='emit_topology_plan'?{reviewed_page_ids:['page'],actions:[{op:'refresh',node_id:'page',scope,synthesis_brief:'Refresh status'}]}:
      name==='emit_wiki_sections'?{now:'Now.',focus:[{ title: 'Focus.' }],open_threads:[{ title: 'Open.' }],log_entry:'Updated.'}:
      {body:fail==='markdown'?'Name | Role |--- | --- |Alex | Owner |':'Current status.',log_note:'Updated.'};
    return {choices:[{finish_reason:'stop',message:{content:name ? JSON.stringify(output) : pageOutputFrame(output)}}],usage:{prompt_tokens:10,completion_tokens:20}};
  });
  const llm=new OpenAiCompatLlmClient({chat:{completions:{create}}} as unknown as OpenAI,{provider:'openrouter',fireworksExtensions:false,reasoningEffort:'high'});
  const recordUsage=vi.fn(async()=>({}));
  const engine={recordUsage,getNode:vi.fn(async()=>({id:'page',title:'Atlas Status',types:['wiki'],fields:{},body:'Prior status.\n\n<!-- manual -->\nKeep this history.',
    provenance_observation:{source:{kind:'node',namespace:'vault',native_id:'page'},authority:'engine',observed_at:new Date().toISOString(),
      native_version:1,content_hash:'h',hash_semantics:'engine_content_hash',observation_projection:'node-token-v2',observation_digest:`sha256:json-v1:${'a'.repeat(64)}`,label:'Atlas Status',path:'page.md'}})),
    inspectProvenance:vi.fn(async()=>({select:'status',capability_version:1,capture_features:['project-subpage-v1','multi-output-reconcile-v1']})),
    prepareProvenance:vi.fn(async(request:PrepareRequest)=>{
      if(fail==='capture')throw new Error('PROVENANCE_CAPACITY');
      if(request.dry_run)return {dry_run:true,bundle_digest:'digest',payload_bytes:1,reserved_bytes:2,item_count:0};
      prepares.push(request);return {derivation_id:`d-${prepares.length}`,bundle_digest:'digest',state:'prepared',availability:'retained',lease_expires_at:new Date(Date.now()+60000).toISOString()};
    }),
    transitionProvenance:vi.fn(async()=>({})),
    stageProvenanceResult:vi.fn(async(request:StageRequest)=>{stages.push(request);return {derivation_id:request.derivation_id,bundle_digest:'digest',contribution_digest:'contribution'};}),
    wikiReconcile:vi.fn(async(request:any)=>{
      if(fail==='publish')throw new Error('publication rejected');
      const receipts=[request.home.provenance,...request.pages.map((p:any)=>p.provenance)].map((p:any,i:number)=>({
        derivation_id:p.derivation_id,output_revision_id:`rev-${i}`,output_node_id:i===0?'home':'page',committed_node_version:2,
        committed_at:new Date().toISOString(),operation_id:'op',reconcile_key:request.reconcile_key,request_digest:'digest'}));
      return {data:{operation_id:request.dry_run?null:'op',reconcile_key:request.reconcile_key,plan_digest:'digest',reused:false,
        dry_run:!!request.dry_run,created:[],updated:[{node_id:'page',title:'Atlas Status',file_path:'page.md',version:2}],mappings:[],
        topology_hash:'new',warnings:[],preview:{total:1,items:[],truncated:false},home:{node_id:'home',title:'Atlas Wiki',file_path:'home.md',version:2,created:false},
        ...(!request.dry_run?{provenance_receipt:receipts[0],provenance_receipts:receipts}:{})},warnings:[]};
    })};
  const reporter=new UsageReporter(engine as never,{provider:'openrouter',experiment:null,variant:null});
  reporter.setContext({project:'Atlas',runRef:'run'});
  const input={llm:reporter.wrap(llm),engine:engine as never,config,project:'Atlas',rootTitle:'Atlas',wikiRootId:'root',evidenceHash:'e',existingWiki:wiki,
    provenanceRunRef:'run',dryRun:false,force:true,prepareEvidence:async(policy:ResolvedWikiOutputPolicy)=>({text:'Evidence.',nodes:[],provenance:new EvidenceCollector({}),
      homeBudget:{generatedAt:new Date(),model:config.model,system:'Home system',maxTokens:policy.home.maxTokens,homePolicy:policy.home,
        limits:{componentBytes:262144,itemCount:512,requestBytes:1048576,totalBytes:2097152},omissionCounts:{}}})};
  return {create,llm,engine,input,prepares,stages,recordUsage};
}
it('sends stage budgets/effort and leaves the shared client unchanged',async()=>{
  const f=fixture(); await runReconciliationPipeline(f.input);
  expect(f.create.mock.calls.map(([r])=>r.max_tokens)).toEqual([24000,32000,16000]);
  expect(f.create.mock.calls.map(([r])=>r.reasoning_effort)).toEqual(['medium','low','low']);
  expect(f.create.mock.calls[1]![0]).not.toHaveProperty('response_format');
  expect(f.llm.configurationFor('auto').reasoningEffort).toBe('high');
});
it('binds captured trial payloads to existing identities and reports publication only after commit',async()=>{
  const f=fixture();const {result}=await runReconciliationPipeline(f.input);
  expect(result.outcome).toBe('written');expect(result.wikiCuratedAt).toBeTruthy();
  expect(f.prepares.map(p=>p.bundle.provider_payload)).toEqual(f.create.mock.calls.slice(1).map(([r])=>r));
  expect(f.stages).toHaveLength(2);
  expect(f.engine.wikiReconcile).toHaveBeenCalledTimes(2);
  expect(f.engine.wikiReconcile.mock.calls[1]![0].pages[0]).toMatchObject({target:{mode:'existing',node_id:'page'}});
  expect(f.create.mock.calls[1]![0].messages[1].content).toContain('Keep this history.');
  expect(f.recordUsage.mock.calls.map(([row]:any)=>row.metadata.wiki_call.stage)).toEqual(['planner','page','home']);
});
it.each(['page','home','capture','publish','markdown'] as const)('retains accounting and blocks success on %s failure',async fail=>{
  const f=fixture(fail);const {result}=await runReconciliationPipeline(f.input);
  expect(result.outcome).toBe('error');expect(result.wikiCuratedAt).toBeNull();
  // An invalid page body gets one retry; a truncated page does not.
  expect(f.create.mock.calls.length).toBe(fail==='capture'?1:fail==='page'?2:3);
  expect(f.recordUsage).toHaveBeenCalledTimes(f.create.mock.calls.length);
  expect(result.usage?.output).toBe(f.create.mock.calls.length*20);
  if(fail!=='publish')expect(f.engine.wikiReconcile).not.toHaveBeenCalled();
  if(fail==='markdown'){
    expect(f.create.mock.calls.slice(1).map(([r])=>r.max_tokens)).toEqual([32000,32000]);
    expect(f.recordUsage.mock.calls.slice(1).map(([row]:any)=>row.metadata.wiki_call.outcome)).toEqual(['returned','returned']);
  }
});
it.each(['emit_memory','emit_journal','emit_web_assessment'])('leaves unrelated %s request payloads unchanged after trial wiki calls',async toolName=>{
  const f=fixture();await runReconciliationPipeline(f.input);
  await f.llm.structuredCall({model:'auto',maxTokens:777,system:'Other work',user:'source',toolName,toolDescription:'other',schema:{}});
  expect(f.create.mock.calls.at(-1)![0]).toMatchObject({max_tokens:777,reasoning_effort:'high'});
  expect(f.create.mock.calls.at(-1)![0]).not.toHaveProperty('wikiContext');
});
it('skips unchanged wiki before resolving policy or dispatching',async()=>{
  const f=fixture(), spy=vi.spyOn(f.llm,'configurationFor');
  await runReconciliationPipeline({...f.input,force:false,existingWiki:{...wiki,home:{id:'home',version:1,
    wiki_evidence_hash:'e',wiki_topology_hash:'t'}}});
  expect(f.create).not.toHaveBeenCalled();expect(spy).not.toHaveBeenCalled();
});
it('dispatches and records each stage on its own model',async()=>{
  const f=fixture();
  await runReconciliationPipeline({...f.input,config:{...config,wikiPlanningModel:'planner-x',wikiPageModel:'pages-y',wikiHomeModel:null},
    prepareEvidence:async(policy:ResolvedWikiOutputPolicy)=>({...await f.input.prepareEvidence(policy),
      homeBudget:{...(await f.input.prepareEvidence(policy)).homeBudget,model:policy.home.model}})});
  expect(f.create.mock.calls.map(([r])=>r.model)).toEqual(['planner-x','pages-y','auto']);
  expect(f.recordUsage.mock.calls.map(([row]:any)=>row.model)).toEqual(['planner-x','pages-y','auto']);
});
it('makes no model calls, evidence reads or writes on a plain dry run',async()=>{
  const f=fixture(), prepareEvidence=vi.fn(f.input.prepareEvidence);
  const {result}=await runReconciliationPipeline({...f.input,dryRun:true,prepareEvidence});
  expect(result).toMatchObject({outcome:'would_curate',dryRun:true,evidenceHash:'e'});
  expect(result.detail).toMatch(/forced.*no model calls/);
  expect(f.create).not.toHaveBeenCalled();expect(f.recordUsage).not.toHaveBeenCalled();
  expect(prepareEvidence).not.toHaveBeenCalled();expect(f.engine.wikiReconcile).not.toHaveBeenCalled();
});
it('runs paid stages but only an engine dry run when a preview is requested',async()=>{
  const f=fixture();
  const wikiReconcile=vi.fn(async(request:any)=>({data:{operation_id:null,reconcile_key:request.reconcile_key,plan_digest:'digest',
    reused:false,dry_run:!!request.dry_run,created:[],updated:[{node_id:'page',title:'Atlas Status',file_path:'page.md',version:2}],
    mappings:[],topology_hash:'new',warnings:[],preview:{total:1,items:[],truncated:false},
    home:{node_id:'home',title:'Atlas Wiki',file_path:'home.md',version:2,created:false}},warnings:[]}));
  const {provenanceRunRef:_capture,...uncaptured}=f.input;
  const {result}=await runReconciliationPipeline({...uncaptured,engine:{...f.engine,wikiReconcile} as never,dryRun:true,preview:true,
    prepareEvidence:async()=>({text:'Evidence.',nodes:[]})});
  expect(result.outcome).toBe('written');expect(result.dryRun).toBe(true);
  expect(f.create).toHaveBeenCalledTimes(3);
  expect(wikiReconcile).toHaveBeenCalled();
  expect(wikiReconcile.mock.calls.every(([request])=>request.dry_run===true)).toBe(true);
});
it('holds unforced runs on evidence whose last run failed after paid calls',async()=>{
  const f=fixture();
  const held=await runReconciliationPipeline({...f.input,force:false,failureHoldHash:'e'});
  expect(held.result).toMatchObject({outcome:'skipped_failure_hold',evidenceHash:'e'});
  expect(f.create).not.toHaveBeenCalled();expect(f.engine.wikiReconcile).not.toHaveBeenCalled();
  const changed=await runReconciliationPipeline({...f.input,force:false,dryRun:true,failureHoldHash:'older'});
  expect(changed.result.outcome).toBe('would_curate');
  const forced=await runReconciliationPipeline({...f.input,force:true,dryRun:true,failureHoldHash:'e'});
  expect(forced.result.outcome).toBe('would_curate');
  expect(f.create).not.toHaveBeenCalled();
});
it('reports a budget refusal as skipped_budget, keeping spend already made',async()=>{
  const cheap={input:1,output:1,cacheRead:1,cacheWrite:1}, dear={input:10,output:10,cacheRead:10,cacheWrite:10};
  const run=async(remainingUsd:number)=>{
    const f=fixture();
    const llm=withDailyBudget(f.input.llm,new DailyBudget(async()=>1-remainingUsd),
      {capUsd:1,tz:'UTC',pricing:model=>model==='pages-y'?dear:cheap});
    return {f,...await runReconciliationPipeline({...f.input,llm,config:{...config,wikiPageModel:'pages-y'}})};
  };
  const refusedFirst=await run(0);
  expect(refusedFirst.result).toMatchObject({outcome:'skipped_budget',usage:{output:0}});
  expect(refusedFirst.result.detail).toMatch(/^planner: daily budget: /);
  expect(refusedFirst.f.create).not.toHaveBeenCalled();
  // The planner's worst case (~$0.05) fits; the dear page model's 32k allowance (~$0.32) does not.
  const refusedLater=await run(0.1);
  expect(refusedLater.result.outcome).toBe('skipped_budget');
  expect(refusedLater.result.detail).toMatch(/^page synthesis: daily budget: /);
  expect(refusedLater.f.create).toHaveBeenCalledTimes(1);
  expect(refusedLater.result.usage?.output).toBe(20);
});
it('reports a refused planner retry as skipped_budget, keeping the first attempt',async()=>{
  const cheap={input:1,output:1,cacheRead:1,cacheWrite:1};
  const f=fixture();
  f.create.mockImplementationOnce(async()=>({choices:[{finish_reason:'stop',message:{content:'not json'}}],usage:{prompt_tokens:10,completion_tokens:20}}) as never);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    // One planner attempt (~$0.025) fits in $0.04; a retry held beside it does not.
    const llm=withDailyBudget(f.input.llm,new DailyBudget(async()=>1-0.04),{capUsd:1,tz:'UTC',pricing:()=>cheap});
    const {result}=await runReconciliationPipeline({...f.input,llm});
    expect(result.outcome).toBe('skipped_budget');
    expect(result.detail).toMatch(/^planner: daily budget: /);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(result.usage?.output).toBe(20);
  }finally{warn.mockRestore();}
});
it('reports a provider key limit hit mid-run as skipped_budget, so no failure hold follows (#342)',async()=>{
  const cheap={input:1,output:1,cacheRead:1,cacheWrite:1};
  const f=fixture();
  const create=f.create.getMockImplementation()!;
  // The page call is fail-closed: the provider's 403 keeps no text, only its status.
  f.create.mockImplementation(async(req:any)=>{
    if(!req.response_format?.json_schema?.name) throw Object.assign(new Error('403 Key limit exceeded (daily limit).'),{status:403});
    return create(req);
  });
  let reads=0;
  const limits=new ProviderLimits({openrouter:async()=>({limitUsd:3,remainingUsd:reads++===0?2:0,reset:'daily' as const})},
    ()=>new Date('2026-11-04T10:50:00Z'),300_000,()=>{});
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    const llm=withDailyBudget(f.input.llm,new DailyBudget(async()=>0,undefined,undefined,limits),
      {capUsd:12,tz:'UTC',pricing:()=>cheap,provider:()=>'openrouter',wikiProviders:['openrouter']});
    const {result}=await runReconciliationPipeline({...f.input,llm});
    expect(result.outcome).toBe('skipped_budget');
    expect(result.detail).toBe('page synthesis: OpenRouter refused calls: key spend limit or credit reached ($3.00 daily limit); '
      +'resets 2026-11-05T00:00:00.000Z');
    expect(result.usage?.output).toBe(20); // the planner's spend is kept
  }finally{warn.mockRestore();}
});
it.each([true,false])('dates the planner, page and home prompts, the home Log and the captures in the configured zone (#459; budgeted home %s)',async budgeted=>{
  // 05:30 on Tuesday 10 March in Tokyo is still Monday 9 March in UTC and in New York.
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-03-09T20:30:00Z'));
  try{
    const f=fixture();
    await runReconciliationPipeline({...f.input,config:{...config,curatorTz:'Asia/Tokyo'} as Config,
      prepareEvidence:async(policy:ResolvedWikiOutputPolicy)=>{
        const prepared=await f.input.prepareEvidence(policy);
        // prepareHomeEvidence puts the configured zone in the home budget; without a budget the pipeline reads it from config.
        return budgeted?{...prepared,homeBudget:{...prepared.homeBudget,timeZone:'Asia/Tokyo'}}:{text:prepared.text,nodes:prepared.nodes,provenance:prepared.provenance};
      }});
    const line='Today is Tuesday, 2026-03-10 (Asia/Tokyo).';
    expect(f.create.mock.calls.map(([r])=>String(r.messages[0].content).includes(line))).toEqual([true,true,true]);
    const home=f.engine.wikiReconcile.mock.calls.at(-1)![0].home;
    expect(home.sections.find((s:{name:string})=>s.name==='Log').content).toBe('**2026-03-10** — Updated.');
    expect(f.stages.map(s=>s.log_stamp)).toEqual(['2026-03-10','2026-03-10']);
  }finally{vi.useRealTimers();}
});
