import { dynamicTool, jsonSchema, type ToolSet } from 'ai';

export interface EngineToolInfo {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** Loose CallToolResult shape — we only ever read text content. */
export interface ToolCallResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface ResourceResultLike {
  contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
}

export type EngineCall = (name: string, args: Record<string, unknown>) => Promise<ToolCallResultLike>;

export function parseEnvelope(result: ToolCallResultLike): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'EMPTY_RESULT', message: 'Tool returned no text content' }, warnings: [] };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'BAD_JSON', message: 'Tool returned non-JSON text' }, warnings: [], raw: text };
  }
}

/**
 * Merge tool sets left-to-right with FIRST-WINS precedence. A name already
 * present is kept (not overwritten) and the colliding duplicate is skipped with
 * a warning — so an engine tool always beats a same-named curator tool, and a
 * future curator rename can't silently shadow an engine tool.
 */
export function mergeToolSets(...sets: ToolSet[]): ToolSet {
  const merged: ToolSet = {};
  for (const set of sets) {
    for (const [name, tool] of Object.entries(set)) {
      if (Object.prototype.hasOwnProperty.call(merged, name)) {
        console.warn(`[chat-core] tool name collision: "${name}" already defined; skipping duplicate`);
        continue;
      }
      merged[name] = tool;
    }
  }
  return merged;
}

/**
 * Wrap engine tools as AI SDK dynamic tools. The model sees the parsed envelope
 * verbatim plus a `_ms` duration stamp. Caller failures become failed envelopes
 * so the loop continues.
 */
export function wrapEngineTools(tools: EngineToolInfo[], call: EngineCall): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = dynamicTool({
      description: t.description ?? '',
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (input) => {
        const started = Date.now();
        try {
          const result = await call(t.name, (input ?? {}) as Record<string, unknown>);
          const envelope = parseEnvelope(result);
          const base =
            typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)
              ? envelope
              : { value: envelope };
          return { ...base, _ms: Date.now() - started };
        } catch (err) {
          return {
            ok: false,
            error: { code: 'TOOL_CALL_FAILED', message: err instanceof Error ? err.message : String(err) },
            warnings: [],
            _ms: Date.now() - started,
          };
        }
      },
    });
  }
  return set;
}
