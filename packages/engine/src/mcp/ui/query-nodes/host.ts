/**
 * Iframe host bridge — ext-apps App construction with host theming prewired,
 * plus connect + initial-context replay.
 *
 * Deliberately NOT here: ontoolinput/ontoolresult policy. Whether to consume
 * the host-pushed result or re-query (this surface's "always-fresh" ignore)
 * is a per-surface product decision — main.tsx assigns its own handlers.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

export type HostContext = Parameters<NonNullable<App["onhostcontextchanged"]>>[0];

/** Construct the bridge App with host theme/style/font adoption wired.
 *  Auto-resize lives inside the SDK App class — do not add resize logic here. */
export function createHostApp(opts: { name: string; version: string }): App {
  const app = new App(opts);
  app.onhostcontextchanged = (ctx: HostContext) => {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  };
  return app;
}

/** Connect, then replay the initial host context through the handler (the
 *  context may have arrived before the handler was assigned). */
export async function connectHost(app: App): Promise<void> {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx) app.onhostcontextchanged?.(ctx);
}
