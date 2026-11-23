import { expect, it } from 'vitest';
import { parseSummaryRequest } from '../../src/summaries/input.js';
const request = (where: unknown) => ({ filter: { where }, relations: [{ as: 'tasks', direction: 'incoming', field: 'project', metrics: [{ as: 'n', op: 'count' }] }] });
it('accepts bounded summary groups without stripping their branches', () => {
  const where = { all: [{ types: ['project'] }, { any: [{ title_eq: 'A' }, { title_contains: 'B' }] }] };
  expect(parseSummaryRequest(request(where)).filter).toEqual({ where });
});
it.each([null, {}, { all: [] }, { any: [{ title_eq: 'A' }] }, { all: [{ title_eq: 'A' }, { title_eq: 'B' }], title_eq: 'C' }, { where: { title_eq: 'A' } }, { fields: {} }, { types: [] }, { query: 'ranked' }])('rejects malformed summary expression %j', where => {
  expect(() => parseSummaryRequest(request(where))).toThrow();
});
it('retains arbitrary own field names through expression parsing', () => {
  const where = JSON.parse('{"fields":{"__proto__":{"eq":1}}}');
  expect(parseSummaryRequest(request(where)).filter).toEqual({ where });
});
import { assertExpressionBudget } from '../../src/filters/expression.js';
const check = (filter: unknown) => assertExpressionBudget([{ filter, profile: 'query', path: '$' }]);
const leaf = () => ({ title_eq: 'a' });
it('bounds group depth, fanout and shared node totals', () => {
  let where: unknown = leaf();
  for (let n=0;n<4;n++) where={all:[leaf(),where]};
  expect(()=>check({where})).not.toThrow();
  expect(()=>check({where:{all:[leaf(),where]}})).toThrow(expect.objectContaining({reason:'depth',limit:4}));
  expect(()=>check({where:{any:Array.from({length:8},leaf)}})).not.toThrow();
  expect(()=>check({where:{any:Array.from({length:9},leaf)}})).toThrow();
  const scope={filter:{where:{any:Array.from({length:7},leaf)}},profile:'query' as const,path:'$'};
  expect(()=>assertExpressionBudget(Array(8).fill(scope))).not.toThrow();
  expect(()=>assertExpressionBudget([...Array(8).fill(scope),{...scope,filter:{where:leaf()}}])).toThrow(expect.objectContaining({reason:'nodes'}));
});
it('counts flat siblings, arrays and selected scopes in shared budgets', () => {
  expect(()=>check({where:leaf(),types:Array(127).fill('task')})).not.toThrow();
  expect(()=>check({where:leaf(),types:Array(128).fill('task')})).toThrow(expect.objectContaining({reason:'atoms'}));
  expect(()=>check({where:leaf(),node_ids:Array(511).fill('n')})).not.toThrow();
  expect(()=>check({where:leaf(),node_ids:Array(512).fill('n')})).toThrow(expect.objectContaining({reason:'operands'}));
  expect(()=>check({node_ids:Array(600).fill('n')})).not.toThrow();
});
it('bounds UTF-8 expression bytes and detects cycles', () => {
  const overhead=Buffer.byteLength(JSON.stringify({title_eq:''}));
  expect(()=>check({where:{title_eq:'x'.repeat(16384-overhead)}})).not.toThrow();
  expect(()=>check({where:{title_eq:'x'.repeat(16385-overhead)}})).toThrow(expect.objectContaining({reason:'bytes'}));
  expect(()=>check({where:{title_eq:'é'.repeat(8192)}})).toThrow(expect.objectContaining({reason:'bytes'}));
  const where:any={all:[leaf()]};where.all.push(where);
  expect(()=>check({where})).toThrow(expect.objectContaining({reason:'cycle'}));
});
it('counts target trees but rejects hidden multi-hop joins', () => {
  expect(()=>check({where:{join_filters:[{rel_type:'project',target:{where:{any:[leaf(),leaf()]}}}]}})).not.toThrow();
  expect(()=>check({where:{join_filters:[{target:{where:{any:[leaf(),{join_filters:[{rel_type:'owner'}]}]}}}]}})).toThrow();
});
it('rejects nonscalar nested operand arrays before serialization',()=>{
  expect(()=>check({where:{fields:{status:{one_of:[['open']]}}}})).toThrow();
});
