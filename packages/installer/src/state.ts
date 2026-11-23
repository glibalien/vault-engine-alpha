import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ObsidianPluginOutcome } from './obsidian.js';
import type { CheckResult } from './preflight.js';
import type { PlanReport } from './report.js';
import type { FieldDefinition } from './starter-types.js';

/**
 * `installer/state.json`: the approved plan and each stage's progress. It holds no
 * secrets; those live only in the 0600 env files. A rerun continues from it.
 */
export interface InstallState {
  format: 'vault-installer-state';
  version: 1;
  approved_at: string;
  plan: PlanReport;
  stages: {
    /**
     * Each file configure writes, with its SHA-256, recorded before the first is written
     * so a rerun can tell its own files from anyone else's. Null until all are written.
     */
    configure?: { completed_at: string | null; files: Record<string, string> };
    backup?: {
      started_at: string;
      /** Null when the backup was skipped. */
      directory: string | null;
      completed_at: string | null;
      files: number;
      bytes: number;
    };
    engine?: { started_at: string; completed_at: string | null };
    adopt?: {
      started_at: string;
      completed_at: string | null;
      /**
       * Every Engine undo operation adoption made, for `undo-operations` within 24 hours.
       * Emptied once `vault-installer undo` has run.
       */
      operations: string[];
      /** What adoption applies, decided before its first write to Engine. */
      targets?: AdoptTargets;
      /** When `vault-installer undo` last undid the operations. */
      undone_at?: string;
    };
    settings?: {
      started_at: string;
      completed_at: string | null;
      /** The answer about paid attachment extraction, saved before it is acted on. */
      extraction: 'approved' | 'declined' | 'not_needed' | null;
      /** Engine was restarted to turn attachment extraction on. */
      engine_restarted: boolean;
      /** When the restart was asked for; a later Engine start completes it. */
      restart_requested_at?: string;
    };
    /** Complete at once when the plan installs no Curator. */
    curator?: { started_at: string; completed_at: string | null };
    /** The last verification; complete only when no check failed. */
    verify?: { checked_at: string; completed_at: string | null; checks: CheckResult[] };
    /** The public-access guide, the Obsidian plugin, and revoking the installer's tokens. */
    handoff?: {
      started_at: string;
      completed_at: string | null;
      /**
       * The Obsidian plugin, when the vault is an Obsidian vault: saved as `installing`
       * before its folder is written. Its tokens are only in the plugin's `data.json`.
       */
      obsidian_plugin?: ObsidianPluginOutcome;
    };
  };
}

/**
 * The approved vault fields as the Analyzer defined them, and each checked note's final
 * types by path. A rerun applies these rather than reading notes adoption already changed.
 */
export interface AdoptTargets {
  fields: FieldDefinition[];
  /** Null when no note gets a vault type: no vault typing, or every type dropped. */
  types: Record<string, string[]> | null;
}

export class StateError extends Error {
  override readonly name = 'StateError';
}

const FieldDefinitionSchema = z.object({
  name: z.string(),
  field_type: z.string(),
  list_item_type: z.string().optional(),
  enum_values: z.array(z.string()).optional(),
  reference_target: z.string().optional(),
});

