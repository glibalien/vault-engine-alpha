import { dynamicTool, jsonSchema, type PrepareStepFunction, type ToolSet, type UIMessage } from 'ai';

export const LOAD_TOOLS_NAME = 'load-vault-tools';

/**
 * Internal write-path tools the model must never see or invoke — surfaces
 * record their own spend automatically (chat.ts / chat-view.ts call these
 * directly against the engine, outside the model's tool loop). Exposing them
 * to the model risks double-counted spend if it "helpfully" logs a call it
 * merely observed. Filtered out of both the core and deferred tiers below.
 */
export const LEDGER_INTERNAL_TOOL_NAMES = ['record-usage'] as const;

/**
 * The tools a chat host stores conversations with. The host calls them itself, outside the
 * model's tool loop, so the model never needs them, and text it reads could otherwise tell
 * it to rewrite, archive or delete saved chats. `list-conversations` and `get-conversation`
 * only read and stay available. Filtered out of both tiers like the ledger tools.
 */
export const CONVERSATION_STORE_TOOL_NAMES = [
  'save-conversation', 'delete-conversation', 'archive-conversation', 'link-conversation', 'set-conversation-state',
] as const;

/**
 * User-approved core tier (spec 2026-07-03 §4). Names absent from a surface's
 * merged set (e.g. curator tools when no curator is connected) are ignored.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  'query-nodes', 'get-node', 'create-node', 'update-node', 'delete-node',
  'batch-mutate', 'list-schemas', 'describe-schema', 'read-embedded',
  'web-search', 'fetch-url', 'present-viz', 'curate-project-wiki', 'curator-status',
];

/** Appended to the system prompt by tiered hosts (web chat.ts, plugin transport). */
export const TIERING_SYSTEM_NOTE = `

## Tool tiering
Only a core subset of vault tools is loaded into context. More exist (schema and
global-field management, boards, conversations, diagnostics, undo, wiki config,
transcripts, archiving, and organizing the vault: a report of what is still
unorganized and a survey of notes with no type). If a task needs a capability you don't see, call
load-vault-tools — its description lists every loadable tool — then call the tool
you loaded. Never tell the user a capability is missing without checking there first.`;

/** Per-request view: pass tools + prepareStep straight into runChatStream. */
export interface RequestTiering {
  tools: ToolSet;
  prepareStep: PrepareStepFunction<ToolSet>;
  /** Currently loaded deferred tools — for tests and host logging. */
  loaded: () => string[];
}

export interface ToolTiering {
  /** Fresh per-request state, seeded by replaying prior load-vault-tools results in `messages`. */
  forRequest(messages: UIMessage[]): RequestTiering;
  coreNames: string[];
  deferredNames: string[];
  /** The generated load-vault-tools description (exposed for tests). */
  index: string;
}

/** First sentence of a tool description (trailing period stripped), truncated to ≤90 chars. */
function oneLiner(description: string | undefined): string {
  const first = ((description ?? '').split(/\.\s|\n/)[0] ?? '').replace(/\.$/, '');
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

function describeTool(tool: ToolSet[string]): string | undefined {
  return (tool as { description?: string }).description;
}

/**
 * Tiered tool exposure: the model sees only core + explicitly loaded tool
 * schemas per step (via activeTools); every handler stays registered. Build
 * once at startup; call forRequest per chat request.
 */
export function createToolTiering(tools: ToolSet, opts?: { core?: readonly string[] }): ToolTiering {
  if (Object.prototype.hasOwnProperty.call(tools, LOAD_TOOLS_NAME)) {
    throw new Error(`tool set already contains "${LOAD_TOOLS_NAME}" — refusing to shadow it`);
  }
  // Strip internal write-path tools before anything model-facing is built from
  // `tools` — they must land in neither coreNames nor deferredNames, so they
  // can't be loaded via load-vault-tools either.
  const internalNames = new Set<string>([...LEDGER_INTERNAL_TOOL_NAMES, ...CONVERSATION_STORE_TOOL_NAMES]);
  const modelTools: ToolSet = Object.fromEntries(
    Object.entries(tools).filter(([name]) => !internalNames.has(name)),
  );
  const coreWanted = new Set(opts?.core ?? CORE_TOOL_NAMES);
  const coreNames = Object.keys(modelTools).filter((n) => coreWanted.has(n));
  const deferredNames = Object.keys(modelTools).filter((n) => !coreWanted.has(n));

  const index = [
    'Load additional vault tools into this conversation by exact name. Loaded tools stay',
    'available for the rest of the conversation. Returns {ok, loaded, unknown, warnings}:',
    'names echoed in unknown do not exist — re-check the list below. Loadable tools:',
    ...deferredNames.map((n) => `- ${n} — ${oneLiner(describeTool(modelTools[n]))}`),
  ].join('\n');

  const deferredSet = new Set(deferredNames);
  const coreSet = new Set(coreNames);

  function seedLoaded(messages: UIMessage[]): Set<string> {
    const out = new Set<string>();
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        // Our tools are dynamicTool-wrapped, so history parts are 'dynamic-tool';
        // accept the static 'tool-<name>' shape too, defensively.
        const isMeta =
          (p.type === 'dynamic-tool' && (p as { toolName?: string }).toolName === LOAD_TOOLS_NAME) ||
          p.type === `tool-${LOAD_TOOLS_NAME}`;
        if (!isMeta) continue;
        const part = p as { state?: string; output?: { loaded?: unknown } };
        if (part.state !== 'output-available') continue;
        const loaded = Array.isArray(part.output?.loaded) ? part.output.loaded : [];
        for (const n of loaded) if (typeof n === 'string' && deferredSet.has(n)) out.add(n);
      }
    }
    return out;
  }

  return {
    coreNames,
    deferredNames,
    index,
    forRequest(messages: UIMessage[]): RequestTiering {
      const loadedSet = seedLoaded(messages);
      const meta = dynamicTool({
        description: index,
        inputSchema: jsonSchema({
          type: 'object',
          properties: { names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to load' } },
          required: ['names'],
        }),
        execute: async (input) => {
          const raw = (input as { names?: unknown } | undefined)?.names;
          const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : [];
          const loaded: string[] = [];
          const unknown: string[] = [];
          for (const n of names) {
            if (deferredSet.has(n)) {
              loadedSet.add(n);
              if (!loaded.includes(n)) loaded.push(n);
            } else if (coreSet.has(n)) {
              if (!loaded.includes(n)) loaded.push(n); // already always-on
            } else {
              unknown.push(n);
            }
          }
          return { ok: true, loaded, unknown, warnings: [] };
        },
      });
      const prepareStep: PrepareStepFunction<ToolSet> = () => ({
        // Re-read loadedSet every step: a load in step N activates the tool in step N+1.
        activeTools: [...coreNames, ...loadedSet, LOAD_TOOLS_NAME],
      });
      return {
        tools: { ...modelTools, [LOAD_TOOLS_NAME]: meta },
        prepareStep,
        loaded: () => [...loadedSet],
      };
    },
  };
}
