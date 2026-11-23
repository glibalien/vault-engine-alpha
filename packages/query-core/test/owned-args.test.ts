import { describe, it, expect } from "vitest";
import {
  parseArgs, composeArgs, promoteFragments, summarizeFragment, effectiveTypes,
  type ParsedArgs, type ComposeSource,
} from "../src/owned-args.js";
import type {
  CallerFragment, FilterChip, QueryArgs, Schema, SchemaField,
} from "../src/types.js";

function field(name: string, p: Partial<SchemaField> & { type: SchemaField["type"] }): SchemaField {
  return { name, required: false, default_value: null, ui: null, ...p };
}
const schema: Schema = {
  name: "task", display_name: null,
  fields: [
    field("status", { type: "enum", enum_values: ["open", "done"] }),
    field("estimate", { type: "number" }),
    field("project", { type: "reference", reference_target: "project" }),
    field("location", { type: "string" }),
  ],
};

/** Minimal ComposeSource around a parse result (no lock, no chips). */
function sourceOf(p: ParsedArgs): ComposeSource {
  return {
    strip: p.strip, typeSelection: p.typeSelection, callerFragments: p.fragments,
    lockedType: null, filtersByType: {}, schemaCache: new Map(),
  };
}
const compose = (args: QueryArgs) => composeArgs(sourceOf(parseArgs(args)));

/** Round-trip expectation: original args minus include_fields, strip defaults filled. */
function withDefaults(a: QueryArgs): QueryArgs {
  const { include_fields: _drop, ...rest } = a;
  return { sort_by: "title", sort_order: "asc", limit: 50, ...rest };
}

describe("parseArgs — partition", () => {
  it("extracts strip keys with engine defaults", () => {
    expect(parseArgs({}).strip).toEqual({
      title_contains: "", query: "", sort_by: "title", sort_order: "asc", limit: 50,
    });
    const p = parseArgs({ title_contains: "x", query: "y", sort_by: "file_mtime", sort_order: "desc", limit: 10 });
    expect(p.strip).toEqual({ title_contains: "x", query: "y", sort_by: "file_mtime", sort_order: "desc", limit: 10 });
    expect(p.fragments).toEqual([]);
  });
  it("single types value becomes the type selection, not a fragment", () => {
    const p = parseArgs({ types: ["task"] });
    expect(p.typeSelection).toBe("task");
    expect(p.fragments).toEqual([]);
  });
  it("multi types becomes one global fragment; empty array is discarded", () => {
    const p = parseArgs({ types: ["task", "meeting"] });
    expect(p.typeSelection).toBeNull();
    expect(p.fragments).toEqual([
      { id: 0, key: "types", payload: ["task", "meeting"], scope: "global" },
    ]);
    expect(parseArgs({ types: [] }).fragments).toEqual([]);
  });
  it("include_fields and offset:0 are discarded; offset>0 is a fragment", () => {
    expect(parseArgs({ include_fields: ["*"], offset: 0 }).fragments).toEqual([]);
    expect(parseArgs({ offset: 25 }).fragments)
      .toEqual([{ id: 0, key: "offset", payload: 25, scope: "global" }]);
  });
  it("array args fragment per element; node_ids stays whole", () => {
    const p = parseArgs({
      join_filters: [{ rel_type: "a", target: {} }, { rel_type: "b", target: {} }],
      without_types: ["archived", "template"],
      node_ids: ["n1", "n2", "n3"],
    });
    expect(p.fragments.filter(f => f.key === "join_filters")).toHaveLength(2);
    expect(p.fragments.filter(f => f.key === "without_types").map(f => f.payload))
      .toEqual(["archived", "template"]);
    expect(p.fragments.filter(f => f.key === "node_ids")).toHaveLength(1);
  });
  it("fields fragment per field name, schema-scoped, with fieldName", () => {
    const p = parseArgs({ fields: { status: { one_of: ["open"] }, estimate: { ne: 3 } } });
    expect(p.fragments).toEqual([
      { id: 0, key: "fields", fieldName: "status", payload: { one_of: ["open"] }, scope: "schema" },
      { id: 1, key: "fields", fieldName: "estimate", payload: { ne: 3 }, scope: "schema" },
    ]);
  });
  it("scope split: joins/fields schema; path/title/dates/ids/unknown global", () => {
    const p = parseArgs({
      join_filters: [{ rel_type: "x", target: {} }], without_joins: [{ rel_type: "y", target: {} }],
      without_fields: ["due"], fields: { status: { eq: "open" } },
      path_dir: "Projects", modified_since: "2026-05-01", title_eq: "T",
      without_titles: ["Inbox"], without_node_ids: ["n9"], mystery_key: { nested: true },
    });
    const byKey = (k: string) => p.fragments.filter(f => f.key === k).map(f => f.scope);
    expect(byKey("join_filters")).toEqual(["schema"]);
    expect(byKey("without_joins")).toEqual(["schema"]);
    expect(byKey("without_fields")).toEqual(["schema"]);
    expect(byKey("fields")).toEqual(["schema"]);
    expect(byKey("path_dir")).toEqual(["global"]);
    expect(byKey("modified_since")).toEqual(["global"]);
    expect(byKey("title_eq")).toEqual(["global"]);
    expect(byKey("without_titles")).toEqual(["global"]);
    expect(byKey("without_node_ids")).toEqual(["global"]);
    expect(byKey("mystery_key")).toEqual(["global"]);
  });
});

