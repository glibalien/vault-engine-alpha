/**
 * Iframe entry for the query-nodes MCP App UI — glue around the shared
 * viz surface. Mount sequence:
 *   1. Assign tool handlers, then connectHost (App.connect + context replay).
 *   2. ontoolinput seeds a VizSpec from the pushed call args.
 *   3. Ignore ontoolresult — always-fresh: the card re-calls query-nodes
 *      itself through useVizData.
 *   4. Render a controlled VizCard; onSpecChange is what enables the full
 *      editable surface (filter chips, inline edit, bulk, draft, sub-tables).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { VizCard, VizClientProvider } from "@vault/viz-ui";
import type { VizSpec } from "@vault/viz-ui";
import "@vault/viz-ui/styles.css";
import "./tokens.css";
import { createHostApp, connectHost } from "./host.js";
import { specFromToolInput } from "./spec-from-input.js";

// UI surface v2 (v1 = the vanilla-TS app deleted in e20fe80c); independent of the engine version.
const app = createHostApp({ name: "vault-engine query-nodes UI", version: "2.0.0" });

function AppRoot({ initial }: { initial: VizSpec }) {
  const [spec, setSpec] = useState<VizSpec>(initial);
  return <VizCard spec={spec} onSpecChange={setSpec} />;
}

/** Plain-DOM fatal renderer — must work even when React never mounts. */
function renderFatal(message: string): void {
  const root = document.getElementById("root");
  if (root) root.textContent = `query-nodes UI: ${message}`;
}

async function main(): Promise<void> {
  const seeded = new Promise<VizSpec>((resolve, reject) => {
    app.ontoolinput = (params) => {
      const spec = specFromToolInput(params.arguments ?? {});
      // SeededVizSpec is a structural subset of VizSpec — assignable as-is.
      if (spec) resolve(spec);
      else reject(new Error("unusable tool input received from host"));
    };
  });
  // Always-fresh: ignore the host's pre-pushed result. The card queries itself.
  app.ontoolresult = () => { /* intentionally ignored */ };
  app.ontoolcancelled = (params) => {
    console.info("[query-nodes-ui] Tool call cancelled:", params.reason);
  };

  await connectHost(app);
  const initial = await Promise.race([
    seeded,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no tool input received from host after 10s")), 10_000),
    ),
  ]);

  createRoot(document.getElementById("root")!).render(
    <VizClientProvider call={app.callServerTool.bind(app)}>
      <AppRoot initial={initial} />
    </VizClientProvider>,
  );
}

main().catch((err: unknown) => {
  renderFatal(err instanceof Error ? err.message : String(err));
});
