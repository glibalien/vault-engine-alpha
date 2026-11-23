import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { MODEL_PROVIDERS } from '@vault/settings-registry';

/** A new type or field the user asks for, under any name. */
const StarterAnswerSchema = z.object({ starter: z.string().min(1) }).strict();
/** An existing name, `{ starter: name }` for a new one, or null for none. */
const DesignationAnswerSchema = z.union([z.string().min(1), StarterAnswerSchema]).nullable().optional();
/** A field the notes have, or null for none. */
const FieldNameAnswerSchema = z.string().min(1).nullable().optional();
const StatusGroupsAnswerSchema = z.object({
  done: z.array(z.string().min(1)).optional(),
  blocked: z.array(z.string().min(1)).optional(),
  backlog: z.array(z.string().min(1)).optional(),
  ignored: z.array(z.string().min(1)).optional(),
}).strict();

/** A key is named by the environment variable that holds it, never written out. */
const SecretReferenceSchema = z.string()
  .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, 'must be an env:NAME reference; keys are never written into the answers file')
  .nullable()
  .optional();

/**
 * Headless answers. Every interactive question has an id that names one field here,
 * so `--answers` drives exactly the same flow as the TUI. Secrets are never accepted
 * as literals, only as `env:NAME` references.
 */
export const AnswersSchema = z.object({
  version: z.literal(1),
  vault: z.object({
    path: z.string().min(1),
    /**
     * Create `path`, which must not exist yet: `empty`, or `messy` with the messy sample
     * (`examples/messy-vault`: made-up notes from three apps, to try the sorting on).
     */
    sample: z.enum(['empty', 'messy']).optional(),
    exclude: z.array(z.string()).optional(),
    settings_dir: z.string().min(1).optional(),
    wiki_dir: z.string().min(1).optional(),
    topic_dir: z.string().min(1).optional(),
  }).strict(),
  structure: z.object({
    source: z.enum(['field', 'folders', 'both', 'none']).optional(),
    type_field: z.string().min(1).optional(),
    folder_rules: z.array(z.object({
      directory: z.string().min(1),
      type: z.string().min(1).nullable(),
    }).strict()).optional(),
    /** Tags that name a kind (#650): a note the type line leaves untyped gets the kind of each it carries. Left out: the tags naming usual kinds. */
    tag_rules: z.array(z.object({
      tag: z.string().min(1),
      type: z.string().min(1).nullable(),
    }).strict()).optional(),
    /** Proposed type name -> new name, or null to leave those notes untyped. */
    type_renames: z.record(z.string(), z.string().min(1).nullable()).optional(),
    /**
     * Kind -> a proposed type, `{ starter: name }` for a new type (the kind's own name also
     * asks for one), or null for none.
     */
    roles: z.object({
      project: DesignationAnswerSchema,
      task: DesignationAnswerSchema,
      meeting: DesignationAnswerSchema,
      person: DesignationAnswerSchema,
      company: DesignationAnswerSchema,
    }).strict().optional(),
    /** Status kind -> a text field the notes have, `{ starter: name }` for a new one, or null for none. */
    status_fields: z.object({
      project: DesignationAnswerSchema,
      task: DesignationAnswerSchema,
    }).strict().optional(),
    /** Project status values that mean active. */
    active_statuses: z.array(z.string().min(1)).optional(),
    /** Other project status values by group; a group left out uses the values detected by name. */
    status_groups: StatusGroupsAnswerSchema.optional(),
    /** Task status values that mean open. */
    task_active_statuses: z.array(z.string().min(1)).optional(),
    /** Other task status values by group, as for projects. */
    task_status_groups: StatusGroupsAnswerSchema.optional(),
    /** The map's other fields -> a field the notes have (or a new type adds), or null for none. */
    fields: z.object({
      due: FieldNameAnswerSchema,
      date: FieldNameAnswerSchema,
      people: FieldNameAnswerSchema,
      company: FieldNameAnswerSchema,
      priority: FieldNameAnswerSchema,
      scheduled: FieldNameAnswerSchema,
    }).strict().optional(),
    /** A field that needs review -> how to store it; a field left out stays unmanaged. */
    review_fields: z.record(z.string(), z.enum(['unmanaged', 'text', 'dominant'])).optional(),
    /** Remove the old type field from notes once adoption gives them types. */
    remove_type_field: z.boolean().optional(),
  }).strict().optional(),
  providers: z.object({
    anthropic: SecretReferenceSchema,
    fireworks: SecretReferenceSchema,
    openrouter: SecretReferenceSchema,
    openai: SecretReferenceSchema,
    gemini: SecretReferenceSchema,
    deepgram: SecretReferenceSchema,
    exa: SecretReferenceSchema,
  }).strict().optional(),
  models: z.object({
    preset: z.enum(['balanced', 'low-cost', 'custom']).optional(),
    vision_provider: z.enum(['gemini', 'claude', 'model', 'off']).optional(),
    custom_models: z.array(z.object({
      title: z.string().min(1),
      provider: z.enum(MODEL_PROVIDERS),
      model: z.string().min(1),
    }).strict()).optional(),
    /** `domain.key` of a role the custom preset asks about -> a model title, or null to inherit. */
    roles: z.record(z.string(), z.string().min(1).nullable()).optional(),
  }).strict().optional(),
  curator: z.object({
    install: z.boolean().optional(),
    daily_budget_cents: z.number().int().min(1).optional(),
    sweep_at: z.string().optional(),
    tz: z.string().optional(),
    wiki_mode: z.enum(['off', 'dry-run', 'live']).optional(),
    /** The kind Curator's journal writes: a type the notes have, or a new one Curator creates. */
    journal_type: z.string().min(1).optional(),
  }).strict().optional(),
  extraction: z.object({
    /** Turn on paid attachment extraction after adoption; off unless approved. */
    approve: z.boolean().optional(),
  }).strict().optional(),
  obsidian: z.object({
    /** In an Obsidian vault, add the Vault Engine plugin, connected, at the end; off unless asked. */
    install_plugin: z.boolean().optional(),
  }).strict().optional(),
  backup: z.object({
    /** `skip` here is the explicit confirmation an interactive user has to type. */
    mode: z.enum(['markdown', 'full', 'skip']).optional(),
  }).strict().optional(),
}).strict();

