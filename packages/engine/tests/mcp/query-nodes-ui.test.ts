// tests/mcp/query-nodes-ui.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerQueryNodesUi, QUERY_NODES_UI_RESOURCE_URI } from "../../src/mcp/ui/query-nodes/register.js";
import { registerQueryNodes } from "../../src/mcp/tools/query-nodes.js";
import { createServer } from "../../src/mcp/server.js";
import { createTestDb } from "../helpers/db.js";

const BUNDLE_PATH = path.resolve("dist/mcp/ui/query-nodes/index.html");

beforeAll(() => {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(
      `query-nodes UI bundle missing at ${BUNDLE_PATH}. Run \`npm run build:ui\` (or \`npm run build\`) before this test.`,
    );
  }
});

interface CapturedResource {
  name: string;
  uri: string;
  config: { mimeType?: string; [k: string]: unknown };
  body: string;
}

async function captureResource(): Promise<CapturedResource> {
  let captured: CapturedResource | undefined;
  const fakeServer = {
    registerResource: async (
      name: string,
      uri: string,
      config: Record<string, unknown>,
      cb: (uri: URL) => Promise<{ contents: Array<{ text?: string }> }>,
    ) => {
      const result = await cb(new URL(uri));
      captured = {
        name,
        uri,
        config,
        body: result.contents[0]?.text ?? "",
      };
    },
  } as unknown as McpServer;
  registerQueryNodesUi(fakeServer);
  // Registration is sync; the read callback is async. Wait a tick for it.
  await new Promise(r => setTimeout(r, 0));
  if (!captured) throw new Error("registerResource was never called");
  return captured;
}

describe("registerQueryNodesUi", () => {
  it("registers the ui:// resource at the expected URI", async () => {
    const r = await captureResource();
    expect(r.uri).toBe("ui://vault-engine/query-nodes");
  });

  it("serves the bundled HTML containing the sentinel", async () => {
    const r = await captureResource();
    expect(r.body).toContain("<!-- vault-engine query-nodes ui -->");
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it("uses the MCP App MIME type", async () => {
    const r = await captureResource();
    expect(r.config.mimeType).toBe("text/html;profile=mcp-app");
  });

  it("is compiled with the automatic JSX runtime (no free React global)", async () => {
    // Vite discovers packages/engine/tsconfig.json (no `jsx` field), NOT
    // tsconfig.ui.json — without an explicit esbuild override the bundle
    // compiles JSX classic-mode, referencing a `React` global that is never
    // defined and crashing at render ("React is not defined", live-hit on
    // claude.ai 2026-07-27). `React.createElement(` is a free-identifier
    // reference minifiers cannot rename, so its absence pins automatic mode.
    const r = await captureResource();
    expect(r.body).not.toContain("React.createElement(");
  });

  it("anchors theming to spec host style variables, not invented names", async () => {
    // Hosts validate hostContext.styles.variables against the spec's closed
    // key union; invented names never arrive, leaving the surface permanently
    // light. The bundle must consume the spec names (tokens.css).
    const r = await captureResource();
    expect(r.body).toContain("--color-background-primary");
    expect(r.body).toContain("--color-text-primary");
    expect(r.body).toContain("--font-sans");
    expect(r.body).not.toContain("--mcp-color-background");
    expect(r.body).not.toContain("--mcp-font-family");
  });
});

describe("query-nodes tool: UI metadata", () => {
  it("advertises _meta.ui.resourceUri pointing at the UI resource", () => {
    let capturedConfig: Record<string, unknown> | undefined;
    const fakeServer = {
      tool: () => {
        // Should not be called after the migration; if it is, capturedConfig stays undefined.
      },
      registerTool: (_name: string, config: Record<string, unknown>, _handler: unknown) => {
        capturedConfig = config;
      },
    };
    const db = createTestDb();
    registerQueryNodes(fakeServer as unknown as McpServer, db);
    expect(capturedConfig).toBeDefined();
    const meta = capturedConfig!._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toBe("ui://vault-engine/query-nodes");
  });
});

describe("createServer wiring: registerQueryNodesUi is actually reachable", () => {
  // Drives the REAL createServer(db) — no fakes — through an in-memory MCP
  // client/server handshake, so a dropped `registerQueryNodesUi(server)` line
  // in src/mcp/server.ts fails this test even though the fake-server tests
  // above stay green (they never touch createServer).
  it("resources/read of ui://vault-engine/query-nodes returns the bundle with the mcp-app mime type", async () => {
    const db = createTestDb();
    const server = createServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "query-nodes-ui-test-client", version: "0.0.1" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const result = await client.readResource({ uri: QUERY_NODES_UI_RESOURCE_URI });
      const content = result.contents[0] as { text?: string; mimeType?: string };
      expect(content.mimeType).toBe("text/html;profile=mcp-app");
      expect(content.text).toContain("<!-- vault-engine query-nodes ui -->");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
