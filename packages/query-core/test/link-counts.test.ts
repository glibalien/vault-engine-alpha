import { describe, expect, it } from "vitest";
import { composeArgs, parseArgs, summarizeFragment, type ComposeSource, type ParsedArgs } from "../src/owned-args.js";
import {
  isServerSortBy, linkCountRuleCount, linkCountsArg, linkCountsLabel, parseLinkCountRules,
  queryUsesLinkCounts, withLinkCountRule,
} from "../src/link-counts.js";
import type { QueryArgs } from "../src/types.js";

function sourceOf(p: ParsedArgs): ComposeSource {
  return {
    strip: p.strip, typeSelection: p.typeSelection, callerFragments: p.fragments,
    lockedType: null, filtersByType: {}, schemaCache: new Map(),
  };
}
const compose = (args: QueryArgs) => composeArgs(sourceOf(parseArgs(args)));

describe("parseLinkCountRules", () => {
  it("reads one comparison per count", () => {
    expect(parseLinkCountRules({ incoming: { lte: 1 }, outgoing: { gte: 2 }, unresolved: { eq: 0 } })).toEqual({
      incoming: { op: "lte", value: 1 }, outgoing: { op: "gte", value: 2 }, unresolved: { op: "eq", value: 0 },
    });
  });

  it("refuses what the Filter menu can't show", () => {
    for (const value of [
      { rel_type: "project", incoming: { lte: 1 } },
      { incoming: { gte: 1, lte: 3 } },
      { incoming: { lt: 2 } },
      { incoming: { lte: -1 } },
      { incoming: { lte: 1.5 } },
      { sideways: { eq: 1 } },
      {},
      null,
      [],
    ]) expect(parseLinkCountRules(value)).toBeNull();
  });
});

describe("link_counts through parseArgs / composeArgs", () => {
  it("keeps an editable filter in the strip and composes it back", () => {
    const args = { link_counts: { incoming: { lte: 1 }, outgoing: { lte: 1 } } };
    const parsed = parseArgs(args);
    expect(parsed.strip.link_counts).toEqual({ incoming: { op: "lte", value: 1 }, outgoing: { op: "lte", value: 1 } });
    expect(parsed.fragments).toEqual([]);
    expect(compose(args).link_counts).toEqual(args.link_counts);
  });

  it("carries any other link_counts verbatim as a caller chip", () => {
    const args = { link_counts: { rel_type: "project", incoming: { gte: 1, lte: 3 } } };
    const parsed = parseArgs(args);
    expect(parsed.strip.link_counts).toBeUndefined();
    expect(parsed.fragments).toHaveLength(1);
    expect(summarizeFragment(parsed.fragments[0]!).label).toBe("links in ≥ 1, links in ≤ 3, via project");
    expect(compose(args).link_counts).toEqual(args.link_counts);
  });

  it("keeps a link-count sort", () => {
    for (const sort_by of ["inlink_count", "outlink_count", "unresolved_link_count"]) {
      expect(parseArgs({ sort_by }).strip.sort_by).toBe(sort_by);
      expect(compose({ sort_by, sort_order: "desc" })).toMatchObject({ sort_by, sort_order: "desc" });
    }
    expect(parseArgs({ sort_by: "due date" }).strip.sort_by).toBe("title");
  });

  it("emits nothing when the strip holds no rules", () => {
    expect(compose({})).not.toHaveProperty("link_counts");
  });
});

describe("helpers", () => {
  it("sets and clears one count's rule", () => {
    const one = withLinkCountRule(undefined, "incoming", { op: "lte", value: 1 });
    expect(one).toEqual({ incoming: { op: "lte", value: 1 } });
    const two = withLinkCountRule(one, "outgoing", { op: "eq", value: 0 });
    expect(linkCountRuleCount(two)).toBe(2);
    expect(withLinkCountRule(withLinkCountRule(two, "incoming", undefined), "outgoing", undefined)).toBeUndefined();
  });

  it("builds the query arg from rules", () => {
    expect(linkCountsArg({ unresolved: { op: "gte", value: 1 } })).toEqual({ unresolved: { gte: 1 } });
    expect(linkCountsArg({})).toBeUndefined();
    expect(linkCountsArg(undefined)).toBeUndefined();
  });

  it("knows the server sorts and when a query uses link counts", () => {
    expect(isServerSortBy("inlink_count")).toBe(true);
    expect(isServerSortBy("field_count")).toBe(false);
    expect(queryUsesLinkCounts({ sort_by: "outlink_count" })).toBe(true);
    expect(queryUsesLinkCounts({ link_counts: { incoming: { eq: 0 } } })).toBe(true);
    expect(queryUsesLinkCounts({ sort_by: "title" })).toBe(false);
  });

  it("finds a link-count filter inside where", () => {
    const either = { any: [{ link_counts: { incoming: { lte: 1 } } }, { link_counts: { outgoing: { lte: 1 } } }] };
    expect(queryUsesLinkCounts({ where: either })).toBe(true);
    expect(queryUsesLinkCounts({ where: { all: [{ types: ["note"] }, { any: [{ title_contains: "x" }, { link_counts: { unresolved: { gte: 1 } } }] }] } })).toBe(true);
    expect(queryUsesLinkCounts({ where: { any: [{ types: ["note"] }, { title_contains: "x" }] } })).toBe(false);
    expect(queryUsesLinkCounts({ where: "not an expression" })).toBe(false);
  });

  it("labels a malformed payload without throwing", () => {
    expect(linkCountsLabel("x")).toBe("links: {…}");
    expect(linkCountsLabel({ outgoing: { eq: 0 } })).toBe("links out = 0");
  });
});