describe("composeArgs — round trip", () => {
  const PROJECT_JOIN = { rel_type: "project", target: { title_contains: "Vault Engine" } };
  const CORPUS: QueryArgs[] = [
    { types: ["task"], join_filters: [PROJECT_JOIN] },
    { types: ["task", "meeting"], without_types: ["archived"], path_dir: "Projects" },
    { fields: { status: { one_of: ["open"] }, estimate: { ne: 3 } }, limit: 10 },
    { node_ids: ["a", "b", "c"], include_fields: ["*"] },
    { title_eq: "Weekly Sync", modified_since: "2026-05-01", offset: 20 },
    {
      without_joins: [{ rel_type: "blocked_by", target: {} }],
      without_fields: ["due"], without_titles: ["Inbox"], without_node_ids: ["x1"],
    },
    { mystery_future_key: { nested: true } },
    { query: "vault", title_contains: "engine", sort_by: "file_mtime", sort_order: "desc", limit: 200 },
  ];
  it("compose(parse(args)) is semantically identical for the whole corpus", () => {
    for (const args of CORPUS) {
      expect(compose(args), JSON.stringify(args)).toEqual(withDefaults(args));
    }
  });
  it("offset 0 round-trips to absent (engine default)", () => {
    expect(compose({ offset: 0 })).toEqual({ sort_by: "title", sort_order: "asc", limit: 50 });
  });
});

describe("composeArgs — chips under a lock", () => {
  it("merges chip-built fields with fragment remainders; chip op wins a collision", () => {
    const src = sourceOf(parseArgs({ fields: { status: { ne: "done" } } }));
    src.lockedType = "task";
    src.schemaCache = new Map([["task", schema]]);
    src.filtersByType = { task: [{ field: "status", state: { one_of: ["open"] } }] };
    expect(composeArgs(src).fields).toEqual({ status: { ne: "done", one_of: ["open"] } });

    const collide = sourceOf(parseArgs({ fields: { status: { one_of: ["x"] } } }));
    collide.lockedType = "task";
    collide.schemaCache = new Map([["task", schema]]);
    collide.filtersByType = { task: [{ field: "status", state: { one_of: ["open"] } }] };
    expect(composeArgs(collide).fields).toEqual({ status: { one_of: ["open"] } });
  });
  it("chip-built joins and foreign join fragments both compose", () => {
    const foreign = { rel_type: "project", target: { title_contains: "V" } };
    const src = sourceOf(parseArgs({ join_filters: [foreign] }));
    src.lockedType = "task";
    src.schemaCache = new Map([["task", schema]]);
    src.filtersByType = { task: [{ field: "project", state: { exists: null, target: { id: "n1", title: "P" } } }] };
    expect(composeArgs(src).join_filters).toEqual([
      { rel_type: "project", target: { node_ids: ["n1"] } },
      foreign,
    ]);
  });
  it("chips contribute nothing while unlocked", () => {
    const src = sourceOf(parseArgs({}));
    src.schemaCache = new Map([["task", schema]]);
    src.filtersByType = { task: [{ field: "status", state: { one_of: ["open"] } }] };
    expect(composeArgs(src).fields).toBeUndefined();
  });
});

