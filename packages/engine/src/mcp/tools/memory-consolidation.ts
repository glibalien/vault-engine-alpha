import { complete, type ProviderClients } from '@vault/llm';
import type { ModelProvider } from '@vault/settings-registry';
import { completionUsageFields, type UsageRecorder, type UsageService } from '../../usage/recorder.js';
import type { ConsolidationPurpose } from '../../memories/types.js';
import { calendarDate, hostTimeZone } from '../../wiki/today.js';

export const DEFAULT_CONSOLIDATION_MODEL = 'accounts/fireworks/models/qwen3p7-plus';
/** Room for a reasoning model to think before its one-line JSON verdict. At 256
 *  tokens, routed reasoning models spent the whole budget and returned no JSON
 *  on about half of prod calls (Oct 2026). Only the tokens used are billed. */
export const CONSOLIDATION_MAX_TOKENS = 4096;

/** A model id may be resolved lazily so next-use settings take effect. */
export type ModelRef = string | (() => string);

export function resolveModel(ref: ModelRef): string {
  return typeof ref === 'function' ? ref() : ref;
}

export interface ConsolidationTarget {
  provider: ModelProvider;
  model: string;
}

export type ConsolidationTargetRef = ConsolidationTarget | (() => ConsolidationTarget);

function resolveTarget(ref: ConsolidationTargetRef): ConsolidationTarget {
  return typeof ref === 'function' ? ref() : ref;
}

/** A memory's source note, as merge decisions see it (#352): its title, its date, and the projects
 *  it is filed under. Two memories from different contexts are usually different facts. */
export interface MemoryNoteContext {
  title: string;
  date: string | null;
  projects: string[];
}

export interface MemoryCandidate {
  id: number;
  content: string;
  category: string | null;
  valid_at: string | null;
  distance: number;
  /** The candidate's source note; null or absent without one (#352). */
  note?: MemoryNoteContext | null;
}

export type ConsolidationOp = 'add' | 'noop' | 'update' | 'contradict';

export interface ConsolidationVerdict {
  operation: ConsolidationOp;
  target_id?: number | undefined;
  valid_at?: string | undefined;
  reason: string;
  /** What the model call cost, as the ledger recorded it; null when unknown (unpriced or not
   *  recorded). Absent when no call was made. */
  costUsd?: number | null | undefined;
}

/** A consolidation call that ran (and was billed) but whose answer was unusable. */
export class ConsolidationError extends Error {
  constructor(message: string, readonly costUsd: number | null) { super(message); }
}

export interface ConsolidationInput {
  content: string;
  category: string | null;
  candidates: MemoryCandidate[];
  /** The new memory's source note; null or absent without one (#352). */
  note?: MemoryNoteContext | null;
}

/** Who the consolidation call is spent for (#298). The Curator passes its own service and run,
 *  so the call counts in its ledger and daily cap; chat passes its conversation. Without it the
 *  spend stays the Engine's. */
export interface ConsolidationAttribution {
  service: UsageService;
  runRef?: string | undefined;
  sourceRef?: string | undefined;
  conversationId?: string | undefined;
  /** Default `memory-consolidation`; a Curator run paid from its own limit sends `memory-consolidation-run` (#659). */
  purpose?: ConsolidationPurpose | undefined;
}

export interface MemoryConsolidator {
  consolidate(input: ConsolidationInput, attribution?: ConsolidationAttribution): Promise<ConsolidationVerdict>;
}

/** e.g. "Today is Friday, 2026-07-10 (Europe/Amsterdam)." Built per call — the
 *  reconcile verdict is bi-temporal, so the model must know "now". Taken in
 *  `timeZone` (the configured `tz`, `wikiTimeZone`, #459), else the host's zone.
 *  Local copy: the engine must not import chat-core (dependency rule). */
export function currentDateLine(now: Date = new Date(), timeZone: string = hostTimeZone()): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  return `Today is ${weekday}, ${calendarDate(now.getTime(), timeZone)} (${timeZone}).`;
}

/** "update" and "contradict" discard the candidate and keep only NEW's text, so both are limited
 *  to the cases where that loses nothing or the candidate is no longer true (#349). */
const SYSTEM_PROMPT = `You reconcile a NEW memory against similar EXISTING memories in an AI assistant's long-term store. "update" and "contradict" discard the candidate and keep only NEW's text, so a wrong choice loses information. Choose exactly ONE operation:
- "add": NEW says something no candidate fully covers, and keeping only NEW would lose something a candidate says: it covers another aspect of the same topic, or adds or narrows detail while leaving out any of the candidate's names, numbers, dates, list items or commitments. Both are kept.
- "noop": already fully covered by a candidate (semantic duplicate); set target_id.
- "update": NEW says everything the candidate says and adds to it or states it more precisely, so discarding the candidate loses nothing; set target_id. A NEW that repeats the candidate and adds a detail is an update. If any name, number, date, list item or commitment in the candidate is missing from NEW, choose "add".
- "contradict": NEW makes a candidate no longer true (the fact changed or was corrected); set target_id to the candidate it supersedes. If both could be true at once, such as a general statement and a specific one, or two descriptions of the same person's role, choose "add".
Each memory names its source note when it has one: the note's title and date, and the projects the note is filed under. Memories from notes filed under different projects, or about different accounts, people or products, usually state different facts even when they read alike: choose "add" unless NEW plainly restates or replaces the same fact about the same subject.
When unsure, choose "add".
Also return valid_at: an ISO-8601 timestamp for when the new fact became true in the real world if the text implies one, else null.
Respond with ONLY a JSON object: {"operation":"...","target_id":<number|null>,"valid_at":"<iso|null>","reason":"<one sentence>"}`;

