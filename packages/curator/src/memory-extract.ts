import { parseMemories } from './synthesize.js';
import { currentDateLine } from './date-line.js';
import type { JsonSchema } from './llm/types.js';
import type { MemoryProposal } from './types.js';

/**
 * Extraction primitives shared by the note sweep (memory-sweep.ts) and the
 * conversation sweep (conversation-sweep.ts). The tool schema and the output
 * parsers are identical across both; only the system prompt and the user block
 * differ, so those stay in their respective sweeps.
 */

export const EXTRACT_TOOL: { name: string; description: string; schema: JsonSchema } = {
  name: 'extract_memories',
  description: 'Emit the durable facts extracted from the source (usually none).',
  schema: {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        description: 'Durable, standalone facts. Empty for most sources. Never exceed the per-source cap stated in the user message.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The durable fact — one concise, self-contained sentence.' },
            category: {
              type: 'string', enum: ['fact', 'preference', 'rule', 'note'],
              description: "Optional; default 'fact'. 'rule': a rule on what may or may not be said, shared or claimed. 'preference': a person's likes and habits.",
            },
            subjects: {
              type: 'array', items: { type: 'string' },
              description: 'The people, companies and projects the fact is about, each by its full name as the source gives it; never the owner. Empty when it is only about the owner.',
            },
          },
          required: ['content'],
        },
      },
      unsupported_ids: {
        type: 'array',
        description: 'Ids from the PREVIOUSLY EXTRACTED block that the CURRENT source text no longer supports. Omit or leave empty when none, or when no such block is present.',
        items: { type: 'integer' },
      },
    },
    required: ['facts'],
  },
};

/** Parse the extraction tool output: reuse the v1.5 memory parser (trim, category
 *  normalization, silent drop of malformed entries) and hard-cap at `cap` —
 *  Fireworks constrained decoding cannot express maxItems, so the cap is ours. */
export function parseExtractedFacts(output: unknown, cap: number): MemoryProposal[] {
  if (!output || typeof output !== 'object') return [];
  return parseMemories((output as Record<string, unknown>).facts).slice(0, cap);
}

/** Ids the model reports unsupported, filtered to the offered candidates —
 *  the same validation posture as the consolidator's target_id check. */
export function parseUnsupportedIds(output: unknown, candidateIds: ReadonlySet<number>): number[] {
  if (!output || typeof output !== 'object') return [];
  const raw = (output as Record<string, unknown>).unsupported_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && candidateIds.has(v));
}

/** Append the per-run date line so relative dates in the source ("next Tuesday")
 *  anchor to absolute dates in the extracted facts. Blank prompt falls back to
 *  `fallback` so a cleared settings override cannot ship an empty system prompt.
 *  `timeZone` is `Config.curatorTz` (#459); the host's zone when absent. */
export function withDateLine(prompt: string, fallback: string, now: Date = new Date(), timeZone?: string): string {
  const chosen = prompt.trim() === '' ? fallback : prompt;
  return `${chosen}\n\n${currentDateLine(now, timeZone)}`;
}

/** The vault owner's name from the vault map's `ownerNote` (a title, maybe as a link), or null. */
export function ownerName(ownerNote: string | null | undefined): string | null {
  if (!ownerNote) return null;
  const name = ownerNote.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]!.trim();
  return name === '' ? null : name;
}

/** The request line naming the vault's owner, who is never a subject (#554); empty without one. */
export function ownerLine(owner: string | null): string {
  return owner ? `VAULT OWNER (never a subject): ${owner}\n` : '';
}
