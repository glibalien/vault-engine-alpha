import type Database from 'better-sqlite3';
import { getGlobalField, validateClassificationState, type UpdateGlobalFieldInput } from '../global-fields/crud.js';
import type { ClaimInput, PatchSchemaInput, UpdateSchemaInput } from '../schema/crud.js';
import { readCurrentClaims } from '../schema/claims.js';
import { type FieldRow } from '../fields/project.js';
import { classificationHash, globalClassificationHash, parseEnumGroups } from './definitions.js';
import { decodeStoredEnumValue, loadClassificationInput } from './read.js';
import { classifyEnumValue, resolveEnumGroups, type ResolveEnumGroupsInput } from './resolver.js';
import { findEnumGroupReferences, type EnumGroupReference } from './references.js';
import { ClassificationError, type ClassificationContext, type EffectiveEnumGroups } from './types.js';
export interface EnumGroupGuards { expected_enum_groups_hash?: string; expected_global_enum_groups_hash?: string }
export type EnumGroupProposal = {field:string;schema?:undefined;input:UpdateGlobalFieldInput & EnumGroupGuards} | {field:string;schema:string;replace?:boolean;input:ClaimInput & EnumGroupGuards};
export interface EnumGroupPreview {
  definition_changes: {context:ClassificationContext;before:string;after:string}[];
  affected_contexts: ClassificationContext[];
  evaluated_node_context_pairs:number;changed_node_context_pairs:number;
  counts:{context:ClassificationContext;before:Record<string,number>;after:Record<string,number>}[];
  examples:unknown[];examples_truncated:boolean;references:EnumGroupReference[];
}
export function inputDefinitionHash(input:ResolveEnumGroupsInput): string {
  return classificationHash({...input.context,global_definition_hash:globalClassificationHash({field_type:input.fieldType,enum_values:input.globalValues,enum_groups:input.globalGroups,overrides_allowed:{enum_groups:input.overrideAllowed}}),type_values:input.typeValues===null?null:[...input.typeValues].sort(),override:input.override===null?null:parseEnumGroups(input.override,input.typeValues??input.globalValues??[])});
}
/** Canonical `before` hash for a context whose claim does not exist yet, so activation never hashes like an unchanged definition. */
export function absentDefinitionHash(context:ClassificationContext): string {
  return classificationHash({...context,absent:true});
}
function configured(input:ResolveEnumGroupsInput):EffectiveEnumGroups|null {
  return input.globalGroups===null && input.override===null ? null : resolveEnumGroups(input);
}
function stale(actual:string,expected:string|undefined):void {
  if (actual!==expected) throw new ClassificationError('CLASSIFICATION_STALE_DEFINITION','Classification definition changed or its expected hash is missing.',{expected_hash:expected??null,current_hash:actual});
}
export function globalChangeNeedsGuard(db:Database.Database,field:string,input:UpdateGlobalFieldInput):boolean {
  return input.enum_groups!==undefined || input.overrides_allowed?.enum_groups!==undefined || ((input.enum_values!==undefined || input.field_type!==undefined) && (getGlobalField(db,field)?.enum_groups!=null || !!db.prepare('SELECT 1 FROM schema_field_claims WHERE field=? AND enum_groups_override IS NOT NULL LIMIT 1').get(field)));
}
export function previewEnumGroupChange(db:Database.Database,proposal:EnumGroupProposal):EnumGroupPreview {
  return db.transaction(()=>{
    const global=getGlobalField(db,proposal.field);
    if(!global) throw new ClassificationError('CLASSIFICATION_INVALID_CONFIG','Global field does not exist.');
    const globalHash=globalClassificationHash(global);
    let pairs:{before:ResolveEnumGroupsInput;after:ResolveEnumGroupsInput;absent?:boolean}[];
    if(proposal.schema!==undefined) {
      const input=proposal.input;
      const current=readCurrentClaims(db,proposal.schema).find(c=>c.field===proposal.field);
      const before:ResolveEnumGroupsInput=current ? loadClassificationInput(db,{schema:proposal.schema,field:proposal.field}) : {context:{schema:proposal.schema,field:proposal.field},fieldType:global.field_type,globalValues:global.enum_values,typeValues:null,globalGroups:global.enum_groups??null,override:null,overrideAllowed:global.overrides_allowed.enum_groups===true};
      stale(globalHash,input.expected_global_enum_groups_hash);
      if(current) stale(inputDefinitionHash(before),input.expected_enum_groups_hash);
      const after={...before,typeValues:input.enum_values_override===undefined?(proposal.replace?null:before.typeValues):input.enum_values_override,override:input.enum_groups_override===undefined?before.override:input.enum_groups_override};
      configured(after);pairs=[{before,after,absent:!current}];
    } else {
      const input=proposal.input;stale(globalHash,input.expected_enum_groups_hash);
      const next={...global,...input,enum_groups:input.enum_groups===undefined?global.enum_groups??null:input.enum_groups,overrides_allowed:{...global.overrides_allowed,...input.overrides_allowed}};
      validateClassificationState(db,proposal.field,next);
      pairs=(db.prepare('SELECT schema_name FROM schema_field_claims WHERE field=? ORDER BY schema_name').all(proposal.field) as {schema_name:string}[]).map(c=>{
        const before=loadClassificationInput(db,{schema:c.schema_name,field:proposal.field});
        return {before,after:{...before,fieldType:next.field_type,globalValues:next.enum_values,globalGroups:next.enum_groups,overrideAllowed:next.overrides_allowed.enum_groups===true}};
      });
    }
    const preview:EnumGroupPreview={definition_changes:[],affected_contexts:[],evaluated_node_context_pairs:0,changed_node_context_pairs:0,counts:[],examples:[],examples_truncated:false,references:[]};
    for(const {before,after,absent} of pairs) {
      const old=absent?null:configured(before),next=configured(after),context=before.context;
      const references=findEnumGroupReferences(db,context);preview.references.push(...references);
      const removed=references.filter(r=>next===null || (r.group!==null && !next.enum_groups.groups.some(g=>g.name===r.group)));
      if(removed.length) throw new ClassificationError('CLASSIFICATION_IN_USE','Stored rollups reference a removed classification definition or group.',{references:removed});
      preview.definition_changes.push({context,before:absent?absentDefinitionHash(context):inputDefinitionHash(before),after:inputDefinitionHash(after)});preview.affected_contexts.push(context);
      const count=(db.prepare('SELECT COUNT(*) AS n FROM node_types WHERE schema_type=?').get(context.schema) as {n:number}).n;
      preview.evaluated_node_context_pairs+=count;
      if(preview.evaluated_node_context_pairs>100000) throw new ClassificationError('CLASSIFICATION_LIMIT_EXCEEDED','Preview exceeds 100,000 node/context pairs.');
      const counts={context,before:Object.create(null) as Record<string,number>,after:Object.create(null) as Record<string,number>};
      const rows=db.prepare(`SELECT nt.node_id,nf.field_name,nf.value_text,nf.value_number,nf.value_date,nf.value_json,nf.source,nf.node_id AS value_node_id,ex.node_id AS null_node_id FROM node_types nt LEFT JOIN node_fields nf ON nf.node_id=nt.node_id AND nf.field_name=? LEFT JOIN node_explicit_null_fields ex ON ex.node_id=nt.node_id AND ex.field_name=? WHERE nt.schema_type=?`).all(context.field,context.field,context.schema) as (FieldRow & {node_id:string;value_node_id:string|null;null_node_id:string|null})[];
      for(const row of rows) {
        const value=decodeStoredEnumValue(row.value_node_id===null?undefined:row,row.null_node_id!==null);
        const previous=old?classifyEnumValue(old,value):{state:'not_configured' as const};
        const proposed=next?classifyEnumValue(next,value):{state:'not_configured' as const};
        for(const [result,tally] of [[previous,counts.before],[proposed,counts.after]] as const) for(const key of result.state==='classified'?result.groups.map(g=>`group:${g}`):[result.state]) tally[key]=(tally[key]??0)+1;
        if(JSON.stringify(previous)!==JSON.stringify(proposed)) {
          preview.changed_node_context_pairs++;
          const example={context,node_id:row.node_id,before:previous,after:proposed};
          if(preview.examples.length<50 && Buffer.byteLength(JSON.stringify([...preview.examples,example]))<=32768) preview.examples.push(example);else preview.examples_truncated=true;
        }
      }
      preview.counts.push(counts);
    }
    return preview;
  }).deferred();
}
/** Run before preview and again inside the mutation transaction; no metadata writes. */
export function previewSchemaClassification(db:Database.Database,schema:string,input:UpdateSchemaInput|PatchSchemaInput):EnumGroupPreview[] {
  const current=new Map(readCurrentClaims(db,schema).map(c=>[c.field,c]));
  const full='field_claims' in input?input.field_claims:undefined;
  const claims=full??[...('add_field_claims' in input?input.add_field_claims??[]:[]),...('update_field_claims' in input?input.update_field_claims??[]:[])];
  const previews:EnumGroupPreview[]=[];
  const affectedClaims=claims.filter(claim=>{const old=current.get(claim.field),global=getGlobalField(db,claim.field);return claim.enum_groups_override!==undefined || ((claim.enum_values_override!==undefined || full!==undefined || !old) && (old?.enum_groups_override!=null || global?.enum_groups!=null));});
  const nodes=(db.prepare('SELECT COUNT(*) AS n FROM node_types WHERE schema_type=?').get(schema) as {n:number}).n;
  if(nodes*affectedClaims.length>100000) throw new ClassificationError('CLASSIFICATION_LIMIT_EXCEEDED','Preview exceeds 100,000 node/context pairs.');
  for(const claim of affectedClaims) {
    const old=current.get(claim.field);const global=getGlobalField(db,claim.field);
    const replacement=full!==undefined?{...claim,enum_groups_override:claim.enum_groups_override??null}:claim;
    const affected=claim.enum_groups_override!==undefined || ((claim.enum_values_override!==undefined || full!==undefined || !old) && (old?.enum_groups_override!=null || global?.enum_groups!=null));
    if(affected) previews.push(previewEnumGroupChange(db,{schema,field:claim.field,replace:full!==undefined,input:replacement}));
  }
  if(previews.reduce((n,p)=>n+p.evaluated_node_context_pairs,0)>100000) throw new ClassificationError('CLASSIFICATION_LIMIT_EXCEEDED','Preview exceeds 100,000 node/context pairs.');
  let examples=0,bytes=2;
  for(const preview of previews) {
    preview.examples=preview.examples.filter(example=>{
      const size=Buffer.byteLength(JSON.stringify(example))+1;
      if(examples>=50 || bytes+size>32768) {preview.examples_truncated=true;return false;}
      examples++;bytes+=size;return true;
    });
  }
  return previews;
}
