import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ORGANIZING_STEPS } from '../cleanup/guide.js';

export const ORGANIZE_PROMPT_NAME = 'organize-vault';

/**
 * The organizing session as a prompt the user picks (#650): Claude Code lists it as
 * `/mcp__<server name>__organize-vault`, and clients with a prompt menu show its title. A prompt
 * arrives as the user's own message, which a model follows more readily than text in a tool
 * result. The steps are the ones `cleanup-report` returns as `guide`, read from the same list,
 * so the two cannot drift.
 */
export function organizePromptText(): string {
  return [
    'Help me organize my vault. Call cleanup-report first, then work through what it finds with me.',
    'Follow these steps in order. They are the ones the report returns as guide, and "the user" in them is me.',
    '',
    ...ORGANIZING_STEPS.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n');
}

/** The Engine's MCP prompts. Every session gets them, whatever its tool surface. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    ORGANIZE_PROMPT_NAME,
    {
      title: 'Organize my vault',
      description: 'Work through what is still unorganized in the vault, one clean-up at a time. Nothing changes until you agree.',
    },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: organizePromptText() } }] }),
  );
}
