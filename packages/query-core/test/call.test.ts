import { describe, it, expect, vi } from "vitest";
import { unwrapEnvelope, makeCall } from "../src/call.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function tr(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

describe("unwrapEnvelope", () => {
  it("parses an ok envelope", () => {
    const env = unwrapEnvelope(tr({ ok: true, data: { nodes: [], total: 0 }, warnings: [] }));
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data).toEqual({ nodes: [], total: 0 });
      expect(env.warnings).toEqual([]);
    }
  });

  it("parses a fail envelope", () => {
    const env = unwrapEnvelope(tr({
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
      warnings: [],
    }));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("NOT_FOUND");
    }
  });

  it("throws when content[0] is not text", () => {
    expect(() => unwrapEnvelope({ content: [] } as CallToolResult)).toThrow(/missing text content/);
  });

  it("throws on invalid JSON", () => {
    expect(() => unwrapEnvelope({ content: [{ type: "text", text: "not json" }] } as CallToolResult))
      .toThrow();
  });
});

describe("makeCall", () => {
  it("calls the named tool with the given args and unwraps the envelope", async () => {
    const callServerTool = vi.fn(async () => tr({ ok: true, data: { hello: 1 }, warnings: [] }));
    const call = makeCall(callServerTool);
    const env = await call<{ hello: number }>("any-tool", { a: 1 });
    expect(callServerTool).toHaveBeenCalledWith({ name: "any-tool", arguments: { a: 1 } });
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data).toEqual({ hello: 1 });
  });
});
