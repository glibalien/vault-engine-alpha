import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { vaultOf, type Config } from '../config.js';
import { EngineError, type Engine } from '../engine.js';
import { supportsReasoningBudget, type LlmClient } from '../llm/types.js';
import type { UsageReporter } from '../usage-reporter.js';
import { eventsForRunRefs, stampJournaled, unjournaledEvents, type JournalEventRow } from '../db/journal.js';
import { deterministicLede, formatStamp, isJournalNoteTitle, JOURNAL_MARKER, journalNoteTitle, renderBody, renderEntry, SUITE_NOTE_FIELD } from './render.js';
import type { ActionRecorder } from './recorder.js';

export type JournalScope = { kind: 'all-unjournaled' } | { kind: 'run-refs'; runRefs: string[] };

export interface JournalWriterDeps {
  engine: Engine;
  llm: LlmClient;
  config: Config;
  db: Database.Database;
  recorder: ActionRecorder;
  usage?: UsageReporter;
}

const NOTE_PREAMBLE = 'Nightly and on-demand actions recorded by the vault curator. Newest entries at the bottom.\n';

const LEDE_TOOL = {
  name: 'emit_journal_lede',
  description: 'Return the opening paragraph of one Curator journal entry.',
  schema: {
    type: 'object',
    properties: {
      lede: {
        type: 'string',
        description: '2-4 sentences, first person, plain prose. Restate ONLY the given facts — no new claims, no embellished numbers.',
      },
    },
    required: ['lede'],
  },
} as const;

const LEDE_SYSTEM = `You write the opening paragraph of one entry in the Curator's work journal, in the Curator's own voice.
The input is the record of one run: a summary line for each job that ran and a line for each change it made.
Write 2-4 sentences in the first person on what was done and how it went. Restate only what the record says, and mention any errors. No headings, lists, or bold or italic text.`;

/** Output cap for the lede call, including reasoning. 1000 was too small: under the global
 *  `reasoningEffort`, reasoning models spent all of it reasoning, and every lede from
 *  2026-10-27 to 10-31 fell back to the deterministic one (#256). */
export const LEDE_MAX_TOKENS = 4000;

/** Most tokens the lede call may spend reasoning, where the provider takes a budget. The
 *  answer is about 130 tokens; Qwen 3.7 Plus reasoned about 1,800 on its own at any effort
 *  (#355, #431). This leaves 3,000 of `LEDE_MAX_TOKENS` for the answer. */
export const LEDE_REASONING_BUDGET = 1000;

/** The client for the lede call. A 2-4 sentence restatement needs little reasoning.
 *  - OpenRouter: a reasoning budget and no effort, whatever the shared effort. An effort
 *    doesn't bound every model (Qwen 3.7 Plus reasons the same at low and high), and `none`
 *    is rejected by models whose reasoning is mandatory; OpenRouter honors a budget or
 *    converts it to an effort.
 *  - Other OpenAI-compatible providers: `low` where an effort is already sent. It never adds
 *    the parameter where none is sent (a model may reject it).
 *  - Anthropic: left alone. */
export function ledeClient(llm: LlmClient, model: string): LlmClient {
  if (!llm.configurationFor || !llm.withConfiguration) return llm;
  const configuration = llm.configurationFor(model);
  if (configuration.provider === 'anthropic') return llm;
  if (supportsReasoningBudget(configuration.provider)) {
    return llm.withConfiguration({ provider: configuration.provider, reasoningEffort: null,
      reasoningBudget: LEDE_REASONING_BUDGET });
  }
  if (configuration.reasoningEffort === null) return llm;
  return llm.withConfiguration({ provider: configuration.provider, reasoningEffort: 'low' });
}

/** LLM lede when the entry is substantial (≥3 actions or any errors); throws on
 *  provider failure — the caller falls back to the deterministic lede. */
async function llmLede(deps: JournalWriterDeps, bodyText: string): Promise<string> {
  deps.usage?.setContext({ project: 'journal', runRef: randomUUID(), purpose: 'journal' });
  try {
    const model = deps.config.journalModel ?? deps.config.model;
    const { output } = await ledeClient(deps.llm, model).structuredCall({
      model,
      maxTokens: LEDE_MAX_TOKENS,
      system: LEDE_SYSTEM,
      user: bodyText,
      toolName: LEDE_TOOL.name,
      toolDescription: LEDE_TOOL.description,
      schema: LEDE_TOOL.schema as unknown as Record<string, unknown>,
    });
    const lede = (output as { lede?: unknown } | null)?.lede;
    if (typeof lede !== 'string' || lede.trim() === '') throw new Error('lede missing from structured output');
    return lede.trim();
  } finally {
    deps.usage?.setContext(null);
  }
}

