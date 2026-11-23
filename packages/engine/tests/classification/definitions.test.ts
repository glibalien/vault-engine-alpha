import { describe, expect, it } from 'vitest';
import { parseEnumGroups } from '../../src/classification/definitions.js';
const def = (values = ['ready']) => ({ version: 1, groups: [{ name: 'active', values }] });
describe('enum group definitions', () => {
  it('allows overlaps and empty groups but rejects duplicate identity and membership', () => {
    expect(parseEnumGroups({ version: 1, groups: [{ name: 'waiting', values: ['ready'] }, { name: 'active', values: ['ready'] }, { name: 'empty', values: [] }] }, ['ready']).groups).toHaveLength(3);
    expect(() => parseEnumGroups({ version: 1, groups: [def().groups[0], def().groups[0]] }, ['ready'])).toThrow();
    expect(() => parseEnumGroups(def(['ready', 'ready']), ['ready'])).toThrow();
    expect(() => parseEnumGroups(def(['wrong']), ['ready'])).toThrow();
  });
  it('enforces structural and encoded limits without truncating', () => {
    const values = Array.from({ length: 513 }, (_, i) => `v${i}`);
    expect(parseEnumGroups(def(values.slice(0,512)), values).groups[0].values).toHaveLength(512);
    expect(() => parseEnumGroups(def(values), values)).toThrow();
    const groups = Array.from({length:65}, (_,i) => ({name:`g${i}`,values:[]}));
    expect(parseEnumGroups({version:1,groups:groups.slice(0,64)},[]).groups).toHaveLength(64);
    expect(() => parseEnumGroups({version:1,groups},[])).toThrow();
    for(const name of ['', '1abc', 'a'.repeat(65), 'é']) expect(() => parseEnumGroups({version:1,groups:[{name,values:[]}]},[])).toThrow();
    for(const extra of [{label:'x'.repeat(81)}, {description:'x'.repeat(281)}, {unknown:true}]) expect(() => parseEnumGroups({version:1,groups:[{...def().groups[0],...extra}]},['ready'])).toThrow();
    expect(() => parseEnumGroups({...def(),unknown:true},['ready'])).toThrow();
    const large = 'x'.repeat(65536);
    expect(() => parseEnumGroups(def([large]),[large])).toThrow();
    expect(parseEnumGroups({version:1,groups:[{name:'constructor',values:[]}]},[]).groups[0].name).toBe('constructor');
  });
});
it('accepts the byte boundary and rejects one extra UTF-8 byte',()=>{
 const overhead=Buffer.byteLength(JSON.stringify(def([''])));
 const value='x'.repeat(65536-overhead);
 expect(parseEnumGroups(def([value]),[value]).groups[0].values).toEqual([value]);
 expect(()=>parseEnumGroups(def([value+'x']),[value+'x'])).toThrow(/64 KiB/);
});
