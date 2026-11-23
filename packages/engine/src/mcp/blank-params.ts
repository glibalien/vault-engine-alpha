import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema, type AnySchema, type ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

/**
 * Optional parameters where a blank string is a real value, keyed by tool name. Each one is text
 * the tool writes, where "" clears or sets it (or names the vault root), or an opaque value stored
 * as given. Every other optional top-level parameter sent as a blank string counts as not given.
 */
export const BLANK_IS_A_VALUE: Readonly<Record<string, readonly string[]>> = {
  // Notes directly in the vault root (the Curator's organization sweep sends it).
  'query-nodes': ['path_dir'],
  // With override_default_directory: the vault root.
  'create-node': ['directory'],
  // Clears the body; moves to the vault root.
  'update-node': ['set_body', 'set_directory'],
  // Clears the category.
  'update-memory': ['category'],
  // An empty-string default value.
  'create-global-field': ['default_value'],
  // Clears the text; an empty-string default value.
  'update-global-field': ['description', 'reference_target', 'default_value'],
  // Clears the text.
  'update-schema': ['display_name', 'icon', 'filename_template', 'default_directory'],
  // The vault root.
  'materialize-transcript': ['directory'],
  // A blank title, and the host's opaque state, are stored as given.
  'save-conversation': ['title', 'client_state'],
};

type ToolLike = { inputSchema?: AnySchema | ZodRawShapeCompat };
type ValidateToolInput = (tool: ToolLike, args: unknown, toolName: string) => Promise<unknown>;

function isBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

/** The tool's optional top-level parameters, read from the schema it advertises. */
const optionalParamsBySchema = new WeakMap<object, ReadonlySet<string>>();
function optionalParams(tool: ToolLike): ReadonlySet<string> {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return new Set();
  const cached = optionalParamsBySchema.get(schema);
  if (cached) return cached;
  let optional = new Set<string>();
  const obj = normalizeObjectSchema(schema);
  if (obj) {
    // The same conversion the SDK uses for tools/list, so the rule follows what callers see.
    const json = toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const required = new Set(json.required ?? []);
    optional = new Set(Object.keys(json.properties ?? {}).filter((key) => !required.has(key)));
  }
  optionalParamsBySchema.set(schema, optional);
  return optional;
}

/**
 * The arguments without optional top-level parameters sent as a blank string. Many models fill in
 * every optional parameter they see and send "" for the ones they don't mean to set (#558); read
 * as values, those blanks broke get-node's one-identifier check and turned list-memories filters
 * into `= ''` matches. Nested values are left alone (a field cleared through set_fields), as are
 * required parameters and BLANK_IS_A_VALUE.
 */
export function dropBlankOptionalParams(toolName: string, tool: ToolLike, args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const entries = Object.entries(args as Record<string, unknown>);
  if (!entries.some(([, value]) => isBlank(value))) return args;
  const optional = optionalParams(tool);
  const kept = new Set(BLANK_IS_A_VALUE[toolName] ?? []);
  return Object.fromEntries(entries.filter(([key, value]) => !(isBlank(value) && optional.has(key) && !kept.has(key))));
}

/**
 * Apply `dropBlankOptionalParams` to every tool call on `server`, before the SDK validates the
 * arguments, so a blank also passes a parameter whose schema rejects "" (an enum, a minimum length).
 * The SDK has no public hook there, so this wraps its `validateToolInput` method on this instance;
 * `tests/mcp/blank-params.test.ts` calls tools through a real client and fails if the hook stops
 * running.
 */
export function treatBlankOptionalParamsAsAbsent(server: McpServer): void {
  const target = server as unknown as { validateToolInput?: ValidateToolInput };
  const original = target.validateToolInput;
  if (typeof original !== 'function') {
    console.warn('[mcp] the MCP SDK no longer exposes validateToolInput; blank optional parameters are passed through as values');
    return;
  }
  target.validateToolInput = function (this: unknown, tool, args, toolName) {
    return original.call(this, tool, dropBlankOptionalParams(toolName, tool, args), toolName);
  };
}