describe("effectiveTypes", () => {
  it("selection wins; multi-types fragment is the fallback; else undefined", () => {
    const frag: CallerFragment = { id: 0, key: "types", payload: ["a", "b"], scope: "global" };
    expect(effectiveTypes({ typeSelection: "task", callerFragments: [frag] })).toEqual(["task"]);
    expect(effectiveTypes({ typeSelection: null, callerFragments: [frag] })).toEqual(["a", "b"]);
    expect(effectiveTypes({ typeSelection: null, callerFragments: [] })).toBeUndefined();
  });
});

describe("promoteFragments", () => {
  const frags = (args: QueryArgs) => parseArgs(args).fragments;

  it("promotes an expressible fields fragment into a chip and consumes it", () => {
    const { remaining, added } = promoteFragments(frags({ fields: { status: { one_of: ["open"] } } }), schema, new Set());
    expect(added).toEqual([{ field: "status", state: { one_of: ["open"] } }]);
    expect(remaining).toEqual([]);
  });
  it("splits mixed ops: chip takes expressible, remainder fragment keeps the rest", () => {
    const { remaining, added } = promoteFragments(frags({ fields: { estimate: { gte: 2, ne: 5 } } }), schema, new Set());
    expect(added).toEqual([{ field: "estimate", state: { min: "2", max: "" } }]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.payload).toEqual({ ne: 5 });
    expect(remaining[0]!.fieldName).toBe("estimate");
  });
  it("keeps fragments for unknown fields and non-expressible ops", () => {
    const input = frags({ fields: { nosuch: { eq: "x" }, location: { ne: "y" } } });
    const { remaining, added } = promoteFragments(input, schema, new Set());
    expect(added).toEqual([]);
    expect(remaining).toEqual(input);
  });
  it("promotes a chip-shaped join to a link chip; foreign joins stay", () => {
    const input = frags({
      join_filters: [
        { rel_type: "project", target: { node_ids: ["n1"] } },
        { rel_type: "project", target: { title_contains: "V" } },
      ],
    });
    const { remaining, added } = promoteFragments(input, schema, new Set());
    expect(added).toEqual([{ field: "project", state: { exists: null, target: { id: "n1", title: null } } }]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.payload).toEqual({ rel_type: "project", target: { title_contains: "V" } });
  });
  it("an existing chip on the same field blocks promotion (fragment kept verbatim)", () => {
    const input = frags({ fields: { status: { one_of: ["open"] } } });
    const { remaining, added } = promoteFragments(input, schema, new Set(["status"]));
    expect(added).toEqual([]);
    expect(remaining).toEqual(input);
  });
  it("promoted chip-shaped join composes back to the identical entry", () => {
    const p = parseArgs({ types: ["task"], join_filters: [{ rel_type: "project", target: { node_ids: ["n1"] } }] });
    const { remaining, added } = promoteFragments(p.fragments, schema, new Set());
    const src: ComposeSource = {
      strip: p.strip, typeSelection: p.typeSelection, callerFragments: remaining,
      lockedType: "task", filtersByType: { task: added }, schemaCache: new Map([["task", schema]]),
    };
    expect(composeArgs(src).join_filters).toEqual([{ rel_type: "project", target: { node_ids: ["n1"] } }]);
  });
});

