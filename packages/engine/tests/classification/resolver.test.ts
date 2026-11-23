import { describe, expect, it } from 'vitest';
import { resolveEnumGroups, classifyEnumValue } from '../../src/classification/resolver.js';
const input = {
  context:{schema:'task',field:'status'}, fieldType:'enum',
  globalValues:['ready','waiting','finished','cancelled','planned','someday'],typeValues:null,
  globalGroups:{version:1 as const,groups:[{name:'active',values:['ready','waiting']},{name:'waiting',values:['waiting']},{name:'completed',values:['finished']},{name:'closed',values:['finished','cancelled']}]},
  override:null,overrideAllowed:true,
};
describe('explicit-context classification', () => {
  it('keeps overlapping memberships and distinguishes every unclassified reason', () => {
    const d=resolveEnumGroups(input);
    expect(classifyEnumValue(d,{kind:'value',value:'waiting'})).toEqual({state:'classified',value:'waiting',groups:['active','waiting']});
    expect(classifyEnumValue(d,{kind:'value',value:'finished'})).toEqual({state:'classified',value:'finished',groups:['closed','completed']});
    expect(classifyEnumValue(d,{kind:'value',value:'ready'})).toMatchObject({state:'classified',groups:['active']});
    for(const [original,reason] of [[{kind:'missing'},'missing'],[{kind:'null'},'null'],[{kind:'value',value:'someday'},'unmapped'],[{kind:'value',value:['ready']},'invalid'],[{kind:'value',value:'READY'},'invalid']] as const) expect(classifyEnumValue(d,original)).toEqual({state:'unclassified',reason,original});
  });
  it('intersects inheritance, replaces overrides and rejects missing configuration', () => {
    const d=resolveEnumGroups({...input,typeValues:['ready']});
    expect(d.enum_groups.groups.find(g=>g.name==='active')?.values).toEqual(['ready']);
    expect(d.excluded_values).toContainEqual({group:'active',values:['waiting']});
    expect(classifyEnumValue(resolveEnumGroups({...input,override:{version:1,groups:[]}}),{kind:'value',value:'ready'})).toMatchObject({state:'unclassified',reason:'unmapped'});
    expect(() => resolveEnumGroups({...input,globalGroups:null})).toThrow();
    expect(() => resolveEnumGroups({...input,fieldType:'list'})).toThrow();
    expect(() => resolveEnumGroups({...input,overrideAllowed:false,override:{version:1,groups:[]}})).toThrow();
    expect(() => resolveEnumGroups({...input,typeValues:['ready'],override:input.globalGroups})).toThrow();
  });
  it('hashes semantic changes separately from display and declaration order', () => {
    const a=resolveEnumGroups(input);
    const b=resolveEnumGroups({...input,globalGroups:{...input.globalGroups,groups:input.globalGroups.groups.map(g=>({...g,label:'Display'}))}});
    expect(b.definition_hash).not.toBe(a.definition_hash); expect(b.execution_hash).toBe(a.execution_hash);
    expect(resolveEnumGroups({...input,globalGroups:{...input.globalGroups,groups:[...input.globalGroups.groups].reverse().map(g=>({...g,values:[...g.values].reverse()}))}}).execution_hash).toBe(a.execution_hash);
    expect(resolveEnumGroups({...input,context:{schema:'project',field:'status'}}).execution_hash).not.toBe(a.execution_hash);
    expect(resolveEnumGroups({...input,globalGroups:{version:1,groups:[]}}).execution_hash).not.toBe(a.execution_hash);
  });
});