/** "from note "Weekly sync", 2026-10-05, filed under Acme Pilot", or "no source note" (#352). */
export function noteLabel(note: MemoryNoteContext | null | undefined): string {
  if (!note) return 'no source note';
  const parts = [`from note ${JSON.stringify(note.title)}`];
  if (note.date) parts.push(note.date);
  if (note.projects.length > 0) parts.push(`filed under ${note.projects.join(', ')}`);
  return parts.join(', ');
}

export function buildUserPrompt(input: ConsolidationInput): string {
  const lines = [`NEW${input.category ? ` [${input.category}]` : ''} (${noteLabel(input.note)}): ${input.content}`, '', 'CANDIDATES:'];
  for (const c of input.candidates) {
    lines.push(`- id=${c.id}${c.category ? ` [${c.category}]` : ''} (valid_at=${c.valid_at ?? 'unknown'}; ${noteLabel(c.note)}): ${c.content}`);
  }
  return lines.join('\n');
}

/** Parse and validate the model's JSON verdict. Throws so callers can fail-safe to ADD. */
export function parseConsolidationResponse(text: string, candidateIds: Set<number>): ConsolidationVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object in consolidation response');
  const raw = JSON.parse(match[0]) as {
    operation?: unknown;
    target_id?: unknown;
    valid_at?: unknown;
    reason?: unknown;
  };
  const op = raw.operation;
  if (op !== 'add' && op !== 'noop' && op !== 'update' && op !== 'contradict') {
    throw new Error(`invalid operation: ${String(op)}`);
  }
  const verdict: ConsolidationVerdict = {
    operation: op,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  };
  if (op !== 'add') {
    if (typeof raw.target_id !== 'number' || !candidateIds.has(raw.target_id)) {
      throw new Error(`operation ${op} requires a target_id from the candidate set`);
    }
    verdict.target_id = raw.target_id;
  }
  const validAt = normalizeValidAt(raw.valid_at);
  if (validAt !== undefined) verdict.valid_at = validAt;
  return verdict;
}

/** The model's valid_at as a canonical UTC ISO timestamp, or undefined. `as_of` reads compare
 *  these as strings, so anything else (the literal "null" the prompt's `<iso|null>` invites, a
 *  date in another format, an offset) would break them (#300). A date-only value is midnight UTC. */
export function normalizeValidAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) return undefined;
  const ms = Date.parse(value.trim().replace(' ', 'T'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Memory consolidation over the shared provider clients: whichever provider the
 *  resolved catalog entry names serves the call. `timeZone` gives the zone of the
 *  date line, read per call so a `tz` change applies at once; the host's zone without it. */
export function createConsolidator(
  clients: ProviderClients,
  target: ConsolidationTargetRef,
  recorder?: Pick<UsageRecorder, 'record'>,
  timeZone?: () => string,
): MemoryConsolidator {
  return {
    async consolidate(input, attribution) {
      const t0 = Date.now();
      // Resolve provider + model per call so a live settings change to
      // `memoryConsolidationModel` (a next-use setting) takes effect without
      // reconstructing the consolidator.
      const resolvedTarget = resolveTarget(target);
      const result = await complete(clients, {
        provider: resolvedTarget.provider,
        model: resolvedTarget.model,
        system: `${SYSTEM_PROMPT}\n\n${currentDateLine(new Date(), timeZone?.())}`,
        content: buildUserPrompt(input),
        maxTokens: CONSOLIDATION_MAX_TOKENS,
        json: true,
      });
      const recorded = recorder?.record({
        provider: resolvedTarget.provider,
        model: resolvedTarget.model,
        service: attribution?.service ?? 'engine',
        purpose: attribution?.purpose ?? 'memory-consolidation',
        ...(attribution?.runRef !== undefined ? { runRef: attribution.runRef } : {}),
        ...(attribution?.sourceRef !== undefined ? { sourceRef: attribution.sourceRef } : {}),
        ...(attribution?.conversationId !== undefined ? { conversationId: attribution.conversationId } : {}),
        ...completionUsageFields(result),
        latencyMs: Date.now() - t0,
      });
      const costUsd = recorded && recorded.costBasis !== 'unpriced' ? recorded.costUsd : null;
      try {
        return { ...parseConsolidationResponse(result.text, new Set(input.candidates.map((c) => c.id))), costUsd };
      } catch (e) {
        if (result.truncated) {
          throw new ConsolidationError(`consolidation output truncated at ${CONSOLIDATION_MAX_TOKENS} tokens (model ${resolvedTarget.model})`, costUsd);
        }
        throw new ConsolidationError(e instanceof Error ? e.message : String(e), costUsd);
      }
    },
  };
}
