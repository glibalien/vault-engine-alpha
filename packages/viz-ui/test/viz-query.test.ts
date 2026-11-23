import { it, expect } from "vitest";
import { vizOwnedState, vizWithQuery } from "../src/viz-query.js";
import type { VizSpec } from "../src/viz-spec.js";

const spec: VizSpec = {
  kind: "table", title: "t",
  query: { types: ["task"], title_contains: "draft", offset: 5,
           join_filters: [{ rel_type: "project", target: { node_ids: ["p1"] } }] },
  display_fields: ["status"],
};

it("vizOwnedState parses strip + typeSelection + callerFragments", () => {
  const parsed = vizOwnedState(spec);
  // types extracted into typeSelection
  expect(parsed.typeSelection).toBe("task");
  // title_contains lands in strip
  expect(parsed.strip.title_contains).toBe("draft");
  // join_filters becomes a caller fragment
  expect(parsed.fragments.some(f => f.key === "join_filters")).toBe(true);
});

it("vizWithQuery replaces query immutably", () => {
  const next = vizWithQuery(spec, { types: ["project"] });
  expect(next.query).toEqual({ types: ["project"] });
  expect(next).not.toBe(spec);
  expect(spec.query.types).toEqual(["task"]); // original untouched
  expect(next.kind).toBe("table"); // other fields carried
});

import {parseVizFence,serializeVizFence,vizQueryArgs,specForTypeChange} from '../src/viz-spec.js';
import {parseBoardCardSpec} from '../src/board-card-spec.js';
it('roundtrips Boolean expressions through view kind, display, paging, fences and boards',()=>{
  const where={all:[{types:['task']},{any:[{fields:{status:{eq:'open'}}},{title_contains:'A'}]}]};
  for(const kind of ['table','kanban','calendar','list'] as const){
    const next:VizSpec={...spec,kind,query:{where,offset:20,sort_order:'desc'},display_fields:['due']};
    const reopened=parseVizFence(serializeVizFence(next).split('\n').slice(1,-1).join('\n'))!;
    expect(vizQueryArgs(reopened)).toMatchObject({where,offset:20,sort_order:'desc'});
    expect((parseBoardCardSpec(JSON.parse(JSON.stringify(next))) as VizSpec).query.where).toEqual(where);
    expect(specForTypeChange(reopened,'project').query.where).toEqual(where);
  }
});