export type Answers = z.infer<typeof AnswersSchema>;
export type StructureAnswers = NonNullable<Answers['structure']>;
export type CustomModelAnswer = NonNullable<NonNullable<Answers['models']>['custom_models']>[number];

export type AnswerId =
  | 'vault.path'
  | 'vault.sample'
  | 'vault.exclude'
  | 'vault.settings_dir'
  | 'vault.wiki_dir'
  | 'vault.topic_dir'
  | 'structure.source'
  | 'structure.type_field'
  | 'structure.folder_rules'
  | 'structure.tag_rules'
  | 'structure.type_renames'
  | 'structure.roles'
  | 'structure.status_fields'
  | 'structure.active_statuses'
  | 'structure.status_groups'
  | 'structure.task_active_statuses'
  | 'structure.task_status_groups'
  | 'structure.fields'
  | 'structure.review_fields'
  | 'structure.remove_type_field'
  /**
   * The interactive question of which keys to add (the tick-list, or quick setup's one-key
   * question); an answers file states it by which `providers.*` entries it has.
   */
  | 'providers'
  | 'providers.anthropic'
  | 'providers.fireworks'
  | 'providers.openrouter'
  | 'providers.openai'
  | 'providers.gemini'
  | 'providers.deepgram'
  | 'providers.exa'
  | 'models.preset'
  | 'models.vision_provider'
  | 'models.custom_models'
  | 'models.roles'
  | 'curator.install'
  | 'curator.daily_budget_cents'
  | 'curator.sweep_at'
  | 'curator.tz'
  | 'curator.wiki_mode'
  | 'curator.journal_type'
  | 'extraction.approve'
  | 'obsidian.install_plugin'
  | 'backup.mode';

export class AnswersError extends Error {
  override readonly name = 'AnswersError';
}

export async function loadAnswers(path: string): Promise<Answers> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new AnswersError(`could not read answers file ${path}: ${errorMessage(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AnswersError(`answers file ${path} is not valid JSON`);
  }
  const parsed = AnswersSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'answers';
    throw new AnswersError(`invalid answers file ${path}: ${where}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/** The answer for one question id, or undefined when the file leaves it out. */
export function answerFor(answers: Answers, id: AnswerId): unknown {
  const [section, key] = id.split('.') as [keyof Answers, string];
  const group = answers[section];
  if (typeof group !== 'object' || group === null) return undefined;
  return (group as Record<string, unknown>)[key];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