/** Only the parts of the stored plan that later stages read are checked. */
const StoredPlanSchema = z.object({
  format: z.literal('vault-installer-plan'),
  version: z.literal(1),
  repo_root: z.string(),
  data_dir: z.string(),
  services: z.object({
    user: z.string(),
    node_path: z.string(),
    engine_port: z.number().int(),
    curator_port: z.number().int(),
    // Plans saved before macOS support ran the services under systemd.
    service_manager: z.enum(['systemd', 'launchd']).optional(),
    service_dir: z.string().optional(),
  }),
  vault: z.object({
    path: z.string(),
    settings_dir: z.string(),
    // Plans from before these were asked use the defaults.
    wiki_dir: z.string().default('Wikis'),
    topic_dir: z.string().default('Topics'),
    exclusions: z.array(z.string()),
    analyzer_exclusions: z.array(z.string()),
    inventory: z.object({ non_markdown_by_extension: z.record(z.string(), z.number()) }).passthrough(),
  }).passthrough(),
  structure: z.object({
    analyzer_spec: z.object({
      type_field: z.string().nullable(),
      // Plans saved before the type key was designated kept types in `types`.
      type_key: z.string().optional(),
      folder_rules: z.array(z.object({ directory: z.string(), type: z.string().nullable() })),
      type_renames: z.record(z.string(), z.string().nullable()),
      exclude: z.array(z.string()),
      field_types: z.record(z.string(), z.object({ field_type: z.string(), list_item_type: z.string().optional() })).optional(),
    }),
    source_fingerprint: z.string().nullable(),
    types: z.array(z.object({
      name: z.string(),
      from: z.enum(['vault', 'starter']),
      default_directory: z.string().nullable(),
      fields: z.array(z.string()),
    }).passthrough()),
    fields_from_vault: z.array(z.string()),
    starter_fields: z.array(FieldDefinitionSchema),
    // Plans saved before the choice existed keep the old type field.
    remove_type_field: z.boolean().default(false),
  }).passthrough().nullable(),
  models: z.object({
    vision_provider: z.enum(['gemini', 'claude', 'model', 'off']),
    roles: z.array(z.object({ setting: z.string(), model: z.string().nullable() }).passthrough()),
    models: z.array(z.object({
      title: z.string(),
      provider: z.string(),
      model: z.string(),
      input: z.number(),
      output: z.number(),
      add_to_catalog: z.boolean(),
    })),
  }).passthrough(),
  curator: z.object({
    daily_budget_cents: z.number().nullable(),
    sweep_at: z.string(),
    tz: z.string(),
    wiki_mode: z.enum(['off', 'dry-run', 'live']),
  }).passthrough().nullable(),
  // Plans from before the answer was recorded ask after adoption, or stay off headless.
  extraction_approved: z.boolean().nullable().default(null),
  // Plans from before the plugin was offered ask at the end, or leave it out headless.
  obsidian_plugin: z.boolean().nullable().default(null),
  backup: z.object({ mode: z.enum(['markdown', 'full', 'skip']), files: z.number(), bytes: z.number() }),
  review: z.object({
    engine_database: z.string(),
    engine_models_dir: z.string().nullable(),
    env_keys: z.object({
      engine_first_boot: z.array(z.string()),
      engine_after_extraction_off: z.array(z.string()),
      curator: z.array(z.string()),
    }),
    extraction_seeded_off: z.boolean(),
    settings: z.array(z.object({
      setting: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
      when: z.string().optional(),
      inherits: z.literal(true).optional(),
    })),
  }).passthrough(),
}).passthrough();

const StateSchema = z.object({
  format: z.literal('vault-installer-state'),
  version: z.literal(1),
  approved_at: z.string(),
  plan: StoredPlanSchema,
  stages: z.object({
    configure: z.object({ completed_at: z.string().nullable(), files: z.record(z.string(), z.string()) }).optional(),
    backup: z.object({
      started_at: z.string(),
      directory: z.string().nullable(),
      completed_at: z.string().nullable(),
      files: z.number(),
      bytes: z.number(),
    }).optional(),
    engine: z.object({ started_at: z.string(), completed_at: z.string().nullable() }).optional(),
    adopt: z.object({
      started_at: z.string(),
      completed_at: z.string().nullable(),
      operations: z.array(z.string()),
      targets: z.object({
        fields: z.array(FieldDefinitionSchema),
        types: z.record(z.string(), z.array(z.string())).nullable(),
      }).optional(),
      undone_at: z.string().optional(),
    }).optional(),
    settings: z.object({
      started_at: z.string(),
      completed_at: z.string().nullable(),
      extraction: z.enum(['approved', 'declined', 'not_needed']).nullable(),
      engine_restarted: z.boolean(),
      restart_requested_at: z.string().optional(),
    }).optional(),
    curator: z.object({ started_at: z.string(), completed_at: z.string().nullable() }).optional(),
    verify: z.object({
      checked_at: z.string(),
      completed_at: z.string().nullable(),
      checks: z.array(z.object({ id: z.string(), status: z.enum(['pass', 'warn', 'fail']), title: z.string(), detail: z.string() })),
    }).optional(),
    handoff: z.object({
      started_at: z.string(),
      completed_at: z.string().nullable(),
      obsidian_plugin: z.enum(['installing', 'installed', 'declined', 'kept', 'not_built']).optional(),
    }).optional(),
  }),
});

export function statePath(dataDir: string): string {
  return join(dataDir, 'installer', 'state.json');
}

/** The saved state, or null when no install has been approved in this data directory. */
export async function loadState(path: string): Promise<InstallState | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StateError(`could not read ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StateError(`${path} is not valid JSON`);
  }
  const parsed = StateSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StateError(`${path} is not a state file this installer version can continue: ${issue?.path.join('.') || 'state'}: ${issue?.message}`);
  }
  return parsed.data as unknown as InstallState;
}

/** Replace the state file in one step, so a crash never leaves half of it. */
export async function saveState(path: string, state: InstallState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
