import type { ToolSet } from 'ai';

/**
 * Memories v3 (§3) conversation provenance, stamped at the host's tool-dispatch
 * seam where the conversation identity lives. Anything the model supplied in
 * `evidence` is OVERWRITTEN, never merged — provenance must not be
 * confabulatable by the model. update-memory only versions on a content
 * change, so it is stamped only when `content` is present and any
 * model-supplied evidence is stripped otherwise (the engine rejects evidence
 * on a no-content update).
 *
 * With a `service`, create-memory is also stamped with spend attribution, so the Engine's
 * dedup model call is recorded against this chat service and conversation rather than the
 * Engine (#298). Model-supplied `usage` is always dropped.
 */
/**
 * The `_meta` key a host sets on every Engine tool call its chat model chose, with the
 * host's name for that chat as the value. A host holds a service token, which the Engine
 * trusts; this is how the Engine can tell the model's calls from the host's own and apply
 * its chat-client rules to them (memory edits are marked with the chat, the reserved memory
 * sources and the memory note are refused). The Engine reads the same key
 * (`CHAT_MODEL_META_KEY` in its `src/auth/client-label.ts`).
 */
export const CHAT_MODEL_META_KEY = 'vault-engine/chat-model';

export interface ConversationEvidence {
  conversationId: string;
  /** Index of this turn's triggering user message in the client-held message array. */
  messageIndex: number;
  /** The chat host, for spend attribution of create-memory's consolidation call. */
  service?: 'chat-plugin' | 'chat-web';
}

const STAMPED_TOOLS = ['create-memory', 'update-memory'] as const;

type Executable = { execute?: (input: unknown, opts: unknown) => Promise<unknown> };

export function stampMemoryEvidence(tools: ToolSet, evidence: ConversationEvidence): ToolSet {
  const ref = `${evidence.conversationId}#${evidence.messageIndex}`;
  const out: ToolSet = { ...tools };
  for (const name of STAMPED_TOOLS) {
    const tool = tools[name] as (ToolSet[string] & Executable) | undefined;
    if (!tool?.execute) continue;
    const execute = tool.execute.bind(tool);
    out[name] = {
      ...tool,
      execute: async (input: unknown, opts: unknown) => {
        const args: Record<string, unknown> = { ...((input ?? {}) as Record<string, unknown>) };
        if (name === 'create-memory' || args.content !== undefined) {
          args.evidence = { kind: 'conversation', ref };
        } else {
          delete args.evidence;
        }
        delete args.usage;
        if (name === 'create-memory' && evidence.service !== undefined) {
          args.usage = { service: evidence.service, conversation_id: evidence.conversationId };
        }
        return execute(args, opts);
      },
    } as ToolSet[string];
  }
  return out;
}