describe("summarizeFragment — label grammar", () => {
  const frag = (key: string, payload: unknown, fieldName?: string): CallerFragment =>
    ({ id: 0, key, payload, scope: "global", ...(fieldName !== undefined ? { fieldName } : {}) });
  const label = (key: string, payload: unknown, fieldName?: string) =>
    summarizeFragment(frag(key, payload, fieldName)).label;

  it("joins", () => {
    expect(label("join_filters", { rel_type: "project", target: { title_contains: "Vault Engine" } }))
      .toBe('project → title ~ "Vault Engine"');
    expect(label("join_filters", { rel_type: "project", direction: "incoming", target: {} }))
      .toBe("in: project → any");
    expect(label("without_joins", { rel_type: "blocked_by", target: {} }))
      .toBe("−join: blocked_by → any");
  });
  it("paths, types, titles, dates", () => {
    expect(label("path_dir", "Projects")).toBe("dir: Projects/");
    expect(label("path_prefix", "Projects")).toBe("path: Projects…");
    expect(label("without_path_prefix", "Archive")).toBe("−path: Archive…");
    expect(label("without_types", "archived")).toBe("−type: archived");
    expect(label("without_fields", "due")).toBe("−field: due");
    expect(label("title_eq", "X")).toBe('title = "X"');
    expect(label("without_titles", "Inbox")).toBe('−title: "Inbox"');
    expect(label("modified_since", "2026-05-01")).toBe("since: 2026-05-01");
    expect(label("types", ["task", "meeting"])).toBe("type: task ∣ meeting");
  });
  it("pinned nodes and offset", () => {
    expect(label("node_ids", ["a"])).toBe("1 pinned node");
    expect(label("node_ids", ["a", "b", "c", "d", "e"])).toBe("5 pinned nodes");
    expect(label("without_node_ids", ["a", "b"])).toBe("−2 nodes");
    expect(label("offset", 20)).toBe("offset: 20");
  });
  it("fields remainders get op symbols; multi-op falls back", () => {
    expect(label("fields", { ne: 3 }, "priority")).toBe("priority ≠ 3");
    expect(label("fields", { gt: 1, lt: 9 }, "priority")).toBe("priority: {…}");
    expect(label("fields", { exists: true }, "project")).toBe("project set");
  });
  it("references and unknown keys fall back to readable JSON-ish labels", () => {
    expect(label("references", { rel_type: "project", target: "Vault Engine" }))
      .toBe('ref: project → "Vault Engine"');
    expect(label("mystery_key", { a: 1 })).toBe('mystery_key: {"a":1}');
  });
  it("tooltip carries the full fragment JSON", () => {
    expect(summarizeFragment(frag("path_dir", "Projects")).tooltip).toContain('"path_dir"');
    expect(summarizeFragment(frag("fields", { ne: 3 }, "priority")).tooltip).toContain('"priority"');
  });
});

describe("owned-state isolation", () => {
  it("compose output is disposable: mutating it does not affect a second compose", () => {
    const src = sourceOf(parseArgs({
      join_filters: [{ rel_type: "project", target: { title_contains: "V" } }],
      node_ids: ["a", "b"],
      fields: { estimate: { ne: 3 } },
    }));
    const first = composeArgs(src);
    (first.join_filters as Array<Record<string, unknown>>)[0]!.rel_type = "CORRUPTED";
    (first.node_ids as string[]).push("CORRUPTED");
    (first.fields as Record<string, Record<string, unknown>>).estimate!.ne = "CORRUPTED";
    expect(composeArgs(src)).toEqual(composeArgs(sourceOf(parseArgs({
      join_filters: [{ rel_type: "project", target: { title_contains: "V" } }],
      node_ids: ["a", "b"],
      fields: { estimate: { ne: 3 } },
    }))));
  });
  it("fragments do not alias the caller's args object", () => {
    const join = { rel_type: "project", target: { title_contains: "V" } };
    const p = parseArgs({ join_filters: [join] });
    join.target.title_contains = "MUTATED";
    expect(p.fragments[0]!.payload).toEqual({ rel_type: "project", target: { title_contains: "V" } });
  });
  it("types [\"\"] stays a visible fragment instead of silently vanishing", () => {
    const p = parseArgs({ types: [""] });
    expect(p.typeSelection).toBeNull();
    expect(p.fragments).toEqual([{ id: 0, key: "types", payload: [""], scope: "global" }]);
    expect(compose({ types: [""] })).toEqual(withDefaults({ types: [""] }));
  });
});

it('keeps compound where global and atomic through schema arrival and outer edits',()=>{
  const where={any:[{types:['task'],fields:{status:{eq:'open'}}},{types:['note'],join_filters:[{rel_type:'project',target:{title_eq:'A'}}]}]};
  const parsed=parseArgs({where});
  expect(parsed.typeSelection).toBeNull();
  expect(parsed.fragments).toHaveLength(1);expect(parsed.fragments[0].scope).toBe('global');
  const src=sourceOf(parsed);src.typeSelection='project';
  expect(composeArgs(src).where).toEqual(where);
  expect(composeArgs(src).types).toEqual(['project']);
  expect(summarizeFragment(parsed.fragments[0]).tooltip).toContain('"any"');
  expect(JSON.parse(summarizeFragment(parsed.fragments[0]).tooltip)).toEqual({where});
  src.callerFragments=[];expect(composeArgs(src)).not.toHaveProperty('where');
});