/** Resolve the monthly journal note, creating it on first use as a note of the journal kind
 *  (the vault map's `journalType`), marked as the suite's own so no evidence path reads it (#600).
 *  A note found without the marker gets it, best-effort. Runs inside recorder.suspend at the call
 *  site — the journal never logs itself. */
async function resolveJournalNode(engine: Engine, title: string, directory: string, type: string): Promise<string> {
  try {
    const node = await engine.getNodeByTitle(title);
    const id = (node as { id: string }).id;
    if (!Object.prototype.hasOwnProperty.call(node.fields ?? {}, SUITE_NOTE_FIELD)) {
      // Marking never stops the entry being written.
      try {
        await engine.markSuiteNote(id, JOURNAL_MARKER[SUITE_NOTE_FIELD]);
      } catch (err) {
        console.warn(`[journal] could not mark "${title}" as the suite's own: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return id;
  } catch (err) {
    if (!(err instanceof EngineError)) throw err;
  }
  // Engine rejects a type without a schema, and a vault may not have the journal kind yet.
  await engine.ensureNoteSchema(type);
  const created = await engine.createNode({
    title, types: [type], fields: { ...JOURNAL_MARKER }, body: NOTE_PREAMBLE, directory,
  });
  return created.node_id;
}

/** Mark every existing monthly journal note as the suite's own (#600). Run once at Curator start,
 *  best-effort: journal notes written before the marker existed are found by title. Returns how
 *  many were marked. */
export async function markJournalNotes(engine: Pick<Engine, 'listNotesTitled' | 'markSuiteNote'>): Promise<number> {
  let marked = 0;
  for (const note of await engine.listNotesTitled('Curator Journal — ')) {
    if (note.marked || !isJournalNoteTitle(note.title)) continue;
    await engine.markSuiteNote(note.id, JOURNAL_MARKER[SUITE_NOTE_FIELD]);
    marked += 1;
  }
  return marked;
}

/**
 * Write one journal entry covering `scope`, best-effort end to end: any failure
 * warns and returns — events stay unjournaled and roll into the next entry.
 * Events are stamped journaled ONLY after the vault append succeeded.
 * `modelLede: false` always uses the deterministic lede, for writers that make no model calls.
 */
export async function writeJournalEntry(
  deps: JournalWriterDeps, scope: JournalScope, label: string, now: Date = new Date(),
  options: { modelLede?: boolean } = {},
): Promise<void> {
  try {
    if (!deps.config.journalEnabled) return;
    // No journal kind (journalType none in the vault map): the journal is off, as when disabled.
    const journalType = vaultOf(deps.config).journalType;
    if (journalType === null) return;
    const events: JournalEventRow[] = scope.kind === 'all-unjournaled'
      ? unjournaledEvents(deps.db)
      : eventsForRunRefs(deps.db, scope.runRefs);
    if (events.length === 0) return;

    const { body, actionLines, anyErrors } = renderBody(events);
    let lede: string;
    if (options.modelLede !== false && (actionLines.length >= 3 || anyErrors)) {
      try {
        lede = await llmLede(deps, body);
      } catch (err) {
        console.warn(`[curator] journal lede model failed, using deterministic lede: ${err instanceof Error ? err.message : String(err)}`);
        lede = deterministicLede(actionLines, anyErrors);
      }
    } else {
      lede = deterministicLede(actionLines, anyErrors);
    }

    const stamp = formatStamp(now, deps.config.curatorTz);
    const entry = renderEntry(label, stamp, lede, body);
    await deps.recorder.suspend(async () => {
      const nodeId = await resolveJournalNode(deps.engine, journalNoteTitle(stamp.month), deps.config.wikiDir ?? 'Wikis', journalType);
      await deps.engine.appendNodeBody(nodeId, `\n${entry}\n`);
    });
    stampJournaled(deps.db, events.map((e) => e.id), new Date().toISOString());
  } catch (err) {
    console.warn(`[curator] journal entry not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}
